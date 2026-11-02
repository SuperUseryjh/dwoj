import { Router, UploadHandler } from '../lib/bun-http';
import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import path from 'path';
import * as config from '../config';
import { requireLogin, requireRole, ROLE_LV } from '../middleware/auth';
import { Problem, query, queryOne, execute } from '../lib/database';
import { enqueueJudge, getSupportedLanguages, isJudging, STATUS_TEXT } from '../controllers/judge';
import logger from '../lib/logger';

/** 同一用户两次提交之间的最小间隔，防止刷屏式提交压垮评测机 */
const SUBMIT_COOLDOWN_MS = 3000;
const lastSubmitAt = new Map<number, number>();

const router = new Router();
const upload = new UploadHandler({ dest: config.UPLOAD_DIR });

router.get('/problem/new', requireRole('super_user'), (req, res, next) => {
    res.render('problem_edit', { problem: null });
});

router.post('/problem/save', requireRole('super_user'), upload.single('testcaseZip'), async (req, res, next) => {
    const { id, title, description, timeLimit } = req.body;

    try {
        if (id) {
            const problem = await queryOne<Problem>("SELECT * FROM problems WHERE id = ?", [id]);
            if (!problem) {
                res.status(404).send('题目不存在');
                return;
            }

            if (req.user.role !== 'root' && problem.authorId !== req.user.id) {
                res.status(403).send("无权修改此题目");
                return;
            }

            await execute("UPDATE problems SET title = ?, description = ?, timeLimit = ? WHERE id = ?",
                [title, description, timeLimit, id]);
            handleZipUpload(req, Number(id), res);
        } else {
            const result = await execute(`INSERT INTO problems (title, description, authorId, timeLimit) VALUES (?, ?, ?, ?)`,
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

router.get('/problem/edit/:id', requireRole('super_user'), async (req, res, next) => {
    try {
        const problem = await queryOne<Problem>("SELECT * FROM problems WHERE id = ?", [req.params.id]);
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

router.get('/problem/:id', async (req, res, next) => {
    try {
        const problem = await queryOne<Problem>("SELECT * FROM problems WHERE id = ?", [req.params.id]);
        if (!problem) {
            res.status(404).send('Not Found');
            return;
        }
        res.render('problem', { problem, languages: getSupportedLanguages() });
    } catch (err) {
        logger.error('Error fetching problem details', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.post('/submit', requireLogin, async (req, res, next) => {
    const { problemId, language, code } = req.body;

    try {
        const pid = Number(problemId);
        if (!Number.isInteger(pid) || pid <= 0) {
            res.status(400).send('题目 ID 无效');
            return;
        }
        if (!getSupportedLanguages().includes(String(language))) {
            res.status(400).send('不支持的语言');
            return;
        }
        if (typeof code !== 'string' || code.trim().length === 0) {
            res.status(400).send('代码不能为空');
            return;
        }
        if (Buffer.byteLength(code, 'utf-8') > config.MAX_CODE_BYTES) {
            res.status(413).send('代码过长');
            return;
        }
        if (!await queryOne<{ id: number }>("SELECT id FROM problems WHERE id = ?", [pid])) {
            res.status(404).send('题目不存在');
            return;
        }

        const now = Date.now();
        const last = lastSubmitAt.get(req.user.id) ?? 0;
        if (now - last < SUBMIT_COOLDOWN_MS) {
            res.status(429).send('提交过于频繁，请稍后再试');
            return;
        }
        lastSubmitAt.set(req.user.id, now);
        if (lastSubmitAt.size > 10000) {
            // 防止内存无限增长
            const cutoff = now - SUBMIT_COOLDOWN_MS;
            for (const [uid, ts] of lastSubmitAt) {
                if (ts < cutoff) lastSubmitAt.delete(uid);
            }
        }

        const submissionTime = new Date().toLocaleString();
        const result = await execute(`INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [pid, req.user.id, req.user.username, String(language), code, "Pending", submissionTime, JSON.stringify([])]);

        enqueueJudge(Number(result.lastInsertRowid));
        res.redirect('/status');
    } catch (err) {
        logger.error('Error inserting new submission', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.post('/submission/:id/rejudge', requireRole('super_user'), async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const sub = await queryOne<{ id: number }>("SELECT id FROM submissions WHERE id = ?", [id]);
        if (!sub) {
            res.status(404).send('提交不存在');
            return;
        }
        if (isJudging(sub.id)) {
            res.status(409).send('该提交正在评测中，请稍后再试');
            return;
        }
        await execute("UPDATE submissions SET status = 'Pending', errorInfo = NULL, caseResults = '[]' WHERE id = ?", [sub.id]);
        enqueueJudge(sub.id);
        res.redirect(`/submission/${sub.id}`);
    } catch (err) {
        logger.error('Error rejudging submission', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/status', async (req, res, next) => {
    try {
        const pageSize = 50;
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const total = (await queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM submissions"))?.count ?? 0;
        const submissions = await query<any>(
            "SELECT id, problemId, username, language, status, time FROM submissions ORDER BY id DESC LIMIT ? OFFSET ?",
            [pageSize, (page - 1) * pageSize]
        );
        res.render('status', {
            submissions,
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)),
            STATUS_TEXT,
        });
    } catch (err) {
        logger.error('Error fetching submissions for status page', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/submission/:id', requireLogin, async (req, res, next) => {
    try {
        const sub = await queryOne<any>("SELECT * FROM submissions WHERE id = ?", [req.params.id]);
        if (!sub) {
            res.status(404).send('提交不存在');
            return;
        }

        const userRole = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [req.user.id]);
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
