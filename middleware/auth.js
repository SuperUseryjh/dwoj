const { db } = require('../lib/database');
const logger = require('../lib/logger');

const ROLE_LV = { 'default': 0, 'super_user': 1, 'root': 2 };

function requireLogin(req, res, next) {
    if (!req.user) return res.redirect('/login');
    next();
}

function requireRole(roleName) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(403).send('权限不足：未登录');
        }
        db.get("SELECT role FROM users WHERE id = ?", [req.user.id], (err, row) => {
            if (err) {
                logger.error('Error fetching user role for permission check', err);
                return res.status(500).send('服务器错误');
            }
            if (!row || ROLE_LV[row.role] < ROLE_LV[roleName]) {
                return res.status(403).send('权限不足');
            }
            next();
        });
    };
}

module.exports = { requireLogin, requireRole, ROLE_LV };
