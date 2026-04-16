import fs from 'fs';
import path from 'path';
import { Logger } from '../types';

const logDir = path.join(__dirname, '..', 'log');

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

const logFileName = getLogFileName();
const logFilePath = path.join(logDir, logFileName);

const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

const logger: Logger = {
    info: (message: string) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[INFO] ${timestamp}: ${message}\n`;
        console.log(logMessage.trim());
        logStream.write(logMessage);
    },
    warn: (message: string) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[WARN] ${timestamp}: ${message}\n`;
        console.warn(logMessage.trim());
        logStream.write(logMessage);
    },
    error: (message: string, error?: Error) => {
        const timestamp = new Date().toISOString();
        const errorMessage = `[ERROR] ${timestamp}: ${message}\n`;
        console.error(errorMessage.trim());
        logStream.write(errorMessage);
        if (error) {
            logStream.write(error.stack + '\n');
        }
    }
};

process.on('exit', () => {
    logStream.end();
});

export default logger;
