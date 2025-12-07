const { db } = require('../lib/database');
const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true
});
const logger = require('../lib/logger');
const jwt = require('jsonwebtoken'); // 引入 jsonwebtoken
const config = require('../config'); // 引入 config
const { ROLE_LV } = require('./auth'); // 引入 ROLE_LV

module.exports = (pluginManager) => {
    return (req, res, next) => {
        res.locals.ROLE_LV = ROLE_LV; // 注入 ROLE_LV
        const token = req.cookies.token;
        const uid = req.cookies.uid; // 仍然读取 uid，以防万一

        if (token) {
            jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
                if (err) {
                    logger.warn('JWT verification failed:', err.message);
                    req.user = null;
                    res.clearCookie('token'); // 清除无效的 token
                    res.clearCookie('uid'); // 清除 uid
                    res.locals.user = null;
                    // 继续处理，不阻止请求，但用户未认证
                    return next();
                }

                // JWT 有效，从数据库获取完整的用户数据
                db.get("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [decoded.id], (err, user) => {
                    if (err) {
                        logger.error('Error fetching user from JWT payload in global middleware', err);
                        req.user = null;
                    } else if (user && user.isBanned) {
                        req.user = null;
                        res.clearCookie('token');
                        res.clearCookie('uid');
                    } else if (user) {
                        req.user = user;
                        if (req.user.tags) {
                            req.user.tags = JSON.parse(req.user.tags);
                        }
                        // 确保 uid cookie 与 JWT 中的 id 匹配
                        if (String(req.user.id) !== String(uid)) {
                            res.cookie('uid', req.user.id);
                        }
                    } else {
                        // 用户不存在，可能已被删除
                        req.user = null;
                        res.clearCookie('token');
                        res.clearCookie('uid');
                    }
                    res.locals.user = req.user;
                    res.locals.renderMarkdown = (content) => {
                        return md.render(content || '');
                    };
                    const injectedHeaders = pluginManager.emit('injectHeader', req);
                    const injectedFooters = pluginManager.emit('injectFooter', req);
                    res.locals.pluginHeader = injectedHeaders.join('\n');
                    res.locals.pluginFooter = injectedFooters.join('\n');
                    next();
                });
            });
        } else if (uid) { // 如果没有 token，但有 uid，则尝试使用 uid (兼容旧系统)
            db.get("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [uid], (err, user) => {
                if (err) {
                    logger.error('Error fetching user from uid in global middleware', err);
                    req.user = null;
                } else if (user && user.isBanned) {
                    req.user = null;
                    res.clearCookie('uid');
                } else if (user) {
                    req.user = user;
                    if (req.user.tags) {
                        req.user.tags = JSON.parse(req.user.tags);
                    }
                    // 如果是旧的 uid 认证，尝试生成并设置 JWT
                    const newToken = jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '1h' });
                    res.cookie('token', newToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
                }
                res.locals.user = req.user;
                res.locals.renderMarkdown = (content) => {
                    return md.render(content || '');
                };
                const injectedHeaders = pluginManager.emit('injectHeader', req);
                const injectedFooters = pluginManager.emit('injectFooter', req);
                res.locals.pluginHeader = injectedHeaders.join('\n');
                res.locals.pluginFooter = injectedFooters.join('\n');
                next();
            });
        } else {
            req.user = null;
            res.locals.user = null;
            res.locals.renderMarkdown = (content) => {
                return md.render(content || '');
            };
            const injectedHeaders = pluginManager.emit('injectHeader', req);
            const injectedFooters = pluginManager.emit('injectFooter', req);
            res.locals.pluginHeader = injectedHeaders.join('\n');
            res.locals.pluginFooter = injectedFooters.join('\n');
            next();
        }
    };
};
