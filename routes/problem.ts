import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import path from 'path';
import config from '../config';
import { requireLogin, requireRole, ROLE_LV } from '../middleware/auth';
import db from '../lib/database';
import { runJudge } from '../controllers/judge';
import logger from '../lib/logger';

const router = express.Router();
const upload = multer({ dest: config.UPLOAD_DIR });

router.get('/problem/new', requireRole('super_user'), (req, res) => res.render('problem_edit', { problem: null }));

router.post('/problem/save', requireRole('super_user'), upload.single('testcaseZip'), (req, res) => {
    const { id, title, description, timeLimit } = req.body;

    if (id) {
        db.get("SELECT * FROM problems WHERE id = ?", [id], (err: Error, problem: any) => {
            if (err) {
                logger.error('Error fetching problem for edit', err);
                return res.status(500).send('服务器错误');
            }
            if (!problem) return res.status(404).send('题目不存在');

            if (req.user!.role !== 'root' && problem.authorId !== req.user!.id) {
                return res.status(403).send("无权修改此题目");
            }

            db.run("UPDATE problems SET title = ?, description = ?, timeLimit = ? WHERE id = ?",
                [title, description, timeLimit, id], (err: Error) => {
                    if (err) {
                        logger.error('Error updating problem', err);
                        return res.status(500).send('服务器错误');
                    }
                    handleZipUpload(req, id, res);
                });
        });
    } else {
        db.run(`INSERT INTO problems (title, description, authorId, timeLimit) VALUES (?, ?, ?, ?)`,
            [title, description, req.user!.id, timeLimit], function(err: Error) {
                if (err) {
                    logger.error('Error inserting new problem', err);
                    return res.status(500).send('服务器错误');
                }
                const newProblemId = this.lastID;
                handleZipUpload(req, newProblemId, res);
            });
    }
});

const handleZipUpload = (req: express.Request, problemId: number, res: express.Response): void => {
    if (req.file) {
        try {
            const zip = new AdmZip(req.file.path);
            const targetDir = path.join(config.PROB_DIR, problemId.toString());
            fs.emptyDirSync(targetDir);
            zip.extractAllTo(targetDir, true);
            fs.unlinkSync(req.file.path);
            res.redirect('/');
        } catch (e) {
            logger.error('Error processing testcase zip', e as Error);
            res.status(500).send('处理测试数据失败');
        }
    } else {
        res.redirect('/');
    }
};

router.get('/problem/edit/:id', requireRole('super_user'), (req, res) => {
    db.get("SELECT * FROM problems WHERE id = ?", [req.params.id], (err: Error, problem: any) => {
        if (err) {
            logger.error('Error fetching problem for edit page', err);
            return res.status(500).send('服务器错误');
        }
        if (!problem) return res.status(404).send('题目不存在');
        res.render('problem_edit', { problem: problem });
    });
});

router.get('/problem/:id', (req, res) => {
    db.get("SELECT * FROM problems WHERE id = ?", [req.params.id], (err: Error, problem: any) => {
        if (err) {
            logger.error('Error fetching problem details', err);
            return res.status(500).send('服务器错误');
        }
        if (!problem) return res.status(404).send('Not Found');
        res.render('problem', { problem: problem });
    });
});

router.post('/submit', requireLogin, (req, res) => {
    const { problemId, language, code } = req.body;
    const submissionTime = new Date().toLocaleString();
    db.run(`INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [problemId, (req.user! as any).id, (req.user! as any).username, language, code, "Pending", submissionTime, JSON.stringify([])], function(err: Error) {
            if (err) {
                logger.error('Error inserting new submission', err);
                return res.status(500).send('服务器错误');
            }
            const newSubmissionId = this.lastID;
            res.redirect('/status');
        });
});

router.get('/status', (req, res) => {
    db.all("SELECT * FROM submissions ORDER BY id DESC", [], (err: Error, submissions: any[]) => {
        if (err) {
            logger.error('Error fetching submissions for status page', err);
            return res.status(500).send('服务器错误');
        }
        submissions.forEach(sub => {
            if (sub.caseResults) {
                try {
                    sub.caseResults = JSON.parse(sub.caseResults);
                } catch (e) {
                    logger.error(`Error parsing caseResults for submission ${sub.id}`, e as Error);
                    sub.caseResults = [];
                }
            }
        });
        res.render('status', { submissions: submissions });
    });
});

router.get('/submission/:id', requireLogin, (req, res) => {
    db.get("SELECT * FROM submissions WHERE id = ?", [req.params.id], (err: Error, sub: any) => {
        if (err) {
            logger.error('Error fetching submission details', err);
            return res.status(500).send('服务器错误');
        }
        if (!sub) return res.status(404).send('提交不存在');

        db.get("SELECT role FROM users WHERE id = ?", [req.user!.id], (err: Error, userRole: any) => {
            if (err) {
                logger.error('Error fetching user role for submission view', err);
                return res.status(500).send('服务器错误');
            }
            if (sub.userId !== req.user!.id && ROLE_LV[userRole.role] < ROLE_LV['super_user']) {
                return res.status(403).send("无权查看代码");
            }
            if (sub.caseResults) {
                try {
                    sub.caseResults = JSON.parse(sub.caseResults);
                } catch (e) {
                    logger.error(`Error parsing caseResults for submission ${sub.id}`, e as Error);
                    sub.caseResults = [];
                }
            }
            res.render('submission', { sub: sub });
        });
    });
});

export default router;
