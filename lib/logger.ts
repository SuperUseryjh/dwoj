import fs from 'fs';
import path from 'path';

const logDir: string = path.join(__dirname, '..', 'log');
fs.mkdirSync(logDir, { recursive: true });

const LOG_MAX_SIZE = 5 * 1024 * 1024;
const LOG_MAX_FILES = 5;
const logFilePath: string = path.join(logDir, 'app.log');

/** 生产默认只写文件；DWOJ_LOG_CONSOLE=1 时同时回显到控制台 */
const consoleEnabled: boolean = process.env.DWOJ_LOG_CONSOLE === '1';

let logStream: fs.WriteStream = fs.createWriteStream(logFilePath, { flags: 'a' });
let currentSize = 0;
try { currentSize = fs.statSync(logFilePath).size; } catch { /* 文件不存在 */ }

function rotate(): void {
    try { logStream.end(); } catch { /* ignore */ }
    for (let i = LOG_MAX_FILES - 1; i > 0; i--) {
        const src = i === 1 ? logFilePath : `${logFilePath}.${i - 1}`;
        const dst = `${logFilePath}.${i}`;
        if (fs.existsSync(src)) {
            try { fs.renameSync(src, dst); } catch { /* ignore */ }
        }
    }
    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    currentSize = 0;
}

function write(level: string, message: string, stack?: string): void {
    const line = `[${level}] ${new Date().toISOString()}: ${message}\n`;
    const extra = stack ? stack + '\n' : '';
    if (currentSize + Buffer.byteLength(line) + Buffer.byteLength(extra) > LOG_MAX_SIZE) {
        rotate();
    }
    logStream.write(line);
    if (stack) logStream.write(extra);
    currentSize += Buffer.byteLength(line) + Buffer.byteLength(extra);

    if (consoleEnabled) {
        const out = (line + (stack || '')).trimEnd();
        if (level === 'ERROR') console.error(out);
        else if (level === 'WARN') console.warn(out);
        else console.log(out);
    }
}

export interface Logger {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string, error?: Error) => void;
}

const logger: Logger = {
    info: (message: string) => write('INFO', message),
    warn: (message: string) => write('WARN', message),
    error: (message: string, error?: Error) => write('ERROR', message, error?.stack),
};

process.on('exit', () => {
    try { logStream.end(); } catch { /* ignore */ }
});

export default logger;
