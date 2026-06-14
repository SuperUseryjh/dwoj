import MarkdownIt from 'markdown-it';
import jwt from 'jsonwebtoken';
import { queryOne } from '../lib/database';
import logger from '../lib/logger';
import * as config from '../config';
import { ROLE_LV } from './auth';

const md = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true
});

export default (pluginManager: any) => {
    return (req: any, res: any, next: () => Promise<void>) => {
        res.locals.ROLE_LV = ROLE_LV;
        const token = req.cookies.token;
        const uid = req.cookies.uid;

        const finalize = () => {
            res.locals.renderMarkdown = (content: string) => {
                return md.render(content || '');
            };
            try {
                const injectedHeaders: string[] = pluginManager.emit('injectHeader', req);
                const injectedFooters: string[] = pluginManager.emit('injectFooter', req);
                res.locals.pluginHeader = injectedHeaders.join('\n');
                res.locals.pluginFooter = injectedFooters.join('\n');
            } catch (e) {
                logger.error('Error injecting plugin headers/footers', e as Error);
                res.locals.pluginHeader = '';
                res.locals.pluginFooter = '';
            }
            next();
        };

        try {
            if (token) {
                jwt.verify(token, config.JWT_SECRET, (err: any, decoded: any) => {
                    if (err) {
                        logger.warn('JWT verification failed: ' + err.message);
                        req.user = null;
                        res.clearCookie('token');
                        res.clearCookie('uid');
                        res.locals.user = null;
                        return finalize();
                    }

                    const user = queryOne<any>("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [decoded.id]);
                    if (user && user.isBanned) {
                        req.user = null;
                        res.clearCookie('token');
                        res.clearCookie('uid');
                    } else if (user) {
                        req.user = user;
                        if (req.user.tags) {
                            try { req.user.tags = JSON.parse(req.user.tags); } catch (_) { req.user.tags = []; }
                        }
                        if (String(req.user.id) !== String(uid)) {
                            res.cookie('uid', req.user.id);
                        }
                    } else {
                        req.user = null;
                        res.clearCookie('token');
                        res.clearCookie('uid');
                    }
                    res.locals.user = req.user;
                    finalize();
                });
            } else if (uid) {
                const user = queryOne<any>("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [uid]);
                if (user && user.isBanned) {
                    req.user = null;
                    res.clearCookie('uid');
                } else if (user) {
                    req.user = user;
                    if (req.user.tags) {
                        try { req.user.tags = JSON.parse(req.user.tags); } catch (_) { req.user.tags = []; }
                    }
                    const newToken = jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '1h' });
                    res.cookie('token', newToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
                }
                res.locals.user = req.user;
                finalize();
            } else {
                req.user = null;
                res.locals.user = null;
                finalize();
            }
        } catch (err) {
            logger.error('Error in global middleware', err as Error);
            req.user = null;
            res.locals.user = null;
            finalize();
        }
    };
};