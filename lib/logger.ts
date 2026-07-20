import fs from 'fs';
import path from 'path';

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

const isDev = process.argv.includes('--dev');

function padModuleName(name: string): string {
    const maxLen = 8;
    if (name.length > maxLen) {
        return name.slice(0, maxLen);
    }
    const totalPad = maxLen - name.length;
    const leftPad = Math.floor(totalPad / 2);
    const rightPad = totalPad - leftPad;
    return ' '.repeat(leftPad) + name + ' '.repeat(rightPad);
}

function getTimeString(): string {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

export interface Logger {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string, error?: Error) => void;
    debug: (message: string) => void;
}

export function createLogger(moduleName: string): Logger {
    const paddedName = padModuleName(moduleName);

    const log = (level: string, message: string, error?: Error) => {
        const time = new Date().toISOString();
        const logMessage = `[${level}][${paddedName}]${time} ${message}\n`;

        switch (level) {
            case 'INFO':
                console.log(logMessage.trim());
                break;
            case 'WARN':
                console.warn(logMessage.trim());
                break;
            case 'ERRO':
                console.error(logMessage.trim());
                break;
            case 'DEBG':
                if (!isDev) return;
                console.log(logMessage.trim());
                break;
        }
        logStream.write(logMessage);
        if (error?.stack) {
            logStream.write(error.stack + '\n');
        }
    };

    return {
        info: (message: string) => log('INFO', message),
        warn: (message: string) => log('WARN', message),
        error: (message: string, error?: Error) => log('ERRO', message, error),
        debug: (message: string) => log('DEBG', message),
    };
}

const logger = createLogger('App');

process.on('exit', () => {
    logStream.end();
});

export default logger;
