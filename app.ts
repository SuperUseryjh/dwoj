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

const app = new App();
const appRoot = path.resolve(__dirname);

// 初始化目录
fs.ensureDirSync(config.DATA_DIR);
fs.ensureDirSync(config.PROB_DIR);
fs.ensureDirSync(config.UPLOAD_DIR);
fs.ensureDirSync(config.PLUGINS_DIR);

// 初始化数据库
initDb();

// 设置视图引擎目录
app.set('view engine', 'ejs');

// 静态文件服务
app.use(app.static('public'));

// 初始化插件系统
const oj = { app, db: require('./lib/database').db, config, logger };
const pluginManager = new PluginSystem(config.PLUGINS_DIR, oj, config.ENABLED_BUILTIN_PLUGINS);
pluginManager.loadAll();
app.set('pluginManager', pluginManager);

// 全局中间件
app.use(globalMiddleware(pluginManager));

// 挂载路由
app.use(createRoutes(pluginManager));

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