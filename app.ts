import fs from 'fs-extra';
import path from 'path';
import * as config from './config';
import { createLogger, newLogFileName } from './lib/logger';
import { printBanner } from './lib/banner';
import { confirmUnisolatedJudge } from './lib/judge/risk_ack';
import { Broker } from './lib/ipc/broker';
import Updater from './lib/updater';

const logger = createLogger('broker');

/**
 * DWOJ 入口。
 *
 * 默认是**多进程模式**：本进程只作为 broker（IPC 连接器），负责
 *   - 拉起 db / http / judge 三个子进程，并等待它们就绪
 *   - 转发子进程之间的消息（星型拓扑）
 *   - 子进程崩溃后按退避策略重启，并通知其它进程
 *   - 优雅关闭
 *
 * 设置 `DWOJ_SINGLE_PROCESS=1` 可以退回单进程模式（调试/无 IPC 环境）。
 */

const appRoot = path.resolve(__dirname);
const singleProcess = ['1', 'true', 'yes'].includes(
    String(process.env.DWOJ_SINGLE_PROCESS || '').toLowerCase(),
);

// 多进程模式下由本进程决定日志文件，子进程继承
if (!singleProcess && !process.env.DWOJ_LOG_FILE) {
    process.env.DWOJ_LOG_FILE = newLogFileName();
}

function ensureDirs(): void {
    fs.ensureDirSync(config.DATA_DIR);
    fs.ensureDirSync(config.PROB_DIR);
    fs.ensureDirSync(config.UPLOAD_DIR);
    fs.ensureDirSync(config.PLUGINS_DIR);
    fs.ensureDirSync(config.JUDGE_DIR);
}

// ============================================================
// 多进程模式（默认）
// ============================================================

async function runBroker(): Promise<void> {
    ensureDirs();

    // 无隔离后端必须先由运维在控制台确认风险，否则拒绝启动。
    // 使用 v86 沙箱时这里直接通过，不产生任何交互。
    if (!confirmUnisolatedJudge()) {
        logger.error('启动已取消：评测机未启用隔离沙箱，且未完成风险确认。');
        process.exit(1);
    }

    const broker = new Broker();
    let stopping = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (stopping) return;
        stopping = true;
        logger.info(`received ${signal}, shutting down`);
        await broker.stop();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await broker.start();

    // 启动完成（沙箱客户机还在后台冷启动，不影响这里）
    const judgeInfo = broker.info('judge');
    printBanner({
        version: config.CURRENT_VERSION,
        port: config.PORT,
        mode: 'multi-process',
        backend: judgeInfo.backend,
        languages: judgeInfo.languages,
        pid: process.pid,
        logFile: process.env.DWOJ_LOG_FILE,
    });
    logger.info(`DWOJ ${config.CURRENT_VERSION} running in multi-process mode on port ${config.PORT} ` +
        `(broker pid ${process.pid}, backend=${judgeInfo.backend ?? 'unknown'}, log ${process.env.DWOJ_LOG_FILE})`);

    // 检查并应用更新（管理员功能；更新后需要重启才会生效）
    const updater = new Updater(appRoot);
    const updated = await updater.checkAndApplyUpdate();
    if (updated) {
        logger.info('Application updated. Please restart the server to load the new version.');
    }
}

// ============================================================
// 单进程模式（DWOJ_SINGLE_PROCESS=1，调试用）
// ============================================================

async function runSingleProcess(): Promise<void> {
    const { App } = await import('./lib/bun-http');
    const { initDb } = await import('./lib/database');
    const { default: PluginSystem } = await import('./lib/plugin_system');
    const { default: globalMiddleware } = await import('./middleware/global');
    const { default: createRoutes } = await import('./routes/index');
    const { initJudge } = await import('./controllers/judge');

    ensureDirs();
    await initDb();

    const app = new App();
    app.set('view engine', 'ejs');
    app.use(app.static('public'));

    const database = require('./lib/database');
    const oj = { app, db: database.db, config, logger };
    const pluginManager = new PluginSystem(config.PLUGINS_DIR, oj, config.ENABLED_BUILTIN_PLUGINS);
    await pluginManager.loadAll();
    app.set('pluginManager', pluginManager);

    app.use(globalMiddleware(pluginManager));
    app.use(createRoutes(pluginManager));

    if (!confirmUnisolatedJudge()) {
        logger.error('启动已取消：评测机未启用隔离沙箱，且未完成风险确认。');
        process.exit(1);
    }

    await initJudge(pluginManager);

    app.listen(config.PORT, async () => {
        const { getBackend } = await import('./lib/judge/backend');
        const { getSupportedLanguages } = await import('./lib/judge/judge_client');
        printBanner({
            version: config.CURRENT_VERSION,
            port: config.PORT,
            mode: 'single-process',
            backend: getBackend().name,
            languages: getSupportedLanguages(),
            pid: process.pid,
            logFile: process.env.DWOJ_LOG_FILE,
        });
        logger.info(`DWOJ ${config.CURRENT_VERSION} running on port ${config.PORT} (single-process mode)`);
        const updater = new Updater(appRoot);
        const updated = await updater.checkAndApplyUpdate();
        if (updated) {
            logger.info('Application updated. Please restart the server to load the new version.');
        }
    });
}

(singleProcess ? runSingleProcess() : runBroker()).catch(err => {
    logger.error('Failed to start DWOJ', err as Error);
    process.exit(1);
});
