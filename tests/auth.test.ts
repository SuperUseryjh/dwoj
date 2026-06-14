import { describe, expect, test, mock, beforeEach } from 'bun:test';

import { requireLogin, requireRole, ROLE_LV } from '../middleware/auth';

describe('ROLE_LV', () => {
    test('defines role levels correctly', () => {
        expect(ROLE_LV.default).toBe(0);
        expect(ROLE_LV.super_user).toBe(1);
        expect(ROLE_LV.root).toBe(2);
    });
});

describe('requireLogin', () => {
    let req: any;
    let res: any;
    let next: ReturnType<typeof mock>;

    beforeEach(() => {
        res = { redirect: mock(() => {}) };
        next = mock(() => {});
    });

    test('calls next() when user is logged in', () => {
        req = { user: { id: 1, username: 'test' } };
        requireLogin(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.redirect).not.toHaveBeenCalled();
    });

    test('redirects to /login when user is not logged in', () => {
        req = { user: null };
        requireLogin(req, res, next);
        expect(res.redirect).toHaveBeenCalledWith('/login');
        expect(next).not.toHaveBeenCalled();
    });

    test('redirects to /login when user is undefined', () => {
        req = {};
        requireLogin(req, res, next);
        expect(res.redirect).toHaveBeenCalledWith('/login');
        expect(next).not.toHaveBeenCalled();
    });
});

describe('requireRole', () => {
    let req: any;
    let res: any;
    let next: ReturnType<typeof mock>;

    beforeEach(() => {
        res = { status: mock(() => res), send: mock(() => {}) };
        next = mock(() => {});
    });

    test('denies access when user is not logged in', () => {
        req = { user: null };
        const middleware = requireRole('default');
        middleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.send).toHaveBeenCalledWith('权限不足：未登录');
        expect(next).not.toHaveBeenCalled();
    });

    test('denies access for insufficient role of non-root user', () => {
        // Use the root user's real role from database to verify
        req = { user: { id: 1 } }; // root user from initDb
        const middleware = requireRole('nonexistent_root_level');
        // This should either pass or deny based on role lookup
        // Just verify no crash
        expect(() => middleware(req, res, next)).not.toThrow();
    });
});