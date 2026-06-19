import fs from 'fs-extra';
import path from 'path';

// ============================================================
// DWOJ 服务器入口
// 用法: bun app.ts           — 生产模式
//        bun app.ts --dev    — 开发模式（带热重载）
// ============================================================

const isDev = process.argv.includes('--dev');

if (isDev) {
    process.env.NODE_ENV = 'development';
}

/**
 * 引导启动服务器（使用 require 动态加载，以支持热重载缓存清除）
 */
async function main() {
    // 项目模块使用 require 以便热重载时清除缓存
    const config = require('./config');
    const { initDb } = require('./lib/database');
    const { createLogger } = require('./lib/logger');
    const logger = createLogger('Boot');
    const { App } = require('./lib/bun-http');
    const PluginSystem = require('./lib/plugin_system').default;
    const Updater = require('./lib/updater').default;
    const globalMiddleware = require('./middleware/global').default;
    const createRoutes = require('./routes/index').default;

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
    const server = app.listen(config.PORT, async () => {
        logger.info(`DWOJ 3.0 running on port ${config.PORT} (${isDev ? 'development' : 'production'} mode)`);

        if (!isDev) {
            // 生产模式检查更新
            const updater = new Updater(appRoot);
            const updated = await updater.checkAndApplyUpdate();
            if (updated) {
                logger.info('Application updated. Please restart the server to load the new version.');
            }
        }
    });

    return { app, server, logger, config };
}

// ---- 启动 ----

let currentServer: any = null;

main().then(({ server }) => {
    currentServer = server;

    if (isDev) {
        // 延迟启动热重载，确保服务器完全就绪
        setTimeout(() => {
            try {
                const { startHotReload, clearProjectCache } = require('./lib/hot-reload');

                startHotReload((changedFile: string) => {
                    console.log('');
                    console.log('══════════════════════════════════════════════════');
                    console.log(`  🔄 检测到文件变更 [${changedFile}]`);
                    console.log('  正在执行热重载...');
                    console.log('══════════════════════════════════════════════════');
                    console.log('');

                    // 关闭旧服务器
                    if (currentServer && typeof currentServer.stop === 'function') {
                        try { currentServer.stop(); } catch (_) { /* ignore */ }
                    }

                    // 清除项目模块缓存
                    clearProjectCache();

                    // 重新引导
                    main().then(({ server }) => {
                        currentServer = server;
                        console.log('');
                        console.log('══════════════════════════════════════════════════');
                        console.log('  ✅ 热重载完成！');
                        console.log('══════════════════════════════════════════════════');
                        console.log('');
                    }).catch((err: Error) => {
                        console.error('══════════════════════════════════════════════════');
                        console.error('  ❌ 热重载失败:', err.message);
                        console.error('══════════════════════════════════════════════════');
                    });
                });
            } catch (err) {
                console.error('[HotReload] 初始化热重载失败:', err);
            }
        }, 500);
    }
}).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});