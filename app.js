const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const fs = require('fs-extra');
const path = require('path');

const config = require('./config');
const { db, initDb } = require('./lib/database');
const logger = require('./lib/logger');
const PluginSystem = require('./lib/plugin_system');
const globalMiddleware = require('./middleware/global');
const createRoutes = require('./routes');

const app = express();

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
const pluginManager = new PluginSystem(config.PLUGINS_DIR, db, app); // 传入 db
pluginManager.loadAll();
app.set('pluginManager', pluginManager); // 将 pluginManager 存储在 app 对象中，以便在其他地方访问

// 全局中间件
app.use(globalMiddleware(pluginManager));

// 挂载路由
app.use(createRoutes(pluginManager));

// 启动服务器
app.listen(config.PORT, () => {
    logger.info(`DWOJ 2.0 running on port ${config.PORT}`);
});