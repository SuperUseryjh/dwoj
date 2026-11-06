/**
 * 评测工作进程（独立 OS 进程）。
 *
 * 由 RemoteBackend 通过 stdin/stdout 的 NDJSON 协议驱动：
 *   父 -> 子: {"type":"execute","id":1,"req":{...}}
 *   子 -> 父: {"type":"ready","name":"v86","languages":["python","cpp"]}
 *             {"type":"result","id":1,"outcome":{...}}
 *             {"type":"error","id":1,"message":"..."}
 *
 * 为什么要独立进程：
 *   - v86 的 WASM + JIT 很吃内存，隔离后 OJ 主进程只保留 HTTP/数据库；
 *   - 用户代码把沙箱搞崩、或者 WASM 内存爆掉，只会带走这个进程，
 *     主进程收到 SE 结果并在下一次执行时重新拉起；
 *   - 评测占用的 CPU 不再和 HTTP 请求抢同一个事件循环。
 */

import { ExecuteOutcome, ExecuteRequest, ExecutionBackend } from './backend';

// 子进程的 stdout 专供 IPC，日志一律走 stderr
console.log = (...args: any[]) => console.error(...args);
console.info = (...args: any[]) => console.error(...args);

const backendName = process.env.JUDGE_WORKER_BACKEND === 'v86' ? 'v86' : 'process';

function send(message: Record<string, unknown>): void {
    try {
        process.stdout.write(JSON.stringify(message) + '\n');
        // 管道对端（judge 进程）退出时的 EPIPE 是正常竞态，别让它变成 unhandledRejection
        const flushed: any = (process.stdout as any).flush?.();
        if (flushed && typeof flushed.catch === 'function') flushed.catch(() => {});
    } catch (_) { /* 对端已退出 */ }
}

async function createBackend(): Promise<ExecutionBackend> {
    if (backendName === 'v86') {
        const { V86Backend } = await import('./v86_backend');
        return new V86Backend();
    }
    const { ProcessBackend } = await import('./process_backend');
    return new ProcessBackend();
}

async function main(): Promise<void> {
    const backend = await createBackend();

    // 初始化可能很慢（v86 冷启动），但 ready 之后才接受任务
    await backend.init();
    send({ type: 'ready', name: backend.name, languages: backend.languages });

    // 任务串行执行（沙箱本身就是单实例的）
    let chain: Promise<void> = Promise.resolve();

    const handle = async (message: any): Promise<void> => {
        if (message.type === 'execute') {
            let outcome: ExecuteOutcome;
            try {
                outcome = await backend.execute(message.req as ExecuteRequest);
            } catch (err) {
                outcome = { status: 'SE', message: `工作进程执行失败：${(err as Error)?.message || err}` };
            }
            send({ type: 'result', id: message.id, outcome });
            return;
        }
        if (message.type === 'dispose') {
            await backend.dispose();
            process.exit(0);
        }
    };

    let buffer = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            let message: any;
            try {
                message = JSON.parse(line);
            } catch (_) {
                continue;
            }
            chain = chain.then(() => handle(message)).catch(err => {
                console.error('[judge-worker] handler error:', err);
            });
        }
    });

    process.stdin.on('end', () => {
        chain = chain.then(async () => {
            await backend.dispose();
            process.exit(0);
        });
    });
}

main().catch(err => {
    console.error('[judge-worker] fatal:', err);
    process.exit(1);
});
