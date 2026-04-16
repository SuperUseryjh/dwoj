"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = __importDefault(require("../config"));
const database_1 = __importDefault(require("../lib/database"));
const logger_1 = __importDefault(require("../lib/logger"));
const router = express_1.default.Router();
router.get('/login', (req, res) => res.render('login'));
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    database_1.default.get("SELECT id, username, password, role, isBanned FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (err) {
            logger_1.default.error('Error during login', err);
            return res.status(500).send('服务器错误');
        }
        if (user) {
            if (user.isBanned)
                return res.send('账号已被封禁');
            const token = jsonwebtoken_1.default.sign({ id: user.id, role: user.role }, config_1.default.JWT_SECRET, { expiresIn: '1h' });
            res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
            res.cookie('uid', user.id);
            res.redirect('/');
        }
        else {
            res.send('用户名或密码错误');
        }
    });
});
router.get('/register', (req, res) => {
    if (req.cookies['device_banned'])
        return res.send('此设备已被禁止注册');
    res.render('register');
});
router.post('/register', (req, res) => {
    if (req.cookies['device_banned'])
        return res.status(403).send('Banned');
    const { username, password } = req.body;
    database_1.default.get("SELECT id FROM users WHERE username = ?", [username], (err, user) => {
        if (err) {
            logger_1.default.error('Error during registration check', err);
            return res.status(500).send('服务器错误');
        }
        if (user) {
            return res.send('用户名已存在');
        }
        database_1.default.run(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`, [username, password, 'default', 'New user', JSON.stringify([]), 0], function (err) {
            if (err) {
                logger_1.default.error('Error inserting new user', err);
                return res.status(500).send('服务器错误');
            }
            res.redirect('/login');
        });
    });
});
router.get('/logout', (req, res) => {
    res.clearCookie('uid');
    res.clearCookie('token');
    res.redirect('/');
});
exports.default = router;
//# sourceMappingURL=auth.js.map