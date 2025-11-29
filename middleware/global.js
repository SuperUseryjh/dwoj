const { db } = require('../lib/database');
const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true
});
const logger = require('../lib/logger');
const { ROLE_LV } = require('./auth'); // 引入 ROLE_LV

module.exports = (pluginManager) => {
    return (req, res, next) => {
        res.locals.ROLE_LV = ROLE_LV; // 注入 ROLE_LV
        const uid = req.cookies.uid;
        if (uid) {
            db.get("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [uid], (err, user) => {
                if (err) {
                    logger.error('Error fetching user in global middleware', err);
                    req.user = null;
                } else if (user && user.isBanned) {
                    req.user = null;
                    res.clearCookie('uid');
                } else {
                    req.user = user;
                    if (req.user && req.user.tags) {
                        req.user.tags = JSON.parse(req.user.tags);
                    }
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
