import fs from 'fs-extra';
import * as config from '../../config';
import { App } from '../bun-http';
import { RemotePluginHost } from '../plugin/host';
import globalMiddleware from '../../middleware/global';
import createRoutes from '../../routes/index';
import { reportReady, startChild } from '../ipc/node';
import { createLogger } from '../logger';

const logger = createLogger('http');

/**
 * HTTP 进程：只负责 HTTP 相关的部分（路由、EJS 渲染、静态文件、插件注入）。
 *
 * - 数据库访问通过 IPC 走 db 进程（`lib/database.ts` 会自动使用远程驱动）；
 * - 提交评测通过 IPC 通知 judge 进程（`lib/judge/judge_client.ts`）；
 * - 自己不持有数据库连接，也不加载沙箱虚拟机。
 */

const app = new App();

async function main(): Promise<void> {
    // 先接管 IPC 通道：插件加载会查数据库，必须在通道就绪之后再做
    startChild({
        handler: async (method: string) => {
            if (method === 'ping') return { role: 'http', port: config.PORT };
            if (method === 'shutdown') return true;
            throw new Error(`http 进程不支持的方法：${method}`);
        },
    });

    fs.ensureDirSync(config.DATA_DIR);
    fs.ensureDirSync(config.PROB_DIR);
    fs.ensureDirSync(config.UPLOAD_DIR);
    fs.ensureDirSync(config.PLUGINS_DIR);

    app.set('view engine', 'ejs');
    app.use(app.static('public'));

    const pluginManager = new RemotePluginHost();
    app.set('pluginManager', pluginManager);

    app.use(globalMiddleware(pluginManager));
    app.use(createRoutes(pluginManager));

    // 核心路由都没命中时，把请求转发给 plugin 进程里的插件路由服务器。
    // 必须作为“未命中兜底”而不是普通中间件，否则会排在子路由之前执行。
    app.setNotFoundHandler(async (req: any, res: any) => {
        try {
            const proxied = await pluginManager.proxy(req);
            if (!proxied) return;
            res._status = proxied.status;
            proxied.headers.forEach((value: string, key: string) => {
                const lower = key.toLowerCase();
                // Set-Cookie 单独合并；长度/压缩相关头由当前响应重新生成
                if (lower === 'set-cookie' || lower === 'content-length' || lower === 'content-encoding') return;
                res._headers[key] = value;
            });
            const setCookies = (proxied.headers as any).getSetCookie?.() || [];
            if (setCookies.length > 0) res._cookies.push(...setCookies);
            res._body = await proxied.blob();
            res._sent = true;
        } catch (err) {
            logger.error('plugin route proxy failed', err as Error);
        }
    });

    app.listen(config.PORT, () => {
        logger.info(`DWOJ http worker listening on port ${config.PORT} (pid ${process.pid})`);
        reportReady({ port: config.PORT, pid: process.pid });
    });
}

main().catch(err => {
    logger.error('worker failed to start', err as Error);
    process.exit(1);
});
