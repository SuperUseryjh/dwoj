import { Router, UploadHandler } from '../lib/bun-http';
import fs from 'fs';
import path from 'path';
import * as config from '../config';
import { emptyDirSync } from '../lib/fs-utils';
import { requireLogin, requireRole, ROLE_LV } from '../middleware/auth';
import { Problem, Submission, User, query, queryOne, execute } from '../lib/database';
import { judgeQueue } from '../lib/judge/queue';
import logger from '../lib/logger';

const router = new Router();
const upload = new UploadHandler({ dest: config.UPLOAD_DIR });

router.get('/problem/new', requireRole('super_user'), (req, res, next) => {
    res.render('problem_edit', { problem: null });
});

router.post('/problem/save', requireRole('super_user'), upload.single('testcaseZip'), async (req, res, next) => {
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
            await handleZipUpload(req, Number(id), res);
        } else {
            const result = execute(`INSERT INTO problems (title, description, authorId, timeLimit) VALUES (?, ?, ?, ?)`,
                [title, description, req.user.id, timeLimit]);
            const newProblemId = Number(result.lastInsertRowid);
            await handleZipUpload(req, newProblemId, res);
        }
    } catch (err) {
        logger.error('Error saving problem', err as Error);
        res.status(500).send('服务器错误');
    }
});

async function handleZipUpload(req: any, problemId: number, res: any): Promise<void> {
    if (!req.file) {
        res.redirect('/');
        return;
    }

    if (req.file.size > config.TESTCASE_ZIP_LIMIT) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        res.status(413).send('测试数据压缩包过大（上限 20 MB）');
        return;
    }

    try {
        // 惰性加载 adm-zip，仅在真正上传测试点时占用内存
        const { default: AdmZip } = await import('adm-zip');
        const zip = new AdmZip(req.file.path);
        const targetDir = path.join(config.PROB_DIR, problemId.toString());
        emptyDirSync(targetDir);
        zip.extractAllTo(targetDir, true);
        fs.unlinkSync(req.file.path);
        res.redirect('/');
    } catch (e) {
        logger.error('Error processing testcase zip', e as Error);
        res.status(500).send('处理测试数据失败');
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

    if (judgeQueue.isFull) {
        res.status(503).send('评测队列已满（上限 50），请稍后再提交');
        return;
    }

    try {
        const result = execute(`INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [problemId, req.user.id, req.user.username, language, code, "Pending", submissionTime, JSON.stringify([])]);
        judgeQueue.push(Number(result.lastInsertRowid));
        res.redirect('/status');
    } catch (err) {
        logger.error('Error inserting new submission', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/status', (req, res, next) => {
    try {
        // 只取展示列，永不把 code 等大字段读进内存；分页 50
        const pageSize = config.STATUS_PAGE_SIZE;
        const requestedPage = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
        const total = (queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM submissions')?.count) ?? 0;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(requestedPage, totalPages);

        const submissions = query<any>(
            'SELECT id, problemId, username, language, status, time FROM submissions ORDER BY id DESC LIMIT ? OFFSET ?',
            [pageSize, (page - 1) * pageSize]);

        res.render('status', { submissions, page, totalPages, total });
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