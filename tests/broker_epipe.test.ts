/**
 * 回归测试：Ctrl+C 关闭时 broker 不应因 EPIPE 崩溃
 *
 * Bun 的 proc.stdin 是 FileSink：write() 只是同步缓冲，管道断开（子进程已退出）
 * 的 EPIPE 会在 flush 时以 rejected promise 出现。之前 writeTo 只 try/catch 了
 * 同步写入，于是关闭时会出现 3 条 EPIPE unhandledRejection，broker 以 exit 1 退出。
 */
import { describe, expect, test } from 'bun:test';
import { Broker } from '../lib/ipc/broker';

function fakeChild(role: string, proc: any): any {
    return {
        role,
        proc,
        ready: true,
        readyPromise: Promise.resolve(),
        markReady: () => {},
        failReady: () => {},
        restarts: 0,
        startedAt: Date.now(),
        stopped: false,
    };
}

function spawnExited(): any {
    return Bun.spawn({
        cmd: [process.execPath, '-e', 'process.exit(0)'],
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
    });
}

const envelope = (to: string): any => ({
    kind: 'event',
    from: 'broker',
    to,
    method: 'ping',
});

describe('ipc / broker shutdown resilience', () => {
    test('给已退出子进程写帧不会产生 unhandledRejection', async () => {
        const proc = spawnExited();
        await proc.exited;

        const broker: any = new Broker();
        broker.children.set('db', fakeChild('db', proc));

        const unhandled: any[] = [];
        const onUnhandled = (reason: any) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);

        try {
            // 正常路径：exitCode !== null → 直接跳过
            for (let i = 0; i < 200; i++) broker.writeTo('db', envelope('db'));

            // 竞态路径：退出码还没反映出来的瞬间仍会真的去写死管道
            Object.defineProperty(proc, 'exitCode', { value: null, configurable: true });
            for (let i = 0; i < 200; i++) broker.writeTo('db', envelope('db'));

            await Bun.sleep(300);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }

        expect(unhandled).toHaveLength(0);
    });

    test('stop() 跳过已退出的子进程，立即返回且不抛错', async () => {
        const dbProc = spawnExited();
        const httpProc = spawnExited();
        await Promise.all([dbProc.exited, httpProc.exited]);

        const broker: any = new Broker();
        broker.children.set('db', fakeChild('db', dbProc));
        broker.children.set('http', fakeChild('http', httpProc));

        const started = Date.now();
        await broker.stop();
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(2000);
        expect(broker.children.size).toBe(0);
    });
});
