import { Router } from '../lib/bun-http';
import { requireLogin, requireRole } from '../middleware/auth';
import { DiscussNode, Thread, query, queryOne, execute } from '../lib/database';
import logger from '../lib/logger';

const router = new Router();

router.get('/discuss', (req, res, next) => {
    try {
        const nodes = query<DiscussNode>("SELECT * FROM discussNodes");
        const threads = query<any>("SELECT * FROM threads ORDER BY id DESC");
        threads.forEach(thread => {
            if (thread.replies) {
                try {
                    thread.replies = JSON.parse(thread.replies);
                } catch (_) {
                    thread.replies = [];
                }
            }
        });
        res.render('discuss', { nodes, threads });
    } catch (err) {
        logger.error('Error fetching discuss data', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/discuss/new', requireLogin, (req, res, next) => {
    try {
        const nodes = query<DiscussNode>("SELECT * FROM discussNodes");
        res.render('thread_edit', { nodes });
    } catch (err) {
        logger.error('Error fetching discuss nodes for new thread page', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.post('/discuss/create', requireLogin, (req, res, next) => {
    const { nodeId, title, content } = req.body;
    const threadTime = new Date().toLocaleString();
    try {
        const result = execute(`INSERT INTO threads (nodeId, title, content, author, time, replies) VALUES (?, ?, ?, ?, ?, ?)`,
            [nodeId, title, content, req.user.username, threadTime, JSON.stringify([])]);
        res.redirect('/discuss/thread/' + Number(result.lastInsertRowid));
    } catch (err) {
        logger.error('Error creating new thread', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/discuss/thread/:id', (req, res, next) => {
    try {
        const thread = queryOne<any>("SELECT * FROM threads WHERE id = ?", [req.params.id]);
        if (!thread) {
            res.status(404).send('帖子不存在');
            return;
        }
        if (thread.replies) {
            try {
                thread.replies = JSON.parse(thread.replies);
            } catch (_) {
                thread.replies = [];
            }
        }
        res.render('thread', { thread });
    } catch (err) {
        logger.error('Error fetching thread details', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.post('/discuss/reply', requireLogin, (req, res, next) => {
    const { threadId, content } = req.body;
    try {
        const thread = queryOne<{ replies: string | null }>("SELECT replies FROM threads WHERE id = ?", [threadId]);
        if (!thread) {
            res.status(404).send('帖子不存在');
            return;
        }
        const replies: any[] = thread.replies ? JSON.parse(thread.replies) : [];
        replies.push({ author: req.user.username, content, time: new Date().toLocaleString() });
        execute("UPDATE threads SET replies = ? WHERE id = ?", [JSON.stringify(replies), threadId]);
        res.redirect('/discuss/thread/' + threadId);
    } catch (err) {
        logger.error(`Error adding reply to thread ${threadId}`, err as Error);
        res.status(500).send('服务器错误');
    }
});

router.post('/discuss/node', requireRole('super_user'), (req, res, next) => {
    const { name, desc } = req.body;
    try {
        execute(`INSERT INTO discussNodes (name, desc) VALUES (?, ?)`, [name, desc]);
        res.redirect('/discuss');
    } catch (err) {
        logger.error('Error creating new discuss node', err as Error);
        res.status(500).send('服务器错误');
    }
});

export default router;