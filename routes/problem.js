const express = require('express');
const router = express.Router();
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const { requireLogin, requireRole, ROLE_LV } = require('../middleware/auth');
const { db } = require('../lib/database');
const { runJudge } = require('../controllers/judge');
const logger = require('../lib/logger');

const upload = multer({ dest: config.UPLOAD_DIR });

// 新建题目页面
router.get('/problem/new', requireRole('super_user'), (req, res) => res.render('problem_edit', { problem: null }));

// 保存题目 (新建/编辑)
router.post('/problem/save', requireRole('super_user'), upload.single('testcaseZip'), (req, res) => {
    const { id, title, description, timeLimit } = req.body;
    
    if (id) { // 编辑
        db.get("SELECT * FROM problems WHERE id = ?", [id], (err, problem) => {
            if (err) {
                logger.error('Error fetching problem for edit', err);
                return res.status(500).send('服务器错误');
            }
            if (!problem) return res.status(404).send('题目不存在');

            if (req.user.role !== 'root' && problem.authorId !== req.user.id) {
                return res.status(403).send("无权修改此题目");
            }

            db.run("UPDATE problems SET title = ?, description = ?, timeLimit = ? WHERE id = ?", 
                [title, description, timeLimit, id], (err) => {
                if (err) {
                    logger.error('Error updating problem', err);
                    return res.status(500).send('服务器错误');
                }
                handleZipUpload(req, id, res);
            });
        });
    } else { // 新建
        db.run(`INSERT INTO problems (title, description, authorId, timeLimit) VALUES (?, ?, ?, ?)`, 
            [title, description, req.user.id, timeLimit], function(err) {
            if (err) {
                logger.error('Error inserting new problem', err);
                return res.status(500).send('服务器错误');
            }
            const newProblemId = this.lastID;
            handleZipUpload(req, newProblemId, res);
        });
    }
});

function handleZipUpload(req, problemId, res) {
    if (req.file) {
        try {
            const zip = new AdmZip(req.file.path);
            const targetDir = path.join(config.PROB_DIR, problemId.toString());
            fs.emptyDirSync(targetDir);
            zip.extractAllTo(targetDir, true);
            fs.unlinkSync(req.file.path);
            res.redirect('/');
        } catch (e) {
            logger.error('Error processing testcase zip', e);
            res.status(500).send('处理测试数据失败');
        }
    } else {
        res.redirect('/');
    }
}

// 编辑题目页面
router.get('/problem/edit/:id', requireRole('super_user'), (req, res) => {
    db.get("SELECT * FROM problems WHERE id = ?", [req.params.id], (err, problem) => {
        if (err) {
            logger.error('Error fetching problem for edit page', err);
            return res.status(500).send('服务器错误');
        }
        if (!problem) return res.status(404).send('题目不存在');
        res.render('problem_edit', { problem: problem });
    });
});

// 题目详情
router.get('/problem/:id', (req, res) => {
    db.get("SELECT * FROM problems WHERE id = ?", [req.params.id], (err, problem) => {
        if (err) {
            logger.error('Error fetching problem details', err);
            return res.status(500).send('服务器错误');
        }
        if(!problem) return res.status(404).send('Not Found');
        res.render('problem', { problem: problem });
    });
});

// 提交代码
router.post('/submit', requireLogin, (req, res) => {
    const { problemId, language, code } = req.body;
    const submissionTime = new Date().toLocaleString();
    db.run(`INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
        [problemId, req.user.id, req.user.username, language, code, "Pending", submissionTime, JSON.stringify([])], function(err) {
        if (err) {
            logger.error('Error inserting new submission', err);
            return res.status(500).send('服务器错误');
        }
        const newSubmissionId = this.lastID;
        // 异步评测，需要传入 pluginManager
        // runJudge(newSubmissionId, req.app.get('pluginManager')); 
        // 暂时注释掉，因为 pluginManager 还没注入到 app 对象
        res.redirect('/status');
    });
});

// 状态列表
router.get('/status', (req, res) => {
    db.all("SELECT * FROM submissions ORDER BY id DESC", [], (err, submissions) => {
        if (err) {
            logger.error('Error fetching submissions for status page', err);
            return res.status(500).send('服务器错误');
        }
        // Parse caseResults for each submission
        submissions.forEach(sub => {
            if (sub.caseResults) {
                try {
                    sub.caseResults = JSON.parse(sub.caseResults);
                } catch (e) {
                    logger.error(`Error parsing caseResults for submission ${sub.id}`, e);
                    sub.caseResults = [];
                }
            }
        });
        res.render('status', { submissions: submissions });
    });
});

// 提交详情
router.get('/submission/:id', requireLogin, (req, res) => {
    db.get("SELECT * FROM submissions WHERE id = ?", [req.params.id], (err, sub) => {
        if (err) {
            logger.error('Error fetching submission details', err);
            return res.status(500).send('服务器错误');
        }
        if (!sub) return res.status(404).send('提交不存在');

        // 只有自己或管理员能看源码
        db.get("SELECT role FROM users WHERE id = ?", [req.user.id], (err, userRole) => {
            if (err) {
                logger.error('Error fetching user role for submission view', err);
                return res.status(500).send('服务器错误');
            }
            if (sub.userId !== req.user.id && ROLE_LV[userRole.role] < ROLE_LV['super_user']) {
                return res.status(403).send("无权查看代码");
            }
            if (sub.caseResults) {
                try {
                    sub.caseResults = JSON.parse(sub.caseResults);
                } catch (e) {
                    logger.error(`Error parsing caseResults for submission ${sub.id}`, e);
                    sub.caseResults = [];
                }
            }
            res.render('submission', { sub: sub });
        });
    });
});

module.exports = router;
