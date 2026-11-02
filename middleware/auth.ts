import { queryOne } from '../lib/database';
import logger from '../lib/logger';

export const ROLE_LV: Record<string, number> = { 'default': 0, 'super_user': 1, 'root': 2 };

export function requireLogin(req: any, res: any, next: () => Promise<void>): void {
    if (!req.user) {
        res.redirect('/login');
        return;
    }
    next();
}

/**
 * 要求当前用户至少具备指定角色。
 * 数据库访问是异步的，因此中间件本身也是 async；框架会 await 返回的 Promise。
 */
export function requireRole(roleName: string): (req: any, res: any, next: () => Promise<void>) => Promise<void> {
    return async (req: any, res: any, next: () => Promise<void>) => {
        if (!req.user) {
            res.status(403).send('权限不足：未登录');
            return;
        }
        try {
            const row = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [req.user.id]);
            if (!row || (ROLE_LV[row.role] ?? -1) < (ROLE_LV[roleName] ?? 0)) {
                res.status(403).send('权限不足');
                return;
            }
            await next();
        } catch (err) {
            logger.error('Error fetching user role for permission check', err as Error);
            res.status(500).send('服务器错误');
        }
    };
}
