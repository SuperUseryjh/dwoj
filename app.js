const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const fs = require('fs-extra');
const path = require('path');

const config = require('./config');
const { db, initDb } = require('./lib/database');
const logger = require('./lib/logger');
const PluginSystem = require('./lib/plugin_system');
const Updater = require('./lib/updater'); // 引入 Updater
const globalMiddleware = require('./middleware/global');
const createRoutes = require('./routes');

const app = express();
const appRoot = path.resolve(__dirname); // 获取应用程序根目录

// 初始化目录
fs.ensureDirSync(config.DATA_DIR);
fs.ensureDirSync(config.PROB_DIR);
fs.ensureDirSync(config.UPLOAD_DIR);
fs.ensureDirSync(config.PLUGINS_DIR);

// 初始化数据库
initDb();

// 设置视图引擎和静态文件
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// 初始化插件系统
const oj = { app, db, config, logger }; // Create the oj object
const pluginManager = new PluginSystem(config.PLUGINS_DIR, oj); // Pass the oj object
pluginManager.loadAll();
app.set('pluginManager', pluginManager); // 将 pluginManager 存储在 app 对象中，以便在其他地方访问

// 全局中间件
app.use(globalMiddleware(pluginManager));

// 挂载路由
app.use(createRoutes(pluginManager));

// 启动服务器
app.listen(config.PORT, async () => { // 将 app.listen 回调函数改为 async
    logger.info(`DWOJ 2.0 running on port ${config.PORT}`);

    // 检查并应用更新
    const updater = new Updater(appRoot);
    const updated = await updater.checkAndApplyUpdate();
    if (updated) {
        logger.info('Application updated. Please restart the server to load the new version.');
        // 可以在这里选择退出进程，让外部进程管理器重启应用
        // process.exit(0);
    }
});