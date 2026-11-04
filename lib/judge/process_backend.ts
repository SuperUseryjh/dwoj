import { spawn, spawnSync, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import * as config from '../../config';
import { createLogger } from '../logger';
import { ExecuteOutcome, ExecuteRequest, ExecutionBackend, JudgeError, JudgeErrorKind } from './backend';

const logger = createLogger('judge');

/**
 * 直接在服务器上运行用户代码（无隔离）。
 * 只适合本地开发/内网，生产环境应使用 v86 后端。
 *
 * 支持 python / node / cpp。cpp 会先用 g++（回退 gcc + -lstdc++）编译，
 * 编译产物在每次执行结束时随临时目录一起删除。
 */

// ============================================================
// 解释器 / 编译器探测
// ============================================================

/** 探测结果缓存（cmd + args -> 是否可用） */
const probeCache = new Map<string, boolean>();

function worksOnce(cmd: string, args: string[]): boolean {
    const key = `${cmd}\u0000${args.join(' ')}\u0000`;
    const cached = probeCache.get(key);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
        ok = spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000 }).status === 0;
    } catch (_) {
        ok = false;
    }
    probeCache.set(key, ok);
    return ok;
}

function firstWorking(candidates: string[], args: string[]): string | null {
    for (const cmd of candidates) {
        if (worksOnce(cmd, args)) return cmd;
    }
    return null;
}

let cachedPython: string | null | undefined;
let pythonIsolationFlag: string[] | null = null;

/**
 * 找到可用的 Python 3。
 * 注意：Windows 上 `python` 可能指向 Python 2（2.x 不支持 -I），
 * 因此必须优先 python3 且校验主版本号。
 */
export function resolvePython(): string {
    if (cachedPython === undefined) {
        cachedPython = firstWorking(
            ['python3', 'python'],
            ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'],
        );
    }
    if (!cachedPython) throw new JudgeError('SE', '评测机未找到 Python 3 解释器（python3 / python）');
    return cachedPython;
}

let cachedJsRuntime: string | null | undefined;

function resolveJsRuntime(): string {
    if (cachedJsRuntime === undefined) {
        cachedJsRuntime = firstWorking(['bun', 'node'], ['--version']);
    }
    if (!cachedJsRuntime) throw new JudgeError('SE', '评测机未找到 JavaScript 运行时（bun / node）');
    return cachedJsRuntime;
}

interface Compiler {
    cmd: string;
    /** 编译参数（%SRC% / %OUT% 会被替换） */
    args: string[];
    /** 目标文件名 */
    output: string;
}

let cachedCompiler: Compiler | null | undefined;

/** 找到可用的 C++ 编译器，优先 g++，其次 gcc + libstdc++ */
export function resolveCppCompiler(): Compiler {
    if (cachedCompiler === undefined) {
        cachedCompiler = null;
        const common = ['-O2', '-std=c++17', '-pipe', '-w'];
        if (firstWorking(['g++', 'g++.exe', 'clang++'], ['--version'])) {
            const cmd = firstWorking(['g++', 'g++.exe', 'clang++'], ['--version'])!;
            cachedCompiler = { cmd, args: [...common, '%SRC%', '-o', '%OUT%'], output: 'main' };
        } else if (firstWorking(['gcc', 'gcc.exe'], ['--version'])) {
            const cmd = firstWorking(['gcc', 'gcc.exe'], ['--version'])!;
            cachedCompiler = { cmd, args: [...common, '%SRC%', '-o', '%OUT%', '-lstdc++', '-lm'], output: 'main' };
        }
    }
    if (!cachedCompiler) throw new JudgeError('SE', '评测机未找到 C++ 编译器（g++ / gcc）');
    return cachedCompiler;
}

// ============================================================
// 子进程执行
// ============================================================

interface ProcResult {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    overflow: boolean;
}

