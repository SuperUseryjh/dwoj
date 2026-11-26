import * as config from '../../config';

const logger = createLogger('judge');

// judge 进程本身就是「评测进程」，沙箱直接跑在这里，
// 不需要再套一层 RemoteBackend 工作进程。
if (process.env.JUDGE_WORKER === undefined) process.env.JUDGE_WORKER = '0';
import { createPluginHost } from '../plugin/host';
import { createLogger } from '../logger';
import { reportReady, startChild } from '../ipc/node';
import { getBackend } from './backend';
import { enqueueJudge, getSupportedLanguages, initJudge, isJudging } from '../../controllers/judge';

/**
 * 评测进程：拥有评测队列和沙箱后端。
 *
 * - 数据库读写通过 IPC 走 db 进程；
 * - HTTP 进程只发一条 `enqueue` 通知，不关心评测细节；
 * - 插件钩子通过 IPC 交给 plugin 进程执行，judge 进程自身不再加载插件代码。
 */

async function main(): Promise<void> {
    startChild({
        handler: async (method: string, params: any) => {
            switch (method) {
                case 'ping':
                    return { role: 'judge', backend: getBackend().name };
                case 'enqueue':
                    enqueueJudge(Number(params.id));
                    return true;
                case 'isJudging':
                    return isJudging(Number(params.id));
                case 'languages':
                    return getSupportedLanguages();
                case 'shutdown':
                    await getBackend().dispose().catch(() => { /* ignore */ });
                    return true;
                default:
                    throw new Error(`judge 进程不支持的方法：${method}`);
            }
        },
        onShutdown: async () => {
            // 关掉虚拟机，避免 broker 退出后留下 WASM 内存
            await getBackend().dispose().catch(() => { /* ignore */ });
        },
    });

    // 插件只在 plugin 进程里加载，这里只保留一个 IPC 客户端
    const pluginManager = createPluginHost();
    await initJudge(pluginManager);

    reportReady({
        backend: getBackend().name,
        languages: getSupportedLanguages(),
        concurrency: config.JUDGE_CONCURRENCY,
    });
    logger.info(`service ready (backend=${getBackend().name}, pid=${process.pid})`);
}

main().catch(err => {
    logger.error('service failed to start', err as Error);
    process.exit(1);
});
