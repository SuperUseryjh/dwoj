import db from '../lib/database';
import MarkdownIt from 'markdown-it';
import logger from '../lib/logger';
import jwt from 'jsonwebtoken';
import config from '../config';
import { Request, Response, NextFunction } from 'express';
import PluginSystem from '../lib/plugin_system';
import { User } from '../types';

const md = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true
});

export default (pluginManager: PluginSystem) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        (res.locals as any).ROLE_LV = { 'default': 0, 'super_user': 1, 'root': 2 };
        const token = req.cookies.token;
        const uid = req.cookies.uid;

        if (token) {
            jwt.verify(token, config.JWT_SECRET, (err: jwt.VerifyErrors | null, decoded: any) => {
                if (err) {
                    logger.warn('JWT verification failed: ' + err.message);
                    req.user = null;
                    res.clearCookie('token');
                    res.clearCookie('uid');
                    (res.locals as any).user = null;
                    return next();
                }

                db.get("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [decoded.id], (err: Error, user: User) => {
                    if (err) {
                        logger.error('Error fetching user from JWT payload in global middleware', err);
                        req.user = null;
                    } else if (user && user.isBanned) {
                        req.user = null;
                        res.clearCookie('token');
                        res.clearCookie('uid');
                    } else if (user) {
                        req.user = user;
                        if ((req.user as any).tags) {
                            (req.user as any).tags = JSON.parse((req.user as any).tags);
                        }
                        if (String(req.user.id) !== String(uid)) {
                            res.cookie('uid', req.user.id);
                        }
                    } else {
                        req.user = null;
                        res.clearCookie('token');
                        res.clearCookie('uid');
                    }
                    (res.locals as any).user = req.user;
                    (res.locals as any).renderMarkdown = (content: string) => {
                        return md.render(content || '');
                    };
                    const injectedHeaders = pluginManager.emit('injectHeader', req);
                    const injectedFooters = pluginManager.emit('injectFooter', req);
                    (res.locals as any).pluginHeader = injectedHeaders.join('\n');
                    (res.locals as any).pluginFooter = injectedFooters.join('\n');
                    next();
                });
            });
        } else if (uid) {
            db.get("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [uid], (err: Error, user: User) => {
                if (err) {
                    logger.error('Error fetching user from uid in global middleware', err);
                    req.user = null;
                } else if (user && user.isBanned) {
                    req.user = null;
                    res.clearCookie('uid');
                } else if (user) {
                    req.user = user;
                    if ((req.user as any).tags) {
                        (req.user as any).tags = JSON.parse((req.user as any).tags);
                    }
                    const newToken = jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '1h' });
                    res.cookie('token', newToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
                }
                (res.locals as any).user = req.user;
                (res.locals as any).renderMarkdown = (content: string) => {
                    return md.render(content || '');
                };
                const injectedHeaders = pluginManager.emit('injectHeader', req);
                const injectedFooters = pluginManager.emit('injectFooter', req);
                (res.locals as any).pluginHeader = injectedHeaders.join('\n');
                (res.locals as any).pluginFooter = injectedFooters.join('\n');
                next();
            });
        } else {
            req.user = null;
            (res.locals as any).user = null;
            (res.locals as any).renderMarkdown = (content: string) => {
                return md.render(content || '');
            };
            const injectedHeaders = pluginManager.emit('injectHeader', req);
            const injectedFooters = pluginManager.emit('injectFooter', req);
            (res.locals as any).pluginHeader = injectedHeaders.join('\n');
            (res.locals as any).pluginFooter = injectedFooters.join('\n');
            next();
        }
    };
};
