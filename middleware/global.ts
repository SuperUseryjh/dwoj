import MarkdownIt from 'markdown-it';
import jwt from 'jsonwebtoken';
import { queryOne } from '../lib/database';
import { createLogger } from '../lib/logger';
import * as config from '../config';
import { ROLE_LV } from './auth';

const logger = createLogger('http');

const md = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true
});

/** 把回调式的 jwt.verify 包成 Promise，便于在 async 中间件里使用 */
function verifyToken(token: string): Promise<any> {
    return new Promise((resolve, reject) => {
        jwt.verify(token, config.JWT_SECRET, (err: any, decoded: any) => {
            if (err) reject(err);
            else resolve(decoded);
        });
    });
}

export default (pluginManager: any) => {
    return async (req: any, res: any, next: () => Promise<void>) => {
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
            return next();
        };

        /** 把 tags 字符串还原成数组，顺手兼容脏数据 */
        const normalizeUser = (user: any) => {
            if (user && user.tags) {
                try { user.tags = JSON.parse(user.tags); } catch (_) { user.tags = []; }
            }
            return user;
        };

        try {
            if (token) {
                let decoded: any = null;
                try {
                    decoded = await verifyToken(token);
                } catch (err) {
                    logger.warn('JWT verification failed: ' + (err as Error).message);
                    req.user = null;
                    res.clearCookie('token');
                    res.clearCookie('uid');
                    res.locals.user = null;
                    return await finalize();
                }

                const user = await queryOne<any>("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [decoded.id]);
                if (user && user.isBanned) {
                    req.user = null;
                    res.clearCookie('token');
                    res.clearCookie('uid');
                } else if (user) {
                    req.user = normalizeUser(user);
                    if (String(req.user.id) !== String(uid)) {
                        res.cookie('uid', req.user.id);
                    }
                } else {
                    req.user = null;
                    res.clearCookie('token');
                    res.clearCookie('uid');
                }
                res.locals.user = req.user;
                return await finalize();
            }

            if (uid) {
                const user = await queryOne<any>("SELECT id, username, role, bio, tags, isBanned FROM users WHERE id = ?", [uid]);
                if (user && user.isBanned) {
                    req.user = null;
                    res.clearCookie('uid');
                } else if (user) {
                    req.user = normalizeUser(user);
                    const newToken = jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '1h' });
                    res.cookie('token', newToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
                }
                res.locals.user = req.user;
                return await finalize();
            }

            req.user = null;
            res.locals.user = null;
            return await finalize();
        } catch (err) {
            logger.error('Error in global middleware', err as Error);
            req.user = null;
            res.locals.user = null;
            return await finalize();
        }
    };
};
