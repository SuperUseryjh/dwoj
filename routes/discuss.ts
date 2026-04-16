import express from 'express';
import { requireLogin, requireRole } from '../middleware/auth';
import db from '../lib/database';
import logger from '../lib/logger';

const router = express.Router();

router.get('/discuss', (req, res) => {
    db.all("SELECT * FROM discussNodes", [], (err: Error, nodes: any[]) => {
        if (err) {
            logger.error('Error fetching discuss nodes', err);
            return res.status(500).send('服务器错误');
        }
        db.all("SELECT * FROM threads ORDER BY id DESC", [], (err: Error, threads: any[]) => {
            if (err) {
                logger.error('Error fetching threads', err);
                return res.status(500).send('服务器错误');
            }
            threads.forEach(thread => {
                if (thread.replies) {
                    try {
                        thread.replies = JSON.parse(thread.replies);
                    } catch (e) {
                        logger.error(`Error parsing replies for thread ${thread.id}`, e as Error);
                        thread.replies = [];
                    }
                }
            });
            res.render('discuss', { nodes: nodes, threads: threads });
        });
    });
});

router.get('/discuss/new', requireLogin, (req, res) => {
    db.all("SELECT * FROM discussNodes", [], (err: Error, nodes: any[]) => {
        if (err) {
            logger.error('Error fetching discuss nodes for new thread page', err);
            return res.status(500).send('服务器错误');
        }
        res.render('thread_edit', { nodes: nodes });
    });
});

router.post('/discuss/create', requireLogin, (req, res) => {
    const { nodeId, title, content } = req.body;
    const threadTime = new Date().toLocaleString();
    db.run(`INSERT INTO threads (nodeId, title, content, author, time, replies) VALUES (?, ?, ?, ?, ?, ?)`,
        [nodeId, title, content, (req.user! as any).username, threadTime, JSON.stringify([])], function(err: Error) {
            if (err) {
                logger.error('Error creating new thread', err);
                return res.status(500).send('服务器错误');
            }
            res.redirect('/discuss/thread/' + this.lastID);
        });
});

router.get('/discuss/thread/:id', (req, res) => {
    db.get("SELECT * FROM threads WHERE id = ?", [req.params.id], (err: Error, thread: any) => {
        if (err) {
            logger.error('Error fetching thread details', err);
            return res.status(500).send('服务器错误');
        }
        if (!thread) return res.status(404).send('帖子不存在');
        if (thread.replies) {
            try {
                thread.replies = JSON.parse(thread.replies);
            } catch (e) {
                logger.error(`Error parsing replies for thread ${thread.id}`, e as Error);
                thread.replies = [];
            }
        }
        res.render('thread', { thread: thread });
    });
});

router.post('/discuss/reply', requireLogin, (req, res) => {
    const { threadId, content } = req.body;
    db.get("SELECT replies FROM threads WHERE id = ?", [threadId], (err: Error, thread: any) => {
        if (err) {
            logger.error(`Error fetching thread ${threadId} for reply`, err);
            return res.status(500).send('服务器错误');
        }
        if (!thread) return res.status(404).send('帖子不存在');

        let replies = thread.replies ? JSON.parse(thread.replies) : [];
        replies.push({ author: (req.user! as any).username, content: content, time: new Date().toLocaleString() });

        db.run("UPDATE threads SET replies = ? WHERE id = ?", [JSON.stringify(replies), threadId], (err: Error) => {
            if (err) {
                logger.error(`Error adding reply to thread ${threadId}`, err);
                return res.status(500).send('服务器错误');
            }
            res.redirect('/discuss/thread/' + threadId);
        });
    });
});

router.post('/discuss/node', requireRole('super_user'), (req, res) => {
    const { name, desc } = req.body;
    db.run(`INSERT INTO discussNodes (name, desc) VALUES (?, ?)`, [name, desc], function(err: Error) {
        if (err) {
            logger.error('Error creating new discuss node', err);
            return res.status(500).send('服务器错误');
        }
        res.redirect('/discuss');
    });
});

export default router;
