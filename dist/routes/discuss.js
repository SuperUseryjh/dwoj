"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../middleware/auth");
const database_1 = __importDefault(require("../lib/database"));
const logger_1 = __importDefault(require("../lib/logger"));
const router = express_1.default.Router();
router.get('/discuss', (req, res) => {
    database_1.default.all("SELECT * FROM discussNodes", [], (err, nodes) => {
        if (err) {
            logger_1.default.error('Error fetching discuss nodes', err);
            return res.status(500).send('服务器错误');
        }
        database_1.default.all("SELECT * FROM threads ORDER BY id DESC", [], (err, threads) => {
            if (err) {
                logger_1.default.error('Error fetching threads', err);
                return res.status(500).send('服务器错误');
            }
            threads.forEach(thread => {
                if (thread.replies) {
                    try {
                        thread.replies = JSON.parse(thread.replies);
                    }
                    catch (e) {
                        logger_1.default.error(`Error parsing replies for thread ${thread.id}`, e);
                        thread.replies = [];
                    }
                }
            });
            res.render('discuss', { nodes: nodes, threads: threads });
        });
    });
});
router.get('/discuss/new', auth_1.requireLogin, (req, res) => {
    database_1.default.all("SELECT * FROM discussNodes", [], (err, nodes) => {
        if (err) {
            logger_1.default.error('Error fetching discuss nodes for new thread page', err);
            return res.status(500).send('服务器错误');
        }
        res.render('thread_edit', { nodes: nodes });
    });
});
router.post('/discuss/create', auth_1.requireLogin, (req, res) => {
    const { nodeId, title, content } = req.body;
    const threadTime = new Date().toLocaleString();
    database_1.default.run(`INSERT INTO threads (nodeId, title, content, author, time, replies) VALUES (?, ?, ?, ?, ?, ?)`, [nodeId, title, content, req.user.username, threadTime, JSON.stringify([])], function (err) {
        if (err) {
            logger_1.default.error('Error creating new thread', err);
            return res.status(500).send('服务器错误');
        }
        res.redirect('/discuss/thread/' + this.lastID);
    });
});
router.get('/discuss/thread/:id', (req, res) => {
    database_1.default.get("SELECT * FROM threads WHERE id = ?", [req.params.id], (err, thread) => {
        if (err) {
            logger_1.default.error('Error fetching thread details', err);
            return res.status(500).send('服务器错误');
        }
        if (!thread)
            return res.status(404).send('帖子不存在');
        if (thread.replies) {
            try {
                thread.replies = JSON.parse(thread.replies);
            }
            catch (e) {
                logger_1.default.error(`Error parsing replies for thread ${thread.id}`, e);
                thread.replies = [];
            }
        }
        res.render('thread', { thread: thread });
    });
});
router.post('/discuss/reply', auth_1.requireLogin, (req, res) => {
    const { threadId, content } = req.body;
    database_1.default.get("SELECT replies FROM threads WHERE id = ?", [threadId], (err, thread) => {
        if (err) {
            logger_1.default.error(`Error fetching thread ${threadId} for reply`, err);
            return res.status(500).send('服务器错误');
        }
        if (!thread)
            return res.status(404).send('帖子不存在');
        let replies = thread.replies ? JSON.parse(thread.replies) : [];
        replies.push({ author: req.user.username, content: content, time: new Date().toLocaleString() });
        database_1.default.run("UPDATE threads SET replies = ? WHERE id = ?", [JSON.stringify(replies), threadId], (err) => {
            if (err) {
                logger_1.default.error(`Error adding reply to thread ${threadId}`, err);
                return res.status(500).send('服务器错误');
            }
            res.redirect('/discuss/thread/' + threadId);
        });
    });
});
router.post('/discuss/node', (0, auth_1.requireRole)('super_user'), (req, res) => {
    const { name, desc } = req.body;
    database_1.default.run(`INSERT INTO discussNodes (name, desc) VALUES (?, ?)`, [name, desc], function (err) {
        if (err) {
            logger_1.default.error('Error creating new discuss node', err);
            return res.status(500).send('服务器错误');
        }
        res.redirect('/discuss');
    });
});
exports.default = router;
//# sourceMappingURL=discuss.js.map