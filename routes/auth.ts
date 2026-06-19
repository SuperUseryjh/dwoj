import { Router } from '../lib/bun-http';
import jwt from 'jsonwebtoken';
import * as config from '../config';
import { User, queryOne, execute } from '../lib/database';
import { createLogger } from '../lib/logger';
const logger = createLogger('Auth');

const router = new Router();

router.get('/login', (req, res, next) => {
    res.render('login');
});

router.post('/login', (req, res, next) => {
    const { username, password } = req.body;
    try {
        const user = queryOne<User>("SELECT id, username, password, role, isBanned FROM users WHERE username = ? AND password = ?", [username, password]);
        if (user) {
            if (user.isBanned) {
                res.send('账号已被封禁');
                return;
            }

            const token = jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '1h' });

            res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
            res.cookie('uid', String(user.id));
            res.redirect('/');
        } else {
            res.send('用户名或密码错误');
        }
    } catch (err) {
        logger.error('Error during login', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/register', (req, res, next) => {
    if (req.cookies['device_banned']) {
        res.send('此设备已被禁止注册');
        return;
    }
    res.render('register');
});

router.post('/register', (req, res, next) => {
    if (req.cookies['device_banned']) {
        res.status(403).send('Banned');
        return;
    }
    const { username, password } = req.body;
    try {
        const user = queryOne<User>("SELECT id FROM users WHERE username = ?", [username]);
        if (user) {
            res.send('用户名已存在');
            return;
        }
        execute(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`,
            [username, password, 'default', 'New user', JSON.stringify([]), 0]);
        res.redirect('/login');
    } catch (err) {
        logger.error('Error during registration', err as Error);
        res.status(500).send('服务器错误');
    }
});

router.get('/logout', (req, res, next) => {
    res.clearCookie('uid');
    res.clearCookie('token');
    res.redirect('/');
});

export default router;