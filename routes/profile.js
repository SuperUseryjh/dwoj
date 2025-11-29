const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/auth');
const { db } = require('../lib/database');
const logger = require('../lib/logger');

// 个人信息页面
router.get('/profile', requireLogin, (req, res) => res.render('profile'));

// 处理个人信息修改
router.post('/profile', requireLogin, (req, res) => {
    const { password, bio } = req.body;
    let updateFields = [];
    let updateValues = [];

    if (password) {
        updateFields.push("password = ?");
        updateValues.push(password);
    }
    if (bio !== undefined) {
        updateFields.push("bio = ?");
        updateValues.push(bio);
    }

    if (updateFields.length === 0) {
        return res.redirect('/profile');
    }

    updateValues.push(req.user.id);

    db.run(`UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`, updateValues, function(err) {
        if (err) {
            logger.error('Error updating user profile', err);
            return res.status(500).send('服务器错误');
        }
        res.redirect('/profile');
    });
});

module.exports = router;