interface ProcOptions {
    cwd: string;
    input?: string;
    timeLimitMs: number;
    maxOutputBytes: number;
    env?: Record<string, string>;
}

function spawnCapture(cmd: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
    return new Promise((resolve, reject) => {
        const isWindows = process.platform === 'win32';
        let child: ChildProcess;
        try {
            child = spawn(cmd, args, {
                cwd: opts.cwd,
                env: {
                    PATH: process.env.PATH || '',
                    HOME: opts.cwd,
                    TMPDIR: opts.cwd,
                    TEMP: opts.cwd,
                    LANG: 'C.UTF-8',
                    LC_ALL: 'C.UTF-8',
                    ...opts.env,
                },
                stdio: ['pipe', 'pipe', 'pipe'],
                // POSIX 下用独立进程组，超时时可以整组杀掉
                detached: !isWindows,
                windowsHide: true,
            });
        } catch (err) {
            reject(new JudgeError('SE', `无法启动进程 (${cmd}): ${(err as Error).message}`));
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let overflow = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (code: number | null, signal: NodeJS.Signals | null, forced: boolean): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (forced) killProcessTree(child);
            resolve({ stdout, stderr, code, signal, timedOut, overflow });
        };

        timer = setTimeout(() => {
            timedOut = true;
            finish(null, null, true);
        }, opts.timeLimitMs);

        child.stdout?.on('data', (chunk: Buffer) => {
            if (settled) return;
            stdout += chunk.toString('utf-8');
            if (Buffer.byteLength(stdout, 'utf-8') > opts.maxOutputBytes) {
                overflow = true;
                finish(null, null, true);
            }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < config.MAX_STDERR_BYTES) stderr += chunk.toString('utf-8');
        });

        // 用户程序不读 stdin 就直接退出时会触发 EPIPE，
        // 不吞掉这个事件会把整个 OJ 进程打崩。
        child.stdin?.on('error', () => { /* ignore EPIPE */ });
        try {
            if (opts.input !== undefined) {
                child.stdin?.write(opts.input.endsWith('\n') ? opts.input : opts.input + '\n');
            }
            child.stdin?.end();
        } catch (_) { /* 进程已退出，交由 close / error 处理 */ }

        child.on('error', (err: Error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            reject(new JudgeError('SE', `无法启动进程 (${cmd}): ${err.message}`));
        });

        child.on('close', (code, signal) => {
            finish(code, signal, false);
        });
    });
}

async function removeDirWithRetry(dir: string, attempts = 6): Promise<void> {
    for (let i = 0; i < attempts; i++) {
        try {
            fs.removeSync(dir);
            return;
        } catch (err) {
            if (i === attempts - 1) {
                logger.warn(`Failed to remove temp dir ${path.basename(dir)}: ${(err as Error).message}`);
                return;
            }
            await new Promise<void>(resolve => setTimeout(resolve, 100 * (i + 1)));
        }
    }
}

/** 杀掉子进程及其所有子进程（Windows 用 taskkill /T） */
function killProcessTree(child: ChildProcess): void {
    const pid = child?.pid;
    if (pid === undefined) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
        } else {
            // detached => 子进程是进程组组长，负数 pid 可以杀掉整组
            process.kill(-pid, 'SIGKILL');
        }
    } catch (_) {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
}

// ============================================================
// 后端实现
// ============================================================

export class ProcessBackend implements ExecutionBackend {
    readonly name = 'process';
    readonly languages = config.LANGUAGES;

    async init(): Promise<void> {
        fs.ensureDirSync(config.JUDGE_DIR);
    }

    async dispose(): Promise<void> {
        /* 无长驻资源 */
    }

    async execute(req: ExecuteRequest): Promise<ExecuteOutcome> {
        const startedAt = Date.now();
        try {
            const stdout = await executeProgram(
                req.language,
                req.code,
                req.input,
                req.timeLimitMs,
                req.maxOutputBytes,
            );
            return { status: 'OK', stdout, timeMs: Date.now() - startedAt };
        } catch (err) {
            const je = toJudgeError(err);
            return { status: je.kind, message: je.message, timeMs: Date.now() - startedAt };
        }
    }
}

