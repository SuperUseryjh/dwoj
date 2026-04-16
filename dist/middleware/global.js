"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = __importDefault(require("../lib/database"));
const markdown_it_1 = __importDefault(require("markdown-it"));
const logger_1 = __importDefault(require("../lib/logger"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("../config"));
const md = new markdown_it_1.default({
    html: false,
    breaks: true,
    linkify: true
});
exports.default = (pluginManager) => {
    return (req, res, next) => {
        res.locals.ROLE_LV = { 'default': 0, 'super_user': 1, 'root': 2 };
        const token = req.cookies.token;
        const uid = req.cookies.uid;
        if (token) {
            jsonwebtoken_1.default.verify(token, config_1.default.JWT_SECRET, (err, decoded) => {
                if (err) {
                    logger_1.default.warn('JWT verification failed: ' + err.message);
                    req.user = null;
                    res.clearCookie('token');
                    res.clearCookie('uid');
                    res.locals.user = null;
                    return next();
                }
                database_1.default.get("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [decoded.id], (err, user) => {
                    if (err) {
                        logger_1.default.error('Error fetching user from JWT payload in global middleware', err);
                        req.user = null;
                    }
                    else if (user && user.isBanned) {
                        req.user = null;
                        res.clearCookie('token');
                        res.clearCookie('uid');
                    }
                    else if (user) {
                        req.user = user;
                        if (req.user.tags) {
                            req.user.tags = JSON.parse(req.user.tags);
                        }
                        if (String(req.user.id) !== String(uid)) {
                            res.cookie('uid', req.user.id);
                        }
                    }
                    else {
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
        }
        else if (uid) {
            database_1.default.get("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [uid], (err, user) => {
                if (err) {
                    logger_1.default.error('Error fetching user from uid in global middleware', err);
                    req.user = null;
                }
                else if (user && user.isBanned) {
                    req.user = null;
                    res.clearCookie('uid');
                }
                else if (user) {
                    req.user = user;
                    if (req.user.tags) {
                        req.user.tags = JSON.parse(req.user.tags);
                    }
                    const newToken = jsonwebtoken_1.default.sign({ id: user.id, role: user.role }, config_1.default.JWT_SECRET, { expiresIn: '1h' });
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
        }
        else {
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
//# sourceMappingURL=global.js.map