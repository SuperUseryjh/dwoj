import path from 'path';
import * as config from '../../config';
import { createLogger } from '../logger';
import { ExecuteOutcome, ExecuteRequest, ExecutionBackend } from './backend';

const logger = createLogger('judge');

/**
 * 把执行后端放到独立进程里跑的代理。
 *
 * 父进程（OJ）与工作进程之间用 NDJSON 通信（见 worker.ts），
 * 所有沙箱相关的东西（v86 的 WASM 内存、g++/python 子进程、崩溃）都被隔离在子进程。
 */

interface Pending {
    resolve: (outcome: ExecuteOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class RemoteBackend implements ExecutionBackend {
    readonly name: string;
    readonly languages: string[];

    private mode: 'process' | 'v86';
    private proc: any = null;
    private ready = false;
    private readyPromise: Promise<void> | null = null;
    private pending = new Map<number, Pending>();
    private pendingReadyReject: ((err: Error) => void) | null = null;
    private nextId = 1;
    private buffer = '';
    private disposed = false;

    constructor(mode: 'process' | 'v86') {
        this.mode = mode;
        this.name = `${mode}:worker`;
        this.languages = mode === 'v86' ? config.V86_LANGUAGES : config.LANGUAGES;
    }

    async init(): Promise<void> {
        await this.ensureWorker();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.rejectAll('OJ 正在关闭，评测已中止');
        const proc = this.proc;
        this.proc = null;
        this.ready = false;
        if (proc) {
            try {
                const stdin: any = proc.stdin;
                stdin?.write(JSON.stringify({ type: 'dispose' }) + '\n');
                const flushed = typeof stdin?.flush === 'function' ? stdin.flush() : null;
                if (flushed && typeof flushed.catch === 'function') flushed.catch(() => {});
            } catch (_) { /* worker 已退出 */ }
            try {
                proc.kill();
            } catch (_) { /* ignore */ }
        }
    }

    async execute(req: ExecuteRequest): Promise<ExecuteOutcome> {
        try {
            await this.ensureWorker();
        } catch (err) {
            return { status: 'SE', message: `评测工作进程启动失败：${(err as Error).message}` };
        }

        const id = this.nextId++;
        const timeoutMs = this.budgetFor(req);

        return new Promise<ExecuteOutcome>(resolve => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                // 卡死就杀掉工作进程，下次执行会重新拉起
                logger.warn(`worker timeout after ${timeoutMs} ms, killing worker process`);
                this.killWorker();
                resolve({ status: 'SE', message: `评测工作进程超时（${timeoutMs} ms 无响应）` });
            }, timeoutMs);

            this.pending.set(id, { resolve, timer });
            try {
                this.writeToWorker({ type: 'execute', id, req });
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                resolve({ status: 'SE', message: `无法向工作进程发送任务：${(err as Error).message}` });
            }
        });
    }

    // ------------------------------------------------------------
    // 工作进程管理
    // ------------------------------------------------------------

    private budgetFor(req: ExecuteRequest): number {
        // 简单任务：时间限制 + 沙箱额外开销；C++ 还要算上编译
        const compileBudget = req.language === 'cpp'
            ? Math.max(config.COMPILE_TIMEOUT_MS, config.V86_COMPILE_TIMEOUT_MS)
            : 0;
        const bootBudget = this.mode === 'v86' ? config.V86_BOOT_TIMEOUT_MS : 0;
        return req.timeLimitMs + compileBudget + bootBudget + 60000;
    }

    /**
     * 往 worker 的 stdin 写一帧。
     * Bun FileSink 的 EPIPE 在 flush 时才以 rejected promise 出现，
     * 不就地吞掉会变成 unhandledRejection（worker 崩溃/关闭时很常见）。
     */
    private writeToWorker(message: Record<string, unknown>): void {
        const stdin: any = this.proc?.stdin;
        if (!stdin) throw new Error('评测工作进程未启动');
        stdin.write(JSON.stringify(message) + '\n');
        const flushed = typeof stdin.flush === 'function' ? stdin.flush() : null;
        if (flushed && typeof flushed.catch === 'function') flushed.catch(() => {});
    }

    private async ensureWorker(): Promise<void> {
        if (this.proc && this.ready) return;
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = this.spawnWorker().finally(() => { this.readyPromise = null; });
        return this.readyPromise;
    }

    private async spawnWorker(): Promise<void> {
        if (this.disposed) throw new Error('backend disposed');

        const workerPath = path.join(__dirname, `worker${path.extname(__filename) || '.ts'}`);
        const env = {
            ...process.env,
            JUDGE_WORKER_BACKEND: this.mode,
        };

        const proc = Bun.spawn({
            cmd: [process.execPath, workerPath],
            cwd: path.resolve(__dirname, '..', '..'),
            env,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'inherit',
        });

        this.proc = proc;
        this.ready = false;
        this.buffer = '';

        const decoder = new TextDecoder();
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();

        // 后台读取，不阻塞 spawn 完成
        void (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    this.onData(decoder.decode(value, { stream: true }));
                }
            } catch (_) { /* ignore */ }
            this.onExit();
        })();

        await new Promise<void>((resolve, reject) => {
            const finish = (err?: Error): void => {
                clearInterval(check);
                clearTimeout(timeout);
                this.pendingReadyReject = null;
                if (err) reject(err);
                else resolve();
            };

            const timeout = setTimeout(() => {
                finish(new Error(`工作进程未在 300s 内就绪（${this.mode}）`));
                this.killWorker();
            }, 300_000);

            // 进程在就绪之前退出时立刻失败，不要让提交一直卡在 Running
            this.pendingReadyReject = (err: Error) => finish(err);

            const check = setInterval(() => {
                if (this.ready) finish();
            }, 20);
        });
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            let message: any;
            try {
                message = JSON.parse(line);
            } catch (_) {
                continue;
            }
            this.onMessage(message);
        }
    }

    private onMessage(message: any): void {
        if (message.type === 'ready') {
            this.ready = true;
            logger.info(`worker ready: ${message.name} (${(message.languages || []).join(', ')})`);
            return;
        }
        if (message.type === 'result') {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            pending.resolve(message.outcome as ExecuteOutcome);
            return;
        }
        if (message.type === 'error') {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            pending.resolve({ status: 'SE', message: String(message.message || '工作进程异常') });
        }
    }

    private onExit(): void {
        const wasReady = this.ready;
        this.ready = false;
        this.proc = null;

        const pendingReady = this.pendingReadyReject;
        this.pendingReadyReject = null;
        pendingReady?.(new Error('评测工作进程在启动阶段退出（详见服务日志）'));

        if (wasReady) {
            logger.warn('worker process exited, pending executions will be reported as System Error');
        }
        this.rejectAll('评测工作进程意外退出');
    }

    private rejectAll(message: string): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.resolve({ status: 'SE', message });
            this.pending.delete(id);
        }
    }

    private killWorker(): void {
        const proc = this.proc;
        this.proc = null;
        this.ready = false;
        this.rejectAll('评测工作进程被终止');
        try {
            proc?.kill();
        } catch (_) { /* ignore */ }
    }
}
