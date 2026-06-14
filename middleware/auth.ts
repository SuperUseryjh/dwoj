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

export function requireRole(roleName: string): (req: any, res: any, next: () => Promise<void>) => void {
    return (req: any, res: any, next: () => Promise<void>) => {
        if (!req.user) {
            res.status(403).send('权限不足：未登录');
            return;
        }
        try {
            const row = queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [req.user.id]);
            if (!row || (ROLE_LV[row.role] ?? -1) < (ROLE_LV[roleName] ?? 0)) {
                res.status(403).send('权限不足');
                return;
            }
            next();
        } catch (err) {
            logger.error('Error fetching user role for permission check', err as Error);
            res.status(500).send('服务器错误');
        }
    };
}