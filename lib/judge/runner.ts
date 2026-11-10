import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as config from '../../config';
import { queryOne, execute } from '../database';
import logger from '../logger';
import { compareOutput } from './compare';

const TIME_LIMIT_MS = 2000;
const TOTAL_TIME_LIMIT_MS = 10000;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const ERROR_LIMIT_BYTES = 2 * 1024;
const MAX_CASE_RESULTS = 500;

type CaseStatus = 'AC' | 'WA' | 'RE' | 'TLE' | 'OLE' | 'Data Error';

interface CaseResult {
    name: string;
    status: CaseStatus;
    timeMs: number;
}

interface ExecutionResult {
    status: 'OK' | 'RE' | 'TLE' | 'OLE' | 'System Error';
    output: string;
    error: string;
    timeMs: number;
}

function quoteShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

let pythonRuntime: { command: string; args: string[] } | null = null;

/** 探测可用的 Python 解释器及其版本：Python 2 不支持 -I/-S，需要降级参数 */
function detectPythonRuntime(): { command: string; args: string[] } {
    if (pythonRuntime) return pythonRuntime;

    const isWin = process.platform === 'win32';
    const candidates = isWin ? ['python3', 'python', 'py'] : ['python3', 'python'];

    for (const cmd of candidates) {
        try {
            const probe = spawnSync(cmd, ['-c', 'import sys; sys.stdout.write(str(sys.version_info[0]))'], {
                encoding: 'utf-8',
                timeout: 5000,
                windowsHide: true,
            });
            if (probe.status !== 0) continue;

            const major = Number((probe.stdout || '').trim());
            if (major === 3) {
                pythonRuntime = { command: cmd, args: ['-I', '-S'] };
                return pythonRuntime;
            }
            if (major === 2) {
                pythonRuntime = { command: cmd, args: [] };
                return pythonRuntime;
            }
        } catch {
            /* 尝试下一个候选解释器 */
        }
    }

    // 全部探测失败时保留原行为（执行时会返回 System Error）
    pythonRuntime = { command: isWin ? 'python' : 'python3', args: [] };
    return pythonRuntime;
}

function resolveRuntime(language: string): { command: string; args: string[] } {
    if (language === 'python') {
        return detectPythonRuntime();
    }
    // 直接用当前 Bun 可执行文件，避免 PATH 中找不到 bun
    return { command: process.execPath, args: ['--smol'] };
}

function killTree(child: ChildProcess): void {
    if (!child.pid) return;
    try {
        if (process.platform !== 'win32') {
            process.kill(-child.pid, 'SIGKILL');
        } else {
            child.kill('SIGKILL');
        }
    } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
}

/** 执行单个测试点：流式喂入 stdin，限制输出与时限，清理整个进程组 */
function executeCase(language: string, codePath: string, inputPath: string): Promise<ExecutionResult> {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const { command, args } = resolveRuntime(language);

        let child: ChildProcess;
        try {
            if (process.platform === 'win32') {
                child = spawn(command, [...args, codePath], { stdio: ['pipe', 'pipe', 'pipe'] });
            } else {
                // ulimit：虚拟内存 256 MB、CPU 5 s、单文件 8 MB；detached 建立独立进程组便于整组回收
                const script = `ulimit -v 262144 -t 5 -f 8192 2>/dev/null; exec ${command} ${args.map(quoteShell).join(' ')} ${quoteShell(codePath)}`;
                child = spawn('sh', ['-c', script], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
            }
        } catch (err) {
            resolve({ status: 'System Error', output: '', error: (err as Error).message, timeMs: 0 });
            return;
        }

        let output = '';
        let error = '';
        let settled = false;
        let timedOut = false;
        let overLimit = false;

        const finish = (status: ExecutionResult['status']): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            killTree(child);
            resolve({
                status,
                output: output.slice(0, OUTPUT_LIMIT_BYTES),
                error: error.slice(0, ERROR_LIMIT_BYTES),
                timeMs: Date.now() - startedAt,
            });
        };

        const timer = setTimeout(() => {
            timedOut = true;
            finish('TLE');
        }, TIME_LIMIT_MS);

        child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            if (output.length > OUTPUT_LIMIT_BYTES && !overLimit) {
                overLimit = true;
                finish('OLE');
            }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
            if (error.length < ERROR_LIMIT_BYTES) error += chunk.toString();
        });

        child.on('error', (err: Error) => {
            error = err.message;
            finish('System Error');
        });

        child.on('close', (code: number | null, signal: string | null) => {
            if (settled) return;
            if (code === 0) finish('OK');
            else if (timedOut) finish('TLE');
            else if (overLimit) finish('OLE');
            else {
                error = error || `Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`;
                finish('RE');
            }
        });

        const inputStream = fs.createReadStream(inputPath);
        inputStream.on('error', (err: Error) => {
            error = `Failed to read input: ${err.message}`;
            finish('System Error');
        });
        inputStream.pipe(child.stdin!);
        child.stdin?.on('error', () => { /* 进程提前退出时忽略 EPIPE */ });
    });
}

