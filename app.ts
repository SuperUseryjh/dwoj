import * as config from './config';
import { ensureDirSync } from './lib/fs-utils';
import { initDb } from './lib/database';
import logger from './lib/logger';
import { App } from './lib/bun-http';
import PluginSystem from './lib/plugin_system';
import { judgeQueue } from './lib/judge/queue';
import globalMiddleware from './middleware/global';
import createRoutes from './routes/index';

const app = new App();

// 初始化目录
ensureDirSync(config.DATA_DIR);
ensureDirSync(config.PROB_DIR);
ensureDirSync(config.UPLOAD_DIR);
ensureDirSync(config.PLUGINS_DIR);

// 初始化数据库
initDb();

// 设置视图引擎目录
app.set('view engine', 'ejs');

// 静态文件服务
app.use(app.static('public'));

// 初始化插件系统（插件直接注入 query/queryOne/execute 数据库接口）
const databaseModule = require('./lib/database');
const oj = { app, db: databaseModule, config, logger };
const pluginManager = new PluginSystem(config.PLUGINS_DIR, oj, config.ENABLED_BUILTIN_PLUGINS);
pluginManager.loadAll();
app.set('pluginManager', pluginManager);

// 全局中间件
app.use(globalMiddleware(pluginManager));

// 挂载路由
app.use(createRoutes(pluginManager));

// 判题队列：接管插件钩子并恢复未完成的提交
judgeQueue.setPluginManager(pluginManager);
judgeQueue.recover();

// 启动服务器
app.listen(config.PORT, () => {
    logger.info(`DWOJ ${config.CURRENT_VERSION} running on port ${config.PORT} (Bun + TypeScript)`);
});