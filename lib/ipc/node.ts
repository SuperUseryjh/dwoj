import { setLogSink } from '../logger';
import { Envelope, Role, decode, encode, takeLines } from './protocol';

/**
 * 子进程侧的 IPC 节点。
 *
 * - 子进程只能通过 broker 转发消息（星型拓扑），不直接持有其它进程的句柄；
 * - 收到的 `call` 交给注册的 handler 处理，结果自动 reply；
 * - 发出去的 `call` 若目标进程退出，会立刻失败，避免提交卡在 Running。
 */

type Handler = (method: string, params: any) => Promise<any> | any;
type EventHandler = (event: string, data: any) => void;

let nextId = 1;
const pending = new Map<number, {
    to: Role;
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
}>();

let handler: Handler | null = null;
let eventHandler: EventHandler | null = null;
let shutdownHook: (() => Promise<void> | void) | null = null;
let started = false;

const role: Role = (process.env.DWOJ_PROCESS_ROLE as Role) || 'broker';

// 子进程的 stdout 归 IPC 协议所有。即使 startChild 之前有代码打印，
// 也不能写 stdout，否则会污染协议帧（宁可先走 stderr）。
if (process.env.DWOJ_PROCESS_ROLE) {
    console.log = (...args: any[]) => console.error(...args);
    console.info = (...args: any[]) => console.error(...args);
}

export function currentRole(): Role {
    return role;
}

/** 子进程启动：接管 stdin，处理 broker 转发来的消息 */
export function startChild(options: {
    handler: Handler;
    onEvent?: EventHandler;
    onShutdown?: () => Promise<void> | void;
}): void {
    if (started) return;
    started = true;
    handler = options.handler;
    eventHandler = options.onEvent || null;
    shutdownHook = options.onShutdown || null;

    // 日志交给 broker 统一打印（INFO 走 stdout，不会被终端染成红色）
    setLogSink((level, line) => {
        write({ kind: 'event', from: role, to: 'broker', method: 'log', params: { level, line } });
    });

    let buffer = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
        const { lines, rest } = takeLines(buffer + chunk);
        buffer = rest;
        for (const line of lines) {
            void onLine(line);
        }
    });
    process.stdin.on('end', () => {
        // broker 关闭了管道，跟着退出
        process.exit(0);
    });
}

const TRACE = String(process.env.DWOJ_IPC_TRACE || '') === '1';

async function onLine(line: string): Promise<void> {
    let msg: Envelope;
    try {
        msg = decode<Envelope>(line);
    } catch (_) {
        return;
    }
    if (TRACE) {
        console.error(`[ipc:${role}] <- ${msg.kind} from=${msg.from} to=${msg.to} method=${msg.method || ''} id=${msg.id ?? '-'}`);
    }

    switch (msg.kind) {
        case 'call':
            await handleCall(msg);
            break;
        case 'reply': {
            const entry = msg.id !== undefined ? pending.get(msg.id) : undefined;
            if (!entry) return;
            pending.delete(msg.id!);
            if (entry.timer) clearTimeout(entry.timer);
            if (msg.ok) entry.resolve(msg.result);
            else entry.reject(new Error(msg.error || '远端调用失败'));
            break;
        }
        case 'event':
            if (msg.method === 'peer-down') {
                failCallsTo(msg.params?.role as Role, new Error(`进程 ${msg.params?.role} 已退出`));
            }
            eventHandler?.(msg.method || '', msg.params);
            break;
        case 'shutdown':
            // 先让业务代码收尾（关连接、销毁虚拟机），再退出
            void (async () => {
                try {
                    await shutdownHook?.();
                } catch (_) { /* ignore */ }
                process.exit(0);
            })();
            break;
        default:
            break;
    }
}

async function handleCall(msg: Envelope): Promise<void> {
    const reply: Envelope = { kind: 'reply', id: msg.id, from: role, to: msg.from };
    try {
        if (!handler) throw new Error('子进程尚未注册 handler');
        reply.result = await handler(msg.method || '', msg.params);
        reply.ok = true;
    } catch (err) {
        reply.ok = false;
        reply.error = (err as Error)?.message || String(err);
    }
    write(reply);
}

function write(msg: Envelope): void {
    try {
        process.stdout.write(encode(msg) + '\n');
    } catch (_) { /* broker 已退出 */ }
}

/** 通知（不需要回执），例如把提交丢给评测进程 */
export function notify(to: Role, method: string, params?: any): void {
    write({ kind: 'event', from: role, to, method, params });
}

/** 请求/响应式调用 */
export function call<T = any>(
    to: Role,
    method: string,
    params?: any,
    timeoutMs = 30000,
): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        const timer = timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${to}.${method} 超时（${timeoutMs}ms）`));
            }, timeoutMs)
            : null;
        pending.set(id, { to, resolve, reject, timer });
        write({ kind: 'call', id, from: role, to, method, params });
    });
}

/** 上报就绪 */
export function reportReady(info: Record<string, any> = {}): void {
    write({ kind: 'ready', from: role, to: 'broker', info });
}

function failCallsTo(target: Role, err: Error): void {
    for (const [id, entry] of pending) {
        if (entry.to !== target) continue;
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(err);
    }
}
