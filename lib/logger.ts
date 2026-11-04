import fs from 'fs';
import path from 'path';

/**
 * 日志。
 *
 * 统一格式：`[等级][模块] 时间 信息`，模块名最长 6 字符，
 * 后面用空格补齐，让所有日志的时间列对齐：
 *   [INFO][judge]  2026-11-04T10:14:04.410Z submission 1 -> Accepted (2 case(s))
 *   [ERRO][update] 2026-11-04T10:14:05.125Z Error checking for updates:
 *
 * 模块名由 logger 统一加：每个文件用 `createLogger('模块名')` 创建自己的
 * logger，业务代码里**不要**再手写 `[Judge]` 之类的标签。
 *
 * 多进程模式下 broker 会在启动时生成一个日志文件名写进 DWOJ_LOG_FILE，
 * 所有子进程追加写同一个文件；子进程的控制台输出通过 IPC 交给 broker 打印
 * （INFO 走 stdout，WARN/ERRO 走 stderr），避免 INFO 被终端染成红色。
 */

const logDir: string = path.join(__dirname, '..', 'log');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

/** 生成一个带时间戳的日志文件名（broker 启动时用一次） */
export function newLogFileName(): string {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `app_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.log`;
}

let logStream: fs.WriteStream | null = null;

function stream(): fs.WriteStream {
    if (!logStream) {
        const name = process.env.DWOJ_LOG_FILE || newLogFileName();
        logStream = fs.createWriteStream(path.join(logDir, name), { flags: 'a' });
    }
    return logStream;
}

/** 当前正在写的日志文件名 */
export function currentLogFileName(): string {
    return process.env.DWOJ_LOG_FILE || '';
}

/**
 * 等级一律 4 个字符（INFO / WARN / ERRO），这样等级列天然对齐；
 * 模块名最长 6 个字符，超出会被截断，两段一起决定时间戳的列位置。
 */
export const LOG_LEVELS = ['INFO', 'WARN', 'ERRO'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** 模块名最长 6 个字符，超出会被截断（保证时间列对齐） */
export const MAX_MODULE_LENGTH = 6;

const LEVEL_WIDTH = Math.max(...LOG_LEVELS.map(level => level.length));

/** `[等级][模块]` 的总宽度，用来把时间戳推到同一列 */
const PREFIX_WIDTH = LEVEL_WIDTH + MAX_MODULE_LENGTH + 4;

/** 把任意名字规整成合法的模块名：小写、只保留字母数字/下划线、最长 6 字符 */
export function normalizeModuleName(name: string): string {
    return String(name || '')
        .toLowerCase()
        .replace(/\.[jt]s$/, '')
        // 先截断再剔除非法字符，这样 "db-monitor" 会得到 "dbmon" 而不是 "dbmoni"
        .slice(0, MAX_MODULE_LENGTH)
        .replace(/[^a-z0-9_]/g, '');
}

function formatLine(level: LogLevel, module: string, message: string): string {
    const mod = normalizeModuleName(module) || 'app';
    const prefix = `[${level.padEnd(LEVEL_WIDTH)}][${mod}]`.padEnd(PREFIX_WIDTH, ' ');
    return `${prefix} ${new Date().toISOString()} ${message}`;
}

/**
 * 子进程把日志转交 broker 打印的出口；未设置时退回本进程的 console。
 * 由 `lib/ipc/node.ts` 在子进程启动时注入。
 */
let logSink: ((level: LogLevel, line: string) => void) | null = null;

export function setLogSink(sink: ((level: LogLevel, line: string) => void) | null): void {
    logSink = sink;
}

function emit(level: LogLevel, line: string): void {
    if (logSink) {
        logSink(level, line);
        return;
    }
    if (level === 'ERRO') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
}

function write(level: LogLevel, module: string, message: string): void {
    const line = formatLine(level, module, message);
    stream().write(line + '\n');
    emit(level, line);
}

export interface Logger {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string, error?: Error) => void;
}

/** 创建一个带模块名的 logger（模块名会自动加到每行日志前缀） */
export function createLogger(module: string): Logger {
    return {
        info: (message: string) => write('INFO', module, message),
        warn: (message: string) => write('WARN', module, message),
        error: (message: string, error?: Error) => {
            const detail = error?.stack ? '' : (error?.message ? ` (${error.message})` : '');
            write('ERRO', module, message + detail);
            if (error?.stack) {
                stream().write(error.stack + '\n');
            }
        },
    };
}

/** 默认 logger：模块名取进程角色（broker / db / http / judge） */
const logger: Logger = createLogger(process.env.DWOJ_PROCESS_ROLE || 'broker');

process.on('exit', () => {
    logStream?.end();
});

export default logger;
