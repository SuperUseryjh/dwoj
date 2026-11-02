import { spawn, spawnSync, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import * as config from '../../config';
import logger from '../logger';
import { ExecuteOutcome, ExecuteRequest, ExecutionBackend, JudgeError, JudgeErrorKind } from './backend';

/**
 * 直接在服务器上运行用户代码（无隔离）。
 * 只适合本地开发/内网，生产环境应使用 v86 后端。
 */

interface Invocation {
    cmd: string;
    prefixArgs: string[];
}

interface Runner {
    ext: string;
    resolve: () => Invocation;
}

/** 解释器探测结果缓存（cmd + args -> 是否可用） */
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

let cachedPython: string | null | undefined;
let pythonIsolationFlag: string[] | null = null;

/**
 * 找到可用的 Python 3。
 * 注意：Windows 上 `python` 可能指向 Python 2（2.x 不支持 -I），
 * 因此必须优先 python3 且校验主版本号。
 */
export function resolvePython(): string {
    if (cachedPython === undefined) {
        cachedPython = null;
        for (const cmd of ['python3', 'python']) {
            if (worksOnce(cmd, ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'])) {
                cachedPython = cmd;
                break;
            }
        }
    }
    if (!cachedPython) {
        throw new JudgeError('SE', '评测机未找到 Python 3 解释器（python3 / python）');
    }
    return cachedPython;
}

let cachedJsRuntime: string | null | undefined;

function resolveJsRuntime(): string {
    if (cachedJsRuntime === undefined) {
        cachedJsRuntime = null;
        for (const cmd of ['bun', 'node']) {
            if (worksOnce(cmd, ['--version'])) {
                cachedJsRuntime = cmd;
                break;
            }
        }
    }
    if (!cachedJsRuntime) {
        throw new JudgeError('SE', '评测机未找到 JavaScript 运行时（bun / node）');
    }
    return cachedJsRuntime;
}

const RUNNERS: Record<string, Runner> = {
    python: {
        ext: 'py',
        resolve: () => {
            const cmd = resolvePython();
            if (pythonIsolationFlag === null) {
                // -I（隔离模式）从 3.4 开始才有；没有就退化为 -E -S
                pythonIsolationFlag = worksOnce(cmd, ['-I', '-c', 'pass'])
                    ? ['-I']
                    : (worksOnce(cmd, ['-E', '-S', '-c', 'pass']) ? ['-E', '-S'] : []);
            }
            return { cmd, prefixArgs: [...pythonIsolationFlag] };
        },
    },
    node: {
        ext: 'js',
        resolve: () => ({ cmd: resolveJsRuntime(), prefixArgs: [] }),
    },
};

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
        try {
            const startedAt = Date.now();
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
            return { status: je.kind, message: je.message };
        }
    }
}

/**
 * 在独立临时目录中执行一次用户程序，返回 stdout。
 * 失败时抛出 JudgeError，区分 TLE / RE / OLE / SE。
 */
export async function executeProgram(
    lang: string,
    code: string,
    input: string,
    timeLimitMs: number,
    maxOutputBytes: number = config.MAX_OUTPUT_BYTES,
): Promise<string> {
    const runner = RUNNERS[lang];
    if (!runner) throw new JudgeError('CE', `不支持的语言：${lang}`);
    const invocation = runner.resolve();

    // 每次评测独立目录，同时作为子进程 cwd，避免用户程序通过相对路径
    // 直接读到 problems_data 里的答案 / 数据库文件。
    const workDir = path.join(config.JUDGE_DIR, crypto.randomUUID());
    fs.ensureDirSync(workDir);
    const fileName = `main.${runner.ext}`;
    fs.writeFileSync(path.join(workDir, fileName), code, 'utf-8');

    try {
        return await new Promise<string>((resolve, reject) => {
            const isWindows = process.platform === 'win32';
            const cmd = invocation.cmd;

            let child: ChildProcess;
            try {
                child = spawn(cmd, [...invocation.prefixArgs, fileName], {
                    cwd: workDir,
                    env: {
                        PATH: process.env.PATH || '',
                        HOME: workDir,
                        TMPDIR: workDir,
                        TEMP: workDir,
                        LANG: 'C.UTF-8',
                        LC_ALL: 'C.UTF-8',
                        PYTHONIOENCODING: 'utf-8',
                        PYTHONDONTWRITEBYTECODE: '1',
                        PYTHONUNBUFFERED: '1',
                    },
                    stdio: ['pipe', 'pipe', 'pipe'],
                    // POSIX 下用独立进程组，超时时可以整组杀掉
                    detached: !isWindows,
                    windowsHide: true,
                });
            } catch (err) {
                reject(new JudgeError('SE', `无法启动评测进程 (${cmd}): ${(err as Error).message}`));
                return;
            }

            let output = '';
            let stderr = '';
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;

            const fail = (kind: JudgeErrorKind, message: string): void => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                killProcessTree(child);
                reject(new JudgeError(kind, message));
            };

            timer = setTimeout(() => {
                fail('TLE', `运行超时（超过 ${timeLimitMs} ms）`);
            }, timeLimitMs);

            child.stdout?.on('data', (chunk: Buffer) => {
                if (settled) return;
                output += chunk.toString('utf-8');
                if (Buffer.byteLength(output, 'utf-8') > maxOutputBytes) {
                    fail('OLE', `输出超过 ${maxOutputBytes} 字节`);
                }
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                if (stderr.length < config.MAX_STDERR_BYTES) {
                    stderr += chunk.toString('utf-8');
                }
            });

            // 用户程序不读 stdin 就直接退出时会触发 EPIPE，
            // 不吞掉这个事件会把整个 OJ 进程打崩。
            child.stdin?.on('error', () => { /* ignore EPIPE */ });
            try {
                child.stdin?.write(input.endsWith('\n') ? input : input + '\n');
                child.stdin?.end();
            } catch (_) { /* 进程已退出，交由 close / error 处理 */ }

            child.on('error', (err: Error) => {
                fail('SE', `无法启动评测进程 (${cmd}): ${err.message}`);
            });

            child.on('close', (exitCode, signal) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);

                if (exitCode === 0 && !signal) {
                    resolve(output);
                    return;
                }
                const detail = stderr.trim();
                reject(new JudgeError(
                    'RE',
                    detail
                        ? detail
                        : `程序异常退出（退出码 ${exitCode}${signal ? `，信号 ${signal}` : ''}）`
                ));
            });
        });
    } finally {
        // Windows 上进程刚被 kill 时目录可能仍被占用，需要短暂重试
        await removeDirWithRetry(workDir);
    }
}

async function removeDirWithRetry(dir: string, attempts = 6): Promise<void> {
    for (let i = 0; i < attempts; i++) {
        try {
            fs.removeSync(dir);
            return;
        } catch (err) {
            if (i === attempts - 1) {
                logger.warn(`[Judge] Failed to remove temp dir ${path.basename(dir)}: ${(err as Error).message}`);
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

export function toJudgeError(err: unknown): JudgeError {
    if (err instanceof JudgeError) return err;
    if (typeof err === 'string') return new JudgeError('RE', err);
    return new JudgeError('RE', (err as Error)?.message || String(err));
}
