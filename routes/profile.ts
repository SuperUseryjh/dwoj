import { Router } from '../lib/bun-http';
import { requireLogin } from '../middleware/auth';
import { issueToken, TOKEN_MAX_AGE_MS } from '../lib/auth-token';
import { execute } from '../lib/database';
import logger from '../lib/logger';

const router = new Router();

router.get('/profile', requireLogin, (req, res, next) => {
    res.render('profile');
});

router.post('/profile', requireLogin, (req, res, next) => {
    const { password, bio } = req.body;
    const updateFields: string[] = [];
    const updateValues: any[] = [];

    if (password) {
        updateFields.push("password = ?");
        updateValues.push(password);
    }
    if (bio !== undefined) {
        updateFields.push("bio = ?");
        updateValues.push(bio);
    }

    if (updateFields.length === 0) {
        res.redirect('/profile');
        return;
    }

    updateValues.push(req.user.id);

    try {
        execute(`UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`, updateValues);

        // 重新签发 token，确保 bio 等展示字段同步
        res.cookie('token', issueToken({
            id: req.user.id,
            username: req.user.username,
            role: req.user.role,
            bio: bio !== undefined ? bio : req.user.bio,
        }), {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: TOKEN_MAX_AGE_MS,
        });
        res.redirect('/profile');
    } catch (err) {
        logger.error('Error updating user profile', err as Error);
        res.status(500).send('服务器错误');
    }
});

export default router;