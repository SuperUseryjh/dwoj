import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
const logger = createLogger('HotReload');

// ============================================================
// 开发模式热重载模块
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '..');

/** 需要监听的源文件目录 */
const WATCH_DIRS = [
    'routes',
    'controllers',
    'middleware',
    'lib',
    'config',
    'views',
];

/** 需要监听的项目根目录文件 */
const WATCH_ROOT_FILES = [
    'app.ts',
];

// 合法的热重载文件扩展名
const VALID_EXTENSIONS = new Set(['.ts', '.js', '.ejs']);

// 防抖定时器
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let watchers: fs.FSWatcher[] = [];

/**
 * 清除项目中所有模块的 require 缓存（排除 node_modules）
 */
function clearProjectCache(): void {
    const cacheKeys = Object.keys(require.cache);
    for (const key of cacheKeys) {
        // 只清除项目内部的模块，不清除 node_modules 和原生模块
        if (key.startsWith(PROJECT_ROOT) && !key.includes('node_modules')) {
            delete require.cache[key];
        }
    }
}

/**
 * 判断文件是否应该触发重载
 */
function shouldReload(filename: string | null): boolean {
    if (!filename) return false;
    // 跳过临时文件、隐藏文件、node_modules
    if (filename.endsWith('~')) return false;
    if (filename.startsWith('.')) return false;
    if (filename.includes('node_modules')) return false;
    if (filename.includes('bun.lock')) return false;

    const ext = path.extname(filename).toLowerCase();
    return VALID_EXTENSIONS.has(ext);
}

/**
 * 启动开发模式热重载
 * @param onReload 文件变化时需要执行的回调
 */
export function startHotReload(onReload?: (changedFile: string) => void): void {
    logger.dev('[HotReload] 开发模式热重载已启动');

    const onChange = (eventType: string, filename: string | null) => {
        if (!shouldReload(filename)) return;

        // 防抖：100ms 内的多次变更合并为一次重载
        if (reloadTimer) clearTimeout(reloadTimer);

        reloadTimer = setTimeout(() => {
            const changeMsg = filename
                ? `[HotReload] 检测到文件变更: ${filename}`
                : '[HotReload] 检测到文件变更';
            logger.dev(changeMsg);

            // 触发外部重载回调
            onReload?.(filename || 'unknown');
        }, 100);
    };

    // ---- 1. 监听源文件目录（递归） ----
    for (const dir of WATCH_DIRS) {
        const dirPath = path.join(PROJECT_ROOT, dir);
        if (!fs.existsSync(dirPath)) {
            logger.dev(`[HotReload] 目录不存在，跳过监听: ${dir}`);
            continue;
        }

        try {
            // Windows 支持 recursive: true
            const w = fs.watch(dirPath, { recursive: true }, onChange);
            watchers.push(w);
        } catch (err) {
            logger.error(`[HotReload] 监听目录失败: ${dir}`, err as Error);
        }
    }

    // ---- 2. 监听根目录文件 ----
    for (const file of WATCH_ROOT_FILES) {
        const filePath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(filePath)) continue;

        try {
            const w = fs.watch(filePath, onChange);
            watchers.push(w);
        } catch (_) {
            // 忽略根文件监听失败
        }
    }

    logger.dev(`[HotReload] 正在监视 ${watchers.length} 个监听器...`);

    // ---- 3. 清理回调 ----
    process.on('exit', stopHotReload);
}

/**
 * 停止热重载监听
 */
export function stopHotReload(): void {
    for (const w of watchers) {
        try { w.close(); } catch (_) { /* ignore */ }
    }
    watchers = [];
    if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
    }
}

/**
 * 清除项目中所有模块的 require 缓存（公开给 app.ts 调用）
 */
export { clearProjectCache };

/**
 * 执行热重载：清除缓存并重新导入模块
 * @param changedFile 变更的文件路径（仅用于日志）
 */
export function performReload(changedFile: string): void {
    logger.dev(`[HotReload] 正在重新加载模块... (${changedFile})`);

    try {
        // 1. 清除项目模块缓存
        clearProjectCache();

        // 2. 记录已加载的模块数量
        const remainingCount = Object.keys(require.cache).filter(
            k => k.startsWith(PROJECT_ROOT) && !k.includes('node_modules')
        ).length;

        logger.dev(`[HotReload] 缓存已清除，剩余 ${remainingCount} 个项目模块`);
        logger.dev('[HotReload] 重载完成，请手动重启服务器以应用更改');
    } catch (err) {
        logger.error('[HotReload] 重载过程中出错', err as Error);
    }
}