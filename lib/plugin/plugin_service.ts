import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import * as config from '../../config';
import { App } from '../bun-http';
import PluginSystem from '../plugin_system';
import { createLogger } from '../logger';
import { execute, db as databaseDb } from '../database';
import { reportReady, startChild } from '../ipc/node';
import { createPluginRouteGuard } from './route_auth';

const logger = createLogger('plugin');

/**
 * 插件进程：整个系统里唯一加载插件代码的地方。
 *
 * 它做两件事：
 *   1. 通过 IPC 响应 http / judge 发来的钩子与管理请求（`hooks.inject`、
 *      `hooks.judge`、`plugin.list` / `toggle` / `delete` / `reload`）；
 *   2. 在 127.0.0.1 上监听一个**内部 HTTP 端口**，承载插件通过 `onRoute`
 *      注册的路由。http 进程把未命中核心路由的请求反向代理到这里。
 *
 * 每次插件状态变化都会重建一个全新的 App + PluginSystem，因此插件的 HTTP
 * 路由可以在运行时热更新（旧路由随旧 App 一起丢弃，不会重复注册）。
 */

let current: { system: PluginSystem; app: App } | null = null;
let builtinEnabled: string[] = config.ENABLED_BUILTIN_PLUGINS.filter(Boolean);
let server: any = null;

const internalToken = crypto.randomBytes(16).toString('hex');

/** 串行化重建，避免并发 toggle / upload 把状态搅乱 */
let rebuildChain: Promise<void> = Promise.resolve();

async function build(): Promise<void> {
    const app = new App();
    app.set('view engine', 'ejs');
    // plugin 进程里的所有路由都来自插件：没有元数据的路由也按“默认已登录”处理
    app.setRouteGuard(createPluginRouteGuard({ enforceAll: true }));

    const oj = { app, db: databaseDb, config, logger: createLogger('plugin') };
    const system = new PluginSystem(config.PLUGINS_DIR, oj, builtinEnabled);
    await system.loadAll();

    current = { system, app };
    logger.info(`plugin system ready (${system.getList().length} plugin(s))`);
}

function rebuild(): Promise<void> {
    const next = rebuildChain.then(build, build);
    // 链本身吞掉错误，避免一次失败让后续重建全部短路
    rebuildChain = next.catch(() => { /* logged below */ });
    return next.catch(err => {
        logger.error('failed to rebuild plugin system', err as Error);
        throw err;
    });
}

function requireCurrent(): { system: PluginSystem; app: App } {
    if (!current) throw new Error('插件系统尚未就绪');
    return current;
}

async function serve(method: string, params: any): Promise<any> {
    switch (method) {
        case 'ping':
            return { role: 'plugin', port: server?.port, plugins: current ? current.system.getList().length : 0 };

        case 'http.info':
            if (!server) throw new Error('插件路由服务器尚未启动');
            return { port: server.port, token: internalToken };

        case 'hooks.inject': {
            const raw = params.req || {};
            // 经 IPC 传来的 headers 是普通对象，还原成 Headers 方便插件使用 req.headers.get()
            const req = { ...raw, headers: new Headers(raw.headers || {}) };
            return await requireCurrent().system.inject(req);
        }

        case 'hooks.judge':
            return await requireCurrent().system.runJudgeHook(params.hook, params.submission);

        case 'plugin.list':
            return requireCurrent().system.getList();

        case 'plugin.toggle': {
            const filename = String(params.filename || '');
            if (filename.startsWith('builtin:')) {
                const name = filename.slice('builtin:'.length);
                const set = new Set(builtinEnabled);
                if (params.enabled) set.add(name);
                else set.delete(name);
                builtinEnabled = [...set];
            } else {
                await execute('UPDATE plugin_configs SET enabled = ? WHERE filename = ?', [params.enabled ? 1 : 0, filename]);
            }
            await rebuild();
            return requireCurrent().system.getList();
        }

        case 'plugin.delete': {
            const filename = String(params.filename || '');
            if (filename.startsWith('builtin:')) {
                logger.warn(`Cannot delete builtin plugin: ${filename}`);
                return requireCurrent().system.getList();
            }
            const filePath = path.join(config.PLUGINS_DIR, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            await execute('DELETE FROM plugin_configs WHERE filename = ?', [filename]);
            await rebuild();
            return requireCurrent().system.getList();
        }

        case 'plugin.reload':
            await rebuild();
            return requireCurrent().system.getList();

        case 'shutdown':
            try { server?.stop(true); } catch (_) { /* ignore */ }
            return true;

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
        plugins: requireCurrent().system.getList().length,
        pid: process.pid,
    });
    logger.info(`service ready (route server on 127.0.0.1:${server.port})`);
}

main().catch(err => {
    logger.error('service failed to start', err as Error);
    process.exit(1);
});
