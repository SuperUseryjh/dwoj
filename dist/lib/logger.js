"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logDir = path_1.default.join(__dirname, '..', 'log');
if (!fs_1.default.existsSync(logDir)) {
    fs_1.default.mkdirSync(logDir);
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
const logFilePath = path_1.default.join(logDir, logFileName);
const logStream = fs_1.default.createWriteStream(logFilePath, { flags: 'a' });
const logger = {
    info: (message) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[INFO] ${timestamp}: ${message}\n`;
        console.log(logMessage.trim());
        logStream.write(logMessage);
    },
    warn: (message) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[WARN] ${timestamp}: ${message}\n`;
        console.warn(logMessage.trim());
        logStream.write(logMessage);
    },
    error: (message, error) => {
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
exports.default = logger;
//# sourceMappingURL=logger.js.map