function mapCaseStatus(result: ExecutionResult): CaseStatus {
    switch (result.status) {
        case 'OK': return 'AC';
        case 'TLE': return 'TLE';
        case 'OLE': return 'OLE';
        case 'RE': return 'RE';
        default: return 'RE';
    }
}

export async function runJudge(submissionId: number, pluginManager?: any): Promise<void> {
    const sub = queryOne<any>("SELECT * FROM submissions WHERE id = ?", [submissionId]);
    if (!sub) return;

    try {
        sub.caseResults = [];
        pluginManager?.emit?.('beforeJudge', sub);

        const probPath = path.join(config.PROB_DIR, String(sub.problemId));
        if (!fs.existsSync(probPath)) {
            execute("UPDATE submissions SET status = ?, errorInfo = ? WHERE id = ?", ['Data Error', '题目测试数据目录不存在', sub.id]);
            return;
        }

        const files = fs.readdirSync(probPath);
        const inputs = files.filter((f: string) => f.endsWith('.in')).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }));

        if (inputs.length === 0) {
            execute("UPDATE submissions SET status = ?, errorInfo = ? WHERE id = ?", ['Data Error', '测试点为空', sub.id]);
            return;
        }

        const missingOutput = inputs.find((f: string) => !fs.existsSync(path.join(probPath, f.replace(/\.in$/, '.out'))));
        if (missingOutput) {
            execute("UPDATE submissions SET status = ?, errorInfo = ? WHERE id = ?",
                ['Data Error', `测试点 ${missingOutput} 缺少对应 .out`, sub.id]);
            return;
        }

        execute("UPDATE submissions SET status = 'Running' WHERE id = ?", [sub.id]);

        const workDir = path.join(config.DATA_DIR, 'judge_tmp', crypto.randomUUID());
        fs.mkdirSync(workDir, { recursive: true });
        const ext = sub.language === 'python' ? 'py' : 'js';
        const codePath = path.join(workDir, `solution.${ext}`);
        fs.writeFileSync(codePath, sub.code || '');

        const caseResults: CaseResult[] = [];
        let hasWa = false;
        let hasRuntimeIssue = false;
        let firstError: string | undefined;
        const overallStart = Date.now();

        try {
            for (const inputFile of inputs) {
                const name = inputFile.replace(/\.in$/, '');

                if (Date.now() - overallStart > TOTAL_TIME_LIMIT_MS) {
                    caseResults.push({ name, status: 'TLE', timeMs: 0 });
                    hasRuntimeIssue = true;
                    continue;
                }

                const inputPath = path.join(probPath, inputFile);
                const outputPath = path.join(probPath, `${name}.out`);
                const expected = fs.readFileSync(outputPath, 'utf-8');

                const result = await executeCase(sub.language, codePath, inputPath);
                const status = mapCaseStatus(result);

                if (status === 'AC' && !compareOutput(result.output, expected)) {
                    caseResults.push({ name, status: 'WA', timeMs: result.timeMs });
                    hasWa = true;
                    continue;
                }

                caseResults.push({ name, status, timeMs: result.timeMs });

                if (status !== 'AC') {
                    hasRuntimeIssue = true;
                    if (!firstError) {
                        if (result.status === 'TLE') firstError = `${name}: Time Limit Exceeded`;
                        else if (result.status === 'OLE') firstError = `${name}: Output Limit Exceeded`;
                        else firstError = `${name}: ${result.error || 'Runtime Error'}`;
                    }
                }
            }
        } finally {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }

        let finalStatus: string;
        if (hasRuntimeIssue) finalStatus = 'Runtime Error';
        else if (hasWa) finalStatus = 'Wrong Answer';
        else finalStatus = 'Accepted';

        if (caseResults.length > MAX_CASE_RESULTS) caseResults.length = MAX_CASE_RESULTS;

        sub.status = finalStatus;
        sub.caseResults = caseResults;
        sub.errorInfo = firstError;
        pluginManager?.emit?.('afterJudge', sub);

        execute("UPDATE submissions SET status = ?, errorInfo = ?, caseResults = ? WHERE id = ?",
            [finalStatus, firstError || null, JSON.stringify(caseResults), sub.id]);
    } catch (err) {
        logger.error(`Error in runJudge for submission ${submissionId}`, err as Error);
        try {
            execute("UPDATE submissions SET status = ?, errorInfo = ? WHERE id = ?",
                ['System Error', (err as Error).message, submissionId]);
        } catch { /* ignore */ }
    }
}
