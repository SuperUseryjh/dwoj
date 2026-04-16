import express from 'express';
import { requireLogin } from '../middleware/auth';
import db from '../lib/database';
import logger from '../lib/logger';

const router = express.Router();

router.get('/profile', requireLogin, (req, res) => res.render('profile'));

router.post('/profile', requireLogin, (req, res) => {
    const { password, bio } = req.body;
    let updateFields: string[] = [];
    let updateValues: any[] = [];

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

    updateValues.push(req.user!.id);

    db.run(`UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`, updateValues, function(err: Error) {
        if (err) {
            logger.error('Error updating user profile', err);
            return res.status(500).send('服务器错误');
        }
        res.redirect('/profile');
    });
});

export default router;
