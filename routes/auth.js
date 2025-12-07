const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken'); // 引入 jsonwebtoken
const config = require('../config'); // 引入 config
const { db } = require('../lib/database');
const logger = require('../lib/logger');

// 登录页面
router.get('/login', (req, res) => res.render('login'));

// 处理登录
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT id, username, password, role, isBanned FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (err) {
            logger.error('Error during login', err);
            return res.status(500).send('服务器错误');
        }
        if (user) {
            if (user.isBanned) return res.send('账号已被封禁');

            // 生成 JWT
            const token = jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '1h' }); // JWT 有效期 1 小时

            // 将 JWT 设置为 HttpOnly Cookie
            res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 }); // maxAge 1小时
            res.cookie('uid', user.id); // 保持 uid cookie 以兼容前端

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
router.get('/logout', (req, res) => {
    res.clearCookie('uid');
    res.clearCookie('token'); // 清除 JWT token cookie
    res.redirect('/');
});

module.exports = router;
