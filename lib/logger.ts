import fs from 'fs';
import path from 'path';

// ============================================================
// DWOJ Logger
// 输出格式: [INFO][Module] 2026-06-19T10:00:00.000Z: message
// ============================================================

const logDir: string = path.join(__dirname, '..', 'log');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const getLogFileName = (): string => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `app_${year}${month}${day}_${hours}${minutes}${seconds}.log`;
};

const logFileName: string = getLogFileName();
const logFilePath: string = path.join(logDir, logFileName);
const logStream: fs.WriteStream = fs.createWriteStream(logFilePath, { flags: 'a' });

// 等级缩写映射（固定 4 字母）
const LEVEL: Record<string, string> = {
    info: 'INFO',
    warn: 'WARN',
    error: 'ERRO',
    dev: 'DEBG',
};

const isDev: boolean = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

export interface Logger {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string, error?: Error) => void;
    dev: (message: string) => void;
}

// 固定宽度对齐：`[LEVEL][Module]` 部分填充到该宽度，时间戳以此对齐
const HEADER_WIDTH = 18;

function formatMessage(level: string, module: string, message: string): string {
    const ts = new Date().toISOString();
    const header = `[${LEVEL[level]}][${module}]`;
    return `${header.padEnd(HEADER_WIDTH)} ${ts}: ${message}`;
}

/**
 * 创建一个带模块名的 Logger 实例
 * @param module 模块名称，输出时显示在 [INFO][模块名] 中
 */
export function createLogger(module: string): Logger {
    return {
        info: (message: string) => {
            const line = formatMessage('info', module, message) + '\n';
            console.log(line.trim());
            logStream.write(line);
        },
        warn: (message: string) => {
            const line = formatMessage('warn', module, message) + '\n';
            console.warn(line.trim());
            logStream.write(line);
        },
        error: (message: string, error?: Error) => {
            const line = formatMessage('error', module, message) + '\n';
            console.error(line.trim());
            logStream.write(line);
            if (error?.stack) {
                logStream.write(error.stack + '\n');
            }
        },
        dev: (message: string) => {
            if (!isDev) return;
            const line = formatMessage('dev', module, message);
            console.log(line);
        },
    };
}

/** 默认 logger（模块名: Boot） */
const logger: Logger = createLogger('Boot');

process.on('exit', () => {
    logStream.end();
});

export default logger;