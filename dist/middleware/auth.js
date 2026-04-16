"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = exports.requireLogin = exports.ROLE_LV = void 0;
const database_1 = __importDefault(require("../lib/database"));
const logger_1 = __importDefault(require("../lib/logger"));
exports.ROLE_LV = { 'default': 0, 'super_user': 1, 'root': 2 };
const requireLogin = (req, res, next) => {
    if (!req.user) {
        res.redirect('/login');
    }
    else {
        next();
    }
};
exports.requireLogin = requireLogin;
const requireRole = (roleName) => {
    return (req, res, next) => {
        if (!req.user) {
            res.status(403).send('权限不足：未登录');
            return;
        }
        database_1.default.get("SELECT role FROM users WHERE id = ?", [req.user.id], (err, row) => {
            if (err) {
                logger_1.default.error('Error fetching user role for permission check', err);
                res.status(500).send('服务器错误');
                return;
            }
            if (!row || exports.ROLE_LV[row.role] < exports.ROLE_LV[roleName]) {
                res.status(403).send('权限不足');
                return;
            }
            next();
        });
    };
};
exports.requireRole = requireRole;
//# sourceMappingURL=auth.js.map