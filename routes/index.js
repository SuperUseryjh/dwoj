const express = require('express');
const router = express.Router();
const { db } = require('../lib/database');
const logger = require('../lib/logger');

// 导入其他路由模块
const authRoutes = require('./auth');
const profileRoutes = require('./profile');
const problemRoutes = require('./problem');
const adminRoutes = require('./admin'); // adminRoutes 需要 pluginManager
const discussRoutes = require('./discuss');

module.exports = (pluginManager) => {
    // 首页路由
    router.get('/', (req, res) => {
        db.all("SELECT id, title FROM problems", [], (err, problems) => {
            if (err) {
                logger.error('Error fetching problems for index page', err);
                return res.status(500).send('服务器错误');
            }
            res.render('index', { problems: problems });
        });
    });

    // 使用其他路由
    router.use(authRoutes);
    router.use(profileRoutes);
    router.use(problemRoutes);
    router.use(adminRoutes(pluginManager)); // 传入 pluginManager
    router.use(discussRoutes);

    return router;
};
