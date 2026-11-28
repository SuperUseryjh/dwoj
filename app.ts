import fs from 'fs-extra';
import * as config from './config';
import { createLogger, newLogFileName } from './lib/logger';
import { printBanner } from './lib/banner';
import { confirmUnisolatedJudge } from './lib/judge/risk_ack';
import { Broker } from './lib/ipc/broker';

const logger = createLogger('broker');

// 子进程在关闭瞬间断开管道时，Bun 会把 EPIPE 作为 unhandledRejection 抛出
// （FileSink 的写入错误只有 flush 时才可见）。这是正常竞态，不应该让
// Ctrl+C 关闭变成 exit 1；其它 rejection 仍然打印出来，避免掩盖真正的 bug。
process.on('unhandledRejection', (reason: any) => {
    const code = reason?.code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END') return;
    logger.error('unhandled rejection', reason as Error);
});

/**
 * DWOJ 入口。
 *
 * 默认是**多进程模式**：本进程只作为 broker（IPC 连接器），负责
 *   - 拉起 db / plugin / http / judge 四个子进程，并等待它们就绪
 *   - 转发子进程之间的消息（星型拓扑）
 *   - 子进程崩溃后按退避策略重启，并通知其它进程
 *   - 优雅关闭
 *
 * 设置 `DWOJ_SINGLE_PROCESS=1` 可以退回单进程模式（调试/无 IPC 环境）。
 */

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
        if (stopping) {
            // 第二次 Ctrl+C：不再等待，强制退出（仍然 0，避免被脚本误判为失败）
            logger.warn('forced shutdown');
            process.exit(0);
        }
        stopping = true;
        logger.info(`received ${signal}, shutting down`);
        try {
            await broker.stop();
        } catch (err) {
            logger.error('shutdown failed', err as Error);
        }
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
}

// ============================================================
// 单进程模式（DWOJ_SINGLE_PROCESS=1，调试用）
// ============================================================

async function runSingleProcess(): Promise<void> {
    const { App } = await import('./lib/bun-http');
    const { initDb } = await import('./lib/database');
    const { PluginManager } = await import('./lib/plugin/manager');
    const { createPluginHost } = await import('./lib/plugin/host');
    const { createPluginRouteGuard } = await import('./lib/plugin/routes');
    const { default: globalMiddleware } = await import('./middleware/global');
    const { initJudge } = await import('./controllers/judge');
    const { loadJudgeBackendPlugins } = await import('./lib/builtin_plugins/judge_backends');

    ensureDirs();
    await initDb();

    const app = new App();
    app.use(app.static('public'));

    const manager = new PluginManager(config.PLUGINS_DIR, {
        app,
        builtinEnabled: config.ENABLED_BUILTIN_PLUGINS,
    });
    // 单进程模式不需要 IPC，直接用内存里的插件管理器
    const pluginManager = createPluginHost(manager);

    // 主应用同时承载核心路由与插件路由：守卫只作用于带插件元数据的路由，
    // 核心路由（如 /admin/*）继续走它们自己的 requireRole。
    app.setRouteGuard(createPluginRouteGuard({ enforceAll: false }));

    app.use(globalMiddleware(pluginManager));

    // 核心路由先注册，插件路由由 manager 挂在稳定的 hostRouter 上（排在核心之后）
    await manager.loadAll();

    if (!confirmUnisolatedJudge()) {
        logger.error('启动已取消：评测机未启用隔离沙箱，且未完成风险确认。');
        process.exit(1);
    }

    loadJudgeBackendPlugins();
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
    });
}

(singleProcess ? runSingleProcess() : runBroker()).catch(err => {
    logger.error('Failed to start DWOJ', err as Error);
    process.exit(1);
});
