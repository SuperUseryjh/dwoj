const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'log');

// 确保日志目录存在
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const getLogFileName = () => {
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

const logger = {
    info: (message) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[INFO] ${timestamp}: ${message}\n`;
        console.log(logMessage.trim()); // 同时输出到控制台
        logStream.write(logMessage);
    },
    error: (message, error) => {
        const timestamp = new Date().toISOString();
        const errorMessage = `[ERROR] ${timestamp}: ${message}\n`;
        console.error(errorMessage.trim()); // 同时输出到控制台
        logStream.write(errorMessage);
        if (error) {
            logStream.write(error.stack + '\n');
        }
    }
};

process.on('exit', () => {
    logStream.end();
});

module.exports = logger;
