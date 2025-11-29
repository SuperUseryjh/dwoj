const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const { db } = require('../lib/database');
const logger = require('../lib/logger');

async function runJudge(submissionId, pluginManager) {
    db.get("SELECT * FROM submissions WHERE id = ?", [submissionId], async (err, sub) => {
        if (err) {
            logger.error(`Error fetching submission ${submissionId} for judging`, err);
            return;
        }
        if (!sub) return;

        // Parse caseResults from string to array
        if (sub.caseResults) {
            try {
                sub.caseResults = JSON.parse(sub.caseResults);
            } catch (e) {
                logger.error(`Error parsing caseResults for submission ${submissionId}`, e);
                sub.caseResults = [];
            }
        } else {
            sub.caseResults = [];
        }

        // === Hook: beforeJudge ===
        pluginManager.emit('beforeJudge', sub);

        const probPath = path.join(config.PROB_DIR, sub.problemId.toString());
        if (!fs.existsSync(probPath)) {
            sub.status = "Data Error"; sub.result = "测试数据丢失";
            db.run("UPDATE submissions SET status = ?, result = ? WHERE id = ?", [sub.status, sub.result, sub.id], (err) => {
                if (err) logger.error(`Error updating submission ${sub.id} status`, err);
            });
            return;
        }

        const files = fs.readdirSync(probPath);
        const inputs = files.filter(f => f.endsWith('.in'));
        
        if (inputs.length === 0) {
            sub.status = "Data Error"; 
            db.run("UPDATE submissions SET status = ? WHERE id = ?", [sub.status, sub.id], (err) => {
                if (err) logger.error(`Error updating submission ${sub.id} status`, err);
            });
            return;
        }

        sub.status = "Running";
        sub.caseResults = [];
        let totalPassed = 0;

        try {
            for (const inputFile of inputs) {
                const baseName = path.basename(inputFile, '.in');
                const outputFile = baseName + '.out';
                
                if (!fs.existsSync(path.join(probPath, outputFile))) continue;
                const expected = fs.readFileSync(path.join(probPath, outputFile), 'utf-8').trim();
                const inputContent = fs.readFileSync(path.join(probPath, inputFile), 'utf-8');

                const userOutput = await executeCode(sub.language, sub.code, inputContent);
                
                if (userOutput.trim() === expected) {
                    totalPassed++;
                    sub.caseResults.push({ name: baseName, status: 'AC' });
                } else {
                    sub.caseResults.push({ name: baseName, status: 'WA' });
                }
            }

            if (totalPassed === inputs.length) sub.status = "Accepted";
            else sub.status = "Wrong Answer";

        } catch (err) {
            sub.status = "Runtime Error";
            sub.errorInfo = err.toString();
        }

        // === Hook: afterJudge ===
        pluginManager.emit('afterJudge', sub);
        
        db.run("UPDATE submissions SET status = ?, errorInfo = ?, caseResults = ? WHERE id = ?", 
            [sub.status, sub.errorInfo || null, JSON.stringify(sub.caseResults), sub.id], (err) => {
            if (err) logger.error(`Error updating submission ${sub.id} after judging`, err);
        });
    });
}

function executeCode(lang, code, input) {
    return new Promise((resolve, reject) => {
        const fileName = `sol_${Date.now()}_${Math.random().toString(36).substr(2)}.${lang === 'python' ? 'py' : 'js'}`;
        const filePath = path.join(config.UPLOAD_DIR, fileName);
        
        fs.writeFileSync(filePath, code);

        const isWin = process.platform === "win32";
        let cmd;
        if (lang === 'python') {
            cmd = isWin ? 'python' : 'python3'; 
        } else {
            cmd = 'node';
        }

        const child = spawn(cmd, [filePath]);
        
        let output = '', errStr = '';
        const timer = setTimeout(() => { 
            child.kill(); 
            reject('Time Limit Exceeded'); 
        }, 2000);

        child.stdin.write(input + '\n'); 
        child.stdin.end();

        child.stdout.on('data', c => output += c);
        child.stderr.on('data', c => errStr += c);
        
        child.on('close', (code) => {
            clearTimeout(timer);
            try { fs.unlinkSync(filePath); } catch(e) { logger.error(`Error deleting temp file ${filePath}`, e); }

            if (code !== 0) {
                reject(errStr || `Runtime Error (Process exited with code ${code})`);
            } else {
                resolve(output);
            }
        });
        
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(`System Error: ${err.message}`);
        });
    });
}

module.exports = { runJudge, executeCode };