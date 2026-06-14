import { Router, UploadHandler } from '../lib/bun-http';
import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import path from 'path';
import * as config from '../config';
import { requireLogin, requireRole, ROLE_LV } from '../middleware/auth';
import { Problem, Submission, User, query, queryOne, execute } from '../lib/database';
import logger from '../lib/logger';

const router = new Router();
const upload = new UploadHandler({ dest: config.UPLOAD_DIR });

router.get('/problem/new', requireRole('super_user'), (req, res, next) => {
    res.render('problem_edit', { problem: null });
});

router.post('/problem/save', requireRole('super_user'), upload.single('testcaseZip'), (req, res, next) => {
    const { id, title, description, timeLimit } = req.body;

    try {
        if (id) {
            const problem = queryOne<Problem>("SELECT * FROM problems WHERE id = ?", [id]);
            if (!problem) {
                res.status(404).send('题目不存在');
                return;
            }

            if (req.user.role !== 'root' && problem.authorId !== req.user.id) {
                res.status(403).send("无权修改此题目");
                return;
            }

            execute("UPDATE problems SET title = ?, description = ?, timeLimit = ? WHERE id = ?",
                [title, description, timeLimit, id]);
            handleZipUpload(req, Number(id), res);
        } else {
            const result = execute(`INSERT INTO problems (title, description, authorId, timeLimit) VALUES (?, ?, ?, ?)`,
                [title, description, req.user.id, timeLimit]);
            const newProblemId = Number(result.lastInsertRowid);
            handleZipUpload(req, newProblemId, res);
        }
    } catch (err) {
        logger.error('Error saving problem', err as Error);
        res.status(500).send('服务器错误');
    }
});

function handleZipUpload(req: any, problemId: number, res: any): void {
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
}

router.get('/problem/edit/:id', requireRole('super_user'), (req, res, next) => {
    try {
        const problem = queryOne<Problem>("SELECT * FROM problems WHERE id = ?", [req.params.id]);
        if (!problem) {
            res.status(404).send('题目不存在');
            return;
        }
        res.render('problem_edit', { problem });
    } catch (err) {
        logger.error('Error fetching problem for edit page', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/problem/:id', (req, res, next) => {
    try {
        const problem = queryOne<Problem>("SELECT * FROM problems WHERE id = ?", [req.params.id]);
        if (!problem) {
            res.status(404).send('Not Found');
            return;
        }
        res.render('problem', { problem });
    } catch (err) {
        logger.error('Error fetching problem details', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.post('/submit', requireLogin, (req, res, next) => {
    const { problemId, language, code } = req.body;
    const submissionTime = new Date().toLocaleString();
    try {
        const result = execute(`INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [problemId, req.user.id, req.user.username, language, code, "Pending", submissionTime, JSON.stringify([])]);
        res.redirect('/status');
    } catch (err) {
        logger.error('Error inserting new submission', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/status', (req, res, next) => {
    try {
        const submissions = query<any>("SELECT * FROM submissions ORDER BY id DESC");
        submissions.forEach(sub => {
            if (sub.caseResults) {
                try {
                    sub.caseResults = JSON.parse(sub.caseResults);
                } catch (_) {
                    sub.caseResults = [];
                }
            }
        });
        res.render('status', { submissions });
    } catch (err) {
        logger.error('Error fetching submissions for status page', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/submission/:id', requireLogin, (req, res, next) => {
    try {
        const sub = queryOne<any>("SELECT * FROM submissions WHERE id = ?", [req.params.id]);
        if (!sub) {
            res.status(404).send('提交不存在');
            return;
        }

        const userRole = queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [req.user.id]);
        if (sub.userId !== req.user.id && (ROLE_LV[userRole?.role || 'default'] ?? -1) < (ROLE_LV['super_user'] ?? 0)) {
            res.status(403).send("无权查看代码");
            return;
        }
        if (sub.caseResults) {
            try {
                sub.caseResults = JSON.parse(sub.caseResults);
            } catch (_) {
                sub.caseResults = [];
            }
        }
        res.render('submission', { sub });
    } catch (err) {
        logger.error('Error fetching submission details', err as Error);
        res.status(500).send('服务器错误');
    }
});

export default router;