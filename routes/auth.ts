import { Router } from '../lib/bun-http';
import { issueToken, TOKEN_MAX_AGE_MS } from '../lib/auth-token';
import { User, queryOne, execute } from '../lib/database';
import logger from '../lib/logger';

const router = new Router();

router.get('/login', (req, res, next) => {
    res.render('login');
});

router.post('/login', (req, res, next) => {
    const { username, password } = req.body;
    try {
        const user = queryOne<User>("SELECT id, username, password, role, bio, isBanned FROM users WHERE username = ? AND password = ?", [username, password]);
        if (user) {
            if (user.isBanned) {
                res.send('账号已被封禁');
                return;
            }

            res.cookie('token', issueToken(user), {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: TOKEN_MAX_AGE_MS,
            });
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
