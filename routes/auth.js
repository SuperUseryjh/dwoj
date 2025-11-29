const express = require('express');
const router = express.Router();
const { db } = require('../lib/database');
const logger = require('../lib/logger');

// 登录页面
router.get('/login', (req, res) => res.render('login'));

// 处理登录
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT id, username, password, isBanned FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (err) {
            logger.error('Error during login', err);
            return res.status(500).send('服务器错误');
        }
        if (user) {
            if (user.isBanned) return res.send('账号已被封禁');
            res.cookie('uid', user.id);
            res.redirect('/');
        } else {
            res.send('用户名或密码错误');
        }
    });
});

// 注册页面
router.get('/register', (req, res) => {
    if (req.cookies['device_banned']) return res.send('此设备已被禁止注册');
    res.render('register');
});

// 处理注册
router.post('/register', (req, res) => {
    if (req.cookies['device_banned']) return res.status(403).send('Banned');
    const { username, password } = req.body;
    db.get("SELECT id FROM users WHERE username = ?", [username], (err, user) => {
        if (err) {
            logger.error('Error during registration check', err);
            return res.status(500).send('服务器错误');
        }
        if (user) {
            return res.send('用户名已存在');
        }
        db.run(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`, 
            [username, password, 'default', 'New user', JSON.stringify([]), 0], function(err) {
            if (err) {
                logger.error('Error inserting new user', err);
                return res.status(500).send('服务器错误');
            }
            res.redirect('/login');
        });
    });
});

// 注销
router.get('/logout', (req, res) => { res.clearCookie('uid'); res.redirect('/'); });

module.exports = router;
