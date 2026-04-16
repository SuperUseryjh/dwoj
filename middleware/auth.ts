import db from '../lib/database';
import logger from '../lib/logger';
import { Request, Response, NextFunction } from 'express';
import { RoleLV } from '../types';

export const ROLE_LV: RoleLV = { 'default': 0, 'super_user': 1, 'root': 2 };

export const requireLogin = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
        res.redirect('/login');
    } else {
        next();
    }
};

export const requireRole = (roleName: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(403).send('权限不足：未登录');
            return;
        }
        db.get("SELECT role FROM users WHERE id = ?", [req.user.id], (err: Error, row: any) => {
            if (err) {
                logger.error('Error fetching user role for permission check', err);
                res.status(500).send('服务器错误');
                return;
            }
            if (!row || ROLE_LV[row.role] < ROLE_LV[roleName]) {
                res.status(403).send('权限不足');
                return;
            }
            next();
        });
    };
};