/**
 * 在独立临时目录中执行一次用户程序，返回 stdout。
 * 失败时抛出 JudgeError，区分 TLE / RE / OLE / CE / SE。
 */
export async function executeProgram(
    lang: string,
    code: string,
    input: string,
    timeLimitMs: number,
    maxOutputBytes: number = config.MAX_OUTPUT_BYTES,
): Promise<string> {
    const isWindows = process.platform === 'win32';

    // 每种语言的源码文件名与执行命令
    let sourceName: string;
    let build: (() => Promise<string>) | null = null;

    const ext: Record<string, string> = { python: 'py', node: 'js', cpp: 'cpp' };
    if (!ext[lang]) throw new JudgeError('CE', `不支持的语言：${lang}`);
    sourceName = `main.${ext[lang]}`;

    const workDir = path.join(config.JUDGE_DIR, crypto.randomUUID());
    fs.ensureDirSync(workDir);
    fs.writeFileSync(path.join(workDir, sourceName), code, 'utf-8');

    try {
        let cmd: string;
        let args: string[];
        let runInput: string = input;

        if (lang === 'cpp') {
            const compiler = resolveCppCompiler();
            const target = isWindows ? `${compiler.output}.exe` : compiler.output;
            const compileArgs = compiler.args.map(a =>
                a === '%SRC%' ? sourceName : a === '%OUT%' ? target : a);

            const compiled = await spawnCapture(compiler.cmd, compileArgs, {
                cwd: workDir,
                timeLimitMs: config.COMPILE_TIMEOUT_MS,
                maxOutputBytes: config.MAX_OUTPUT_BYTES,
            });
            if (compiled.timedOut) {
                throw new JudgeError('CE', `编译超时（超过 ${config.COMPILE_TIMEOUT_MS} ms）`);
            }
            if (compiled.code !== 0) {
                throw new JudgeError('CE', compiled.stderr.trim() || `编译失败（退出码 ${compiled.code}）`);
            }
            cmd = path.join(workDir, target);
            args = [];
            runInput = input;
            // 编译器的输出对用户没有意义，这里不再透传
        } else if (lang === 'python') {
            const python = resolvePython();
            if (pythonIsolationFlag === null) {
                pythonIsolationFlag = worksOnce(python, ['-I', '-c', 'pass'])
                    ? ['-I']
                    : (worksOnce(python, ['-E', '-S', '-c', 'pass']) ? ['-E', '-S'] : []);
            }
            cmd = python;
            args = [...pythonIsolationFlag, sourceName];
        } else {
            cmd = resolveJsRuntime();
            args = [sourceName];
        }

        const result = await spawnCapture(cmd, args, {
            cwd: workDir,
            input: runInput,
            timeLimitMs,
            maxOutputBytes,
            env: { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
        });

        if (result.timedOut) {
            throw new JudgeError('TLE', `运行超时（超过 ${timeLimitMs} ms）`);
        }
        if (result.overflow) {
            throw new JudgeError('OLE', `输出超过 ${maxOutputBytes} 字节`);
        }
        if (result.code !== 0 || result.signal) {
            const detail = result.stderr.trim();
            throw new JudgeError(
                'RE',
                detail || `程序异常退出（退出码 ${result.code}${result.signal ? `，信号 ${result.signal}` : ''}）`,
            );
        }
        return result.stdout;
    } finally {
        // Windows 上进程刚被 kill 时目录可能仍被占用，需要短暂重试
        await removeDirWithRetry(workDir);
    }
}

export function toJudgeError(err: unknown): JudgeError {
    if (err instanceof JudgeError) return err;
    if (typeof err === 'string') return new JudgeError('RE', err);
    return new JudgeError('RE', (err as Error)?.message || String(err));
}
