import crypto from 'crypto';
import fs from 'fs-extra';
import * as config from '../../config';
import { App } from '../bun-http';
import { createLogger } from '../logger';
import { reportReady, startChild } from '../ipc/node';
import { PluginManager } from './manager';
import { createPluginRouteGuard } from './routes';
import { PLUGIN_RPC, hydrateRequest, type JudgeHook } from './protocol';
import createPluginRuntime from '../../middleware/plugin_runtime';

const logger = createLogger('plugin');

/**
 * 插件进程：整个系统里唯一加载插件代码的地方。
 *
 *   1. 通过 IPC 响应 http / judge 的钩子与管理请求；
 *   2. 在 127.0.0.1 上监听内部 HTTP 端口，承载插件路由。
 *
 * 每次插件状态变化都会重建 App + PluginManager，路由整体替换实现热更新。
 */

let current: { manager: PluginManager; app: App } | null = null;
let builtinEnabled: string[] = config.ENABLED_BUILTIN_PLUGINS.filter(Boolean);
let server: any = null;

const internalToken = crypto.randomBytes(16).toString('hex');

/** 串行化重建，避免并发 toggle / upload 把状态搅乱 */
let rebuildChain: Promise<void> = Promise.resolve();

async function build(): Promise<void> {
    const app = new App();
    // plugin 进程里的所有路由都来自插件：没有元数据的路由也按“默认已登录”处理
    app.setRouteGuard(createPluginRouteGuard({ enforceAll: true }));

    const manager = new PluginManager(config.PLUGINS_DIR, { app, builtinEnabled });
    app.use(createPluginRuntime(manager));
    await manager.loadAll();

    current = { manager, app };
    logger.info(`plugin system ready (${manager.getList().length} plugin(s))`);
}

function rebuild(): Promise<void> {
    // 队列始终是已解决的（错误在下面单独记录），因此下一次重建不会被短路
    const next = rebuildChain.then(build);
    rebuildChain = next.catch(() => { /* 具体错误在返回值上抛给调用方 */ });
    return next.catch(err => {
        logger.error('failed to rebuild plugin system', err as Error);
        throw err;
    });
}

function requireCurrent(): { manager: PluginManager; app: App } {
    if (!current) throw new Error('插件系统尚未就绪');
    return current;
}

async function serve(method: string, params: any): Promise<any> {
    switch (method) {
        case PLUGIN_RPC.HTTP_INFO:
            if (!server) throw new Error('插件路由服务器尚未启动');
            return { port: server.port, token: internalToken };

        case PLUGIN_RPC.INJECT:
            return await requireCurrent().manager.inject(hydrateRequest(params.req || {}));

        case PLUGIN_RPC.JUDGE: {
            const hook = String(params.hook || '') as JudgeHook;
            if (hook !== 'beforeJudge' && hook !== 'afterJudge') {
                throw new Error(`不支持的判题钩子：${hook}`);
            }
            const manager = requireCurrent().manager;
            return hook === 'beforeJudge'
                ? await manager.beforeJudge(params.submission)
                : await manager.afterJudge(params.submission);
        }

        case PLUGIN_RPC.LIST:
            return requireCurrent().manager.getList();

        case PLUGIN_RPC.TOGGLE: {
            const manager = requireCurrent().manager;
            await manager.toggle(String(params.filename || ''), !!params.enabled, { reload: false });
            builtinEnabled = manager.getBuiltinEnabled();
            await rebuild();
            return requireCurrent().manager.getList();
        }

        case PLUGIN_RPC.DELETE: {
            await requireCurrent().manager.delete(String(params.filename || ''), { reload: false });
            await rebuild();
            return requireCurrent().manager.getList();
        }

        case PLUGIN_RPC.RELOAD:
            await rebuild();
            return requireCurrent().manager.getList();

        default:
            throw new Error(`plugin 进程不支持的方法：${method}`);
    }
}

async function main(): Promise<void> {
    // 1. 先接管 IPC 通道，broker 才能在初始化期间做健康检查
    startChild({
        handler: serve,
        onShutdown: async () => {
            try { server?.stop(true); } catch (_) { /* ignore */ }
        },
    });

    fs.ensureDirSync(config.PLUGINS_DIR);

    // 2. 启动只监听回环地址的插件路由服务器
    server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request: Request) => {
            if (request.headers.get('x-dwoj-internal-token') !== internalToken) {
                return new Response('Forbidden', { status: 403 });
            }
            if (!current) {
                return new Response('Plugin system not ready', { status: 503 });
            }
            return await current.app.handle(request);
        },
    });

    // 3. 加载插件
    await rebuild();

    reportReady({
        port: server.port,
        plugins: requireCurrent().manager.getList().length,
        pid: process.pid,
    });
    logger.info(`service ready (route server on 127.0.0.1:${server.port})`);
}

main().catch(err => {
    logger.error('service failed to start', err as Error);
    process.exit(1);
});
