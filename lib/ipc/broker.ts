import path from 'path';
import * as config from '../../config';
import { createLogger } from '../logger';
import { Envelope, Role, decode, encode, takeLines } from './protocol';

const logger = createLogger('broker');

/**
 * 主进程（broker）：只做进程编排和消息转发，不持有 HTTP 端口、
 * 不打开数据库、不加载沙箱。
 *
 * 星型拓扑：所有子进程只和 broker 说话，broker 按 `to` 字段转发。
 * 子进程退出会被自动拉起；退出时通过 `peer-down` 事件让其它进程
 * 立刻失败掉发往它的请求，而不是一直等超时。
 */

interface Child {
    role: Role;
    proc: any;
    ready: boolean;
    readyPromise: Promise<void>;
    markReady: () => void;
    failReady: (err: Error) => void;
    restarts: number;
    startedAt: number;
    stopped: boolean;
}

const ENTRY_FILES: Record<Exclude<Role, 'broker'>, string[]> = {
    db: ['..', 'db', 'db_service'],
    http: ['..', 'http', 'http_service'],
    judge: ['..', 'judge', 'judge_service'],
};

function entryPath(role: Exclude<Role, 'broker'>): string {
    const ext = path.extname(__filename) || '.ts';
    return path.join(__dirname, ...ENTRY_FILES[role]) + ext;
}

export class Broker {
    private children = new Map<Role, Child>();
    private readyInfo = new Map<Role, Record<string, any>>();
    private shuttingDown = false;
    private pending = new Map<number, {
        resolve: (value: any) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout> | null;
    }>();
    private nextId = 1;

    // ------------------------------------------------------------
    // 启动
    // ------------------------------------------------------------

    async start(): Promise<void> {
        // 数据库必须先就绪：http / judge 启动就会查库（迁移、重新排队等）
        await this.spawnAndWait('db');
        await Promise.all([this.spawnAndWait('http'), this.spawnAndWait('judge')]);
        logger.info('all services are up');
    }

    private async spawnAndWait(role: Role): Promise<void> {
        const child = this.spawn(role);
        await child.readyPromise;
    }

    private spawn(role: Role): Child {
        const entry = entryPath(role as Exclude<Role, 'broker'>);
        logger.info(`starting ${role} (${path.basename(entry)})`);

        let markReady!: () => void;
        let failReady!: (err: Error) => void;
        const readyPromise = new Promise<void>((resolve, reject) => {
            markReady = resolve;
            failReady = reject;
        });
        // 避免未处理的 rejection（子进程可能在 ready 之前就退出）
        readyPromise.catch(() => { /* 由 spawnAndWait 处理 */ });

        const proc = Bun.spawn({
            cmd: [process.execPath, entry],
            cwd: path.resolve(__dirname, '..', '..'),
            env: {
                ...process.env,
                DWOJ_PROCESS_ROLE: role,
                DWOJ_DB_DIALECT: String(config.DB_DRIVER || 'sqlite').toLowerCase(),
            },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'inherit',
        });

        const child: Child = {
            role,
            proc,
            ready: false,
            readyPromise,
            markReady,
            failReady,
            restarts: 0,
            startedAt: Date.now(),
            stopped: false,
        };
        this.children.set(role, child);

        void this.readLoop(child);
        return child;
    }

