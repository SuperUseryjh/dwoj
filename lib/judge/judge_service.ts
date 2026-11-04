import * as config from '../../config';

const logger = createLogger('judge');

// judge 进程本身就是「评测进程」，沙箱直接跑在这里，
// 不需要再套一层 RemoteBackend 工作进程。
if (process.env.JUDGE_WORKER === undefined) process.env.JUDGE_WORKER = '0';
import { App } from '../bun-http';
import PluginSystem from '../plugin_system';
import { createLogger } from '../logger';
import { reportReady, startChild } from '../ipc/node';
import { getBackend } from './backend';
import { enqueueJudge, getSupportedLanguages, initJudge, isJudging } from '../../controllers/judge';

/**
 * 评测进程：拥有评测队列和沙箱后端。
 *
 * - 数据库读写通过 IPC 走 db 进程；
 * - HTTP 进程只发一条 `enqueue` 通知，不关心评测细节；
 * - 这里也加载插件系统，保证 beforeJudge / afterJudge 钩子照常触发
 *   （插件里的 onRoute 注册的路由不会被访问，页面路由在 HTTP 进程）。
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

    // 评测只有 Python/C++/Node 的代码，不需要真实的 HTTP 应用；
    // 这里用一个空 App 满足插件系统对 `oj.app` 的接口要求。
    const app = new App();
    const database = require('../database');
    const oj = { app, db: database.db, config, logger: createLogger('plugin') };
    const pluginManager = new PluginSystem(config.PLUGINS_DIR, oj, config.ENABLED_BUILTIN_PLUGINS);
    await pluginManager.loadAll();

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
