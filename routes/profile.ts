import { Router } from '../lib/bun-http';
import { requireLogin } from '../middleware/auth';
import { execute } from '../lib/database';
import { createLogger } from '../lib/logger';
const logger = createLogger('Profile');

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
        res.redirect('/profile');
    } catch (err) {
        logger.error('Error updating user profile', err as Error);
        res.status(500).send('服务器错误');
    }
});

export default router;