    private async readLoop(child: Child): Promise<void> {
        const decoder = new TextDecoder();
        const reader = (child.proc.stdout as ReadableStream<Uint8Array>).getReader();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const { lines, rest } = takeLines(buffer + decoder.decode(value, { stream: true }));
                buffer = rest;
                for (const line of lines) {
                    let msg: Envelope;
                    try {
                        msg = decode<Envelope>(line);
                    } catch (_) {
                        logger.warn(`invalid message from ${child.role}`);
                        continue;
                    }
                    this.onMessage(child, msg);
                }
            }
        } catch (_) {
            /* 读取中断视为退出 */
        }

        await this.onExit(child);
    }

    private trace(msg: Envelope): void {
        if (String(process.env.DWOJ_IPC_TRACE || '') !== '1') return;
        if (msg.kind === 'ready') return;
        const detail = msg.kind === 'call' || msg.kind === 'event' ? msg.method : '';
        logger.info(`${msg.kind} ${msg.from} -> ${msg.to} ${detail} id=${msg.id ?? '-'}`);
    }

    private onMessage(child: Child, msg: Envelope): void {
        // 子进程的日志：由 broker 按级别打印到 stdout/stderr
        if (msg.kind === 'event' && msg.method === 'log') {
            const { level, line } = (msg.params || {}) as { level?: string; line?: string };
            const text = String(line ?? '');
            if (level === 'ERRO') console.error(text);
            else if (level === 'WARN') console.warn(text);
            else console.log(text);
            return;
        }

        this.trace(msg);
        if (msg.kind === 'ready') {
            child.ready = true;
            child.restarts = 0;
            this.readyInfo.set(child.role, msg.info || {});
            child.markReady();
            logger.info(`${child.role} ready ${JSON.stringify(msg.info || {})}`);
            return;
        }

        if (msg.kind === 'reply') {
            // 只截留发给 broker 的响应；进程之间的响应要转发给发起方
            if (!msg.to || msg.to === 'broker') {
                const entry = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
                if (!entry) return;
                this.pending.delete(msg.id!);
                if (entry.timer) clearTimeout(entry.timer);
                if (msg.ok) entry.resolve(msg.result);
                else entry.reject(new Error(msg.error || '远端调用失败'));
                return;
            }
        }

        const target = msg.to;
        if (!target || target === 'broker') {
            if (msg.kind === 'call' && msg.id !== undefined) {
                this.writeTo(child.role, {
                    kind: 'reply', id: msg.id, from: 'broker', to: child.role, ok: false,
                    error: 'broker 不提供业务方法',
                });
            }
            return;
        }

        const dest = this.children.get(target);
        if (!dest) {
            if (msg.kind === 'call' && msg.id !== undefined) {
                this.writeTo(child.role, {
                    kind: 'reply', id: msg.id, from: 'broker', to: child.role, ok: false,
                    error: `目标进程不可用：${target}`,
                });
            } else if (msg.kind === 'event') {
                logger.warn(`dropped event ${msg.method} -> ${target} (target not running)`);
            }
            return;
        }

        // 响应必须转发，即使目标还在初始化（它自己发起的请求要等结果）；
        // 新的 call / event 才需要目标已经 ready。
        if (msg.kind !== 'reply' && !dest.ready) {
            if (msg.kind === 'call' && msg.id !== undefined) {
                this.writeTo(child.role, {
                    kind: 'reply', id: msg.id, from: 'broker', to: child.role, ok: false,
                    error: `目标进程尚未就绪：${target}`,
                });
            } else {
                logger.warn(`dropped event ${msg.method} -> ${target} (not ready yet)`);
            }
            return;
        }

        this.writeTo(target, msg);
    }

    private writeTo(role: Role, msg: Envelope): void {
        const child = this.children.get(role);
        if (!child) {
            if (String(process.env.DWOJ_IPC_TRACE || '') === '1') logger.warn(`no child for ${role}`);
            return;
        }
        // 子进程已经退出：管道必然 EPIPE，直接丢弃（关闭/重启期间的正常竞态）
        if (child.proc.exitCode !== null) return;

        const stdin: any = child.proc.stdin;
        if (!stdin) return;
        try {
            stdin.write(encode(msg) + '\n');
            // Bun 的 FileSink.write() 只是同步缓冲，真正的 EPIPE 在 flush 时才以
            // rejected promise 出现；不 catch 会变成 unhandledRejection，导致
            // Ctrl+C 关闭时 broker 以 exit 1 崩掉。
            const flushed = typeof stdin.flush === 'function' ? stdin.flush() : null;
            if (flushed && typeof flushed.catch === 'function') flushed.catch(() => {});
        } catch (err) {
            const code = (err as any)?.code;
            if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED' && code !== 'ERR_STREAM_WRITE_AFTER_END') {
                logger.error(`write to ${role} failed`, err as Error);
            }
        }
    }

    private async onExit(child: Child): Promise<void> {
        const aliveMs = Date.now() - child.startedAt;
        child.ready = false;
        this.children.delete(child.role);

        const code = child.proc.exitCode;
        if (this.shuttingDown || child.stopped) {
            logger.info(`${child.role} stopped (exit=${code})`);
            return;
        }

        logger.error(`${child.role} exited unexpectedly (exit=${code}, uptime=${aliveMs}ms)`);
        child.failReady(new Error(`${child.role} 进程启动失败`));

        // 通知其它进程：发往它的请求立刻失败
        for (const other of this.children.values()) {
            this.writeTo(other.role, { kind: 'event', from: 'broker', to: other.role, method: 'peer-down', params: { role: child.role } });
        }

        const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(child.restarts, 5)));
        logger.warn(`restarting ${child.role} in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));

        const restarted = this.spawn(child.role);
        restarted.restarts = child.restarts + 1;
        restarted.readyPromise.catch(err => {
            logger.error(`${child.role} failed to come back`, err as Error);
        });
    }

    // ------------------------------------------------------------
    // broker 侧主动调用（健康检查 / 关闭）
    // ------------------------------------------------------------

    /** 子进程 ready 时上报的信息（如 judge 的 backend/languages） */
    info(role: Role): Record<string, any> {
        return this.readyInfo.get(role) || {};
    }

    call<T = any>(role: Role, method: string, params?: any, timeoutMs = 5000): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = timeoutMs > 0
                ? setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`${role}.${method} 超时`));
                }, timeoutMs)
                : null;
            this.pending.set(id, { resolve, reject, timer });
            this.writeTo(role, { kind: 'call', id, from: 'broker', to: role, method, params });
        });
    }

    async stop(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        logger.info('shutting down services...');

        for (const child of this.children.values()) {
            child.stopped = true;
            // 已经退出的子进程不要再写：给死管道发 shutdown 只会制造 EPIPE
            if (child.proc.exitCode !== null) continue;
            this.writeTo(child.role, { kind: 'shutdown', from: 'broker', to: child.role });
        }

        // onExit 会删除已退出的子进程；只等待「还活着」的（exitCode === null）。
        // 注意不能只等 map 为空：测试 / 假子进程不会触发 onExit；
        // 也不能只认 exitCode：Windows 上被信号终止的进程 exitCode 可能是 null，
        // 但 onExit 会把它从 map 里删掉，所以两者要结合。
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            const alive = [...this.children.values()].some(c => c.proc.exitCode === null);
            if (!alive) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        for (const child of this.children.values()) {
            try {
                child.proc.kill();
            } catch (_) { /* ignore */ }
        }
        this.children.clear();
    }
}
