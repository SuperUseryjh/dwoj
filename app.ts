import fs from 'fs-extra';
import path from 'path';

import * as config from './config';
import { initDb } from './lib/database';
import logger from './lib/logger';
import { App } from './lib/bun-http';
import PluginSystem from './lib/plugin_system';
import Updater from './lib/updater';
import globalMiddleware from './middleware/global';
import createRoutes from './routes/index';
import { initJudge } from './controllers/judge';
import { confirmUnisolatedJudge } from './lib/judge/risk_ack';

const app = new App();
const appRoot = path.resolve(__dirname);

async function main(): Promise<void> {
    // 初始化目录
    fs.ensureDirSync(config.DATA_DIR);
    fs.ensureDirSync(config.PROB_DIR);
    fs.ensureDirSync(config.UPLOAD_DIR);
    fs.ensureDirSync(config.PLUGINS_DIR);
    fs.ensureDirSync(config.JUDGE_DIR);

    // 初始化数据库（建表 / 迁移 / 默认数据）。
    // 数据库驱动可能是远程的 MySQL / PostgreSQL，因此必须 await。
    await initDb();

    // 设置视图引擎目录
    app.set('view engine', 'ejs');

    // 静态文件服务
    app.use(app.static('public'));

    // 初始化插件系统
    const database = require('./lib/database');
    const oj = { app, db: database.db, config, logger };
    const pluginManager = new PluginSystem(config.PLUGINS_DIR, oj, config.ENABLED_BUILTIN_PLUGINS);
    await pluginManager.loadAll();
    app.set('pluginManager', pluginManager);

    // 全局中间件
    app.use(globalMiddleware(pluginManager));

    // 挂载路由
    app.use(createRoutes(pluginManager));

    // 无隔离后端必须先由运维在控制台确认风险，否则拒绝启动。
    // 使用 v86 沙箱时这里直接通过，不产生任何交互。
    if (!confirmUnisolatedJudge()) {
        logger.error('启动已取消：评测机未启用隔离沙箱，且未完成风险确认。');
        process.exit(1);
    }

    // 初始化评测队列（同时重新排队上次未跑完的提交）
    await initJudge(pluginManager);

    // 启动服务器
    app.listen(config.PORT, async () => {
        logger.info(`DWOJ 3.0 running on port ${config.PORT} (Bun + TypeScript)`);

        // 检查并应用更新
        const updater = new Updater(appRoot);
        const updated = await updater.checkAndApplyUpdate();
        if (updated) {
            logger.info('Application updated. Please restart the server to load the new version.');
        }
    });
}

main().catch(err => {
    logger.error('Failed to start DWOJ', err as Error);
    process.exit(1);
});
