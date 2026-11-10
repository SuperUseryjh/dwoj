import { verifyToken } from '../lib/auth-token';
import { renderMarkdown } from '../lib/markdown';
import { queryOne } from '../lib/database';
import logger from '../lib/logger';
import { ROLE_LV } from './auth';

/** 封禁状态 5 s TTL 缓存（32 条 LRU），让绝大多数请求 0 次 DB 查询 */
const BAN_TTL_MS = 5000;
const BAN_CACHE_MAX = 32;
const banCache = new Map<number, { banned: boolean; expires: number }>();

export function invalidateBanCache(uid: number): void {
    banCache.delete(uid);
}

function isBanned(uid: number): boolean {
    const now = Date.now();
    const cached = banCache.get(uid);
    if (cached && cached.expires > now) {
        banCache.delete(uid);
        banCache.set(uid, cached);
        return cached.banned;
    }

    const row = queryOne<{ isBanned: number }>('SELECT isBanned FROM users WHERE id = ?', [uid]);
    const banned = !row || row.isBanned === 1;

    banCache.set(uid, { banned, expires: now + BAN_TTL_MS });
    while (banCache.size > BAN_CACHE_MAX) {
        const oldest = banCache.keys().next().value;
        if (oldest === undefined) break;
        banCache.delete(oldest);
    }
    return banned;
}

export default (pluginManager: any) => {
    return (req: any, res: any, next: () => Promise<void>) => {
        res.locals.ROLE_LV = ROLE_LV;
        res.locals.renderMarkdown = renderMarkdown;

        const finalize = () => {
            try {
                if (pluginManager.hasHook('injectHeader')) {
                    const injectedHeaders: string[] = pluginManager.emit('injectHeader', req);
                    res.locals.pluginHeader = injectedHeaders.join('\n');
                } else {
                    res.locals.pluginHeader = '';
                }
                if (pluginManager.hasHook('injectFooter')) {
                    const injectedFooters: string[] = pluginManager.emit('injectFooter', req);
                    res.locals.pluginFooter = injectedFooters.join('\n');
                } else {
                    res.locals.pluginFooter = '';
                }
            } catch (e) {
                logger.error('Error injecting plugin headers/footers', e as Error);
                res.locals.pluginHeader = '';
                res.locals.pluginFooter = '';
            }
            next();
        };

        try {
            req.user = null;
            const token = req.cookies.token;

            if (token) {
                const payload = verifyToken(token);
                if (!payload || isBanned(payload.id)) {
                    res.clearCookie('token');
                    res.clearCookie('uid');
                } else {
                    req.user = {
                        id: payload.id,
                        username: payload.username,
                        role: payload.role,
                        bio: payload.bio || '',
                        tags: [],
                    };
                }
            }

            res.locals.user = req.user;
            finalize();
        } catch (err) {
            logger.error('Error in global middleware', err as Error);
            req.user = null;
            res.locals.user = null;
            finalize();
        }
    };
};
