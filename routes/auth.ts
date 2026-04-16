import express from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import db from '../lib/database';
import logger from '../lib/logger';

const router = express.Router();

router.get('/login', (req, res) => res.render('login'));

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT id, username, password, role, isBanned FROM users WHERE username = ? AND password = ?", [username, password], (err: Error, user: any) => {
        if (err) {
            logger.error('Error during login', err);
            return res.status(500).send('服务器错误');
        }
        if (user) {
            if (user.isBanned) return res.send('账号已被封禁');

            const token = jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '1h' });

            res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
            res.cookie('uid', user.id);

            res.redirect('/');
        } else {
            res.send('用户名或密码错误');
        }
    });
});

router.get('/register', (req, res) => {
    if (req.cookies['device_banned']) return res.send('此设备已被禁止注册');
    res.render('register');
});

router.post('/register', (req, res) => {
    if (req.cookies['device_banned']) return res.status(403).send('Banned');
    const { username, password } = req.body;
    db.get("SELECT id FROM users WHERE username = ?", [username], (err: Error, user: any) => {
        if (err) {
            logger.error('Error during registration check', err);
            return res.status(500).send('服务器错误');
        }
        if (user) {
            return res.send('用户名已存在');
        }
        db.run(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`,
            [username, password, 'default', 'New user', JSON.stringify([]), 0], function(err: Error) {
                if (err) {
                    logger.error('Error inserting new user', err);
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

export default router;
