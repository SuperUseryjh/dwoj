"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeCode = exports.runJudge = void 0;
const child_process_1 = require("child_process");
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const config_1 = __importDefault(require("../config"));
const database_1 = __importDefault(require("../lib/database"));
const logger_1 = __importDefault(require("../lib/logger"));
const runJudge = async (submissionId, pluginManager) => {
    database_1.default.get("SELECT * FROM submissions WHERE id = ?", [submissionId], async (err, sub) => {
        if (err) {
            logger_1.default.error(`Error fetching submission ${submissionId} for judging`, err);
            return;
        }
        if (!sub)
            return;
        if (sub.caseResults) {
            try {
                sub.caseResults = JSON.parse(sub.caseResults);
            }
            catch (e) {
                logger_1.default.error(`Error parsing caseResults for submission ${submissionId}`, e);
                sub.caseResults = [];
            }
        }
        else {
            sub.caseResults = [];
        }
        pluginManager.emit('beforeJudge', sub);
        const probPath = path_1.default.join(config_1.default.PROB_DIR, sub.problemId.toString());
        if (!fs_extra_1.default.existsSync(probPath)) {
            sub.status = "Data Error";
            sub.result = "测试数据丢失";
            database_1.default.run("UPDATE submissions SET status = ?, result = ? WHERE id = ?", [sub.status, sub.result, sub.id], (err) => {
                if (err)
                    logger_1.default.error(`Error updating submission ${sub.id} status`, err);
            });
            return;
        }
        const files = fs_extra_1.default.readdirSync(probPath);
        const inputs = files.filter(f => f.endsWith('.in'));
        if (inputs.length === 0) {
            sub.status = "Data Error";
            database_1.default.run("UPDATE submissions SET status = ? WHERE id = ?", [sub.status, sub.id], (err) => {
                if (err)
                    logger_1.default.error(`Error updating submission ${sub.id} status`, err);
            });
            return;
        }
        sub.status = "Running";
        sub.caseResults = [];
        let totalPassed = 0;
        try {
            for (const inputFile of inputs) {
                const baseName = path_1.default.basename(inputFile, '.in');
                const outputFile = baseName + '.out';
                if (!fs_extra_1.default.existsSync(path_1.default.join(probPath, outputFile)))
                    continue;
                const expected = fs_extra_1.default.readFileSync(path_1.default.join(probPath, outputFile), 'utf-8').trim();
                const inputContent = fs_extra_1.default.readFileSync(path_1.default.join(probPath, inputFile), 'utf-8');
                const userOutput = await (0, exports.executeCode)(sub.language, sub.code, inputContent);
                if (userOutput.trim() === expected) {
                    totalPassed++;
                    sub.caseResults.push({ name: baseName, status: 'AC' });
                }
                else {
                    sub.caseResults.push({ name: baseName, status: 'WA' });
                }
            }
            if (totalPassed === inputs.length)
                sub.status = "Accepted";
            else
                sub.status = "Wrong Answer";
        }
        catch (err) {
            sub.status = "Runtime Error";
            sub.errorInfo = err.toString();
        }
        pluginManager.emit('afterJudge', sub);
        database_1.default.run("UPDATE submissions SET status = ?, errorInfo = ?, caseResults = ? WHERE id = ?", [sub.status, sub.errorInfo || null, JSON.stringify(sub.caseResults), sub.id], (err) => {
            if (err)
                logger_1.default.error(`Error updating submission ${sub.id} after judging`, err);
        });
    });
};
exports.runJudge = runJudge;
const executeCode = (lang, code, input) => {
    return new Promise((resolve, reject) => {
        const extension = lang === 'python' ? 'py' : 'js';
        const fileName = `sol_${Date.now()}_${Math.random().toString(36).substr(2)}.${extension}`;
        const filePath = path_1.default.join(config_1.default.UPLOAD_DIR, fileName);
        fs_extra_1.default.writeFileSync(filePath, code);
        const isWin = process.platform === "win32";
        let cmd;
        if (lang === 'python') {
            cmd = isWin ? 'python' : 'python3';
        }
        else {
            cmd = 'node';
        }
        const child = (0, child_process_1.spawn)(cmd, [filePath]);
        let output = '', errStr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject('Time Limit Exceeded');
        }, 2000);
        child.stdin.write(input + '\n');
        child.stdin.end();
        child.stdout.on('data', (c) => output += c.toString());
        child.stderr.on('data', (c) => errStr += c.toString());
        child.on('close', (code) => {
            clearTimeout(timer);
            try {
                fs_extra_1.default.unlinkSync(filePath);
            }
            catch (e) {
                logger_1.default.error(`Error deleting temp file ${filePath}`, e);
            }
            if (code !== 0) {
                reject(errStr || `Runtime Error (Process exited with code ${code})`);
            }
            else {
                resolve(output);
            }
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(`System Error: ${err.message}`);
        });
    });
};
exports.executeCode = executeCode;
exports.default = { runJudge: exports.runJudge, executeCode: exports.executeCode };
//# sourceMappingURL=judge.js.map