import { Router, UploadHandler } from '../lib/bun-http';
import path from 'path';
import fs from 'fs';
import * as config from '../config';
import { moveSync } from '../lib/fs-utils';
import { requireRole } from '../middleware/auth';
import { invalidateBanCache } from '../middleware/global';
import { User, query, queryOne, execute } from '../lib/database';
import logger from '../lib/logger';

const router = new Router();
const upload = new UploadHandler({ dest: config.UPLOAD_DIR });

export default (pluginManager: any): Router => {
    router.get('/admin', requireRole('super_user'), (req, res, next) => {
        try {
            const users = query<any>("SELECT id, username, role, isBanned FROM users");
            res.render('admin', { users });
        } catch (err) {
            logger.error('Error fetching data for admin page', err as Error);
            res.status(500).send('服务器错误');
        }
    });

    router.post('/admin/ban', requireRole('super_user'), (req, res, next) => {
        const { uid } = req.body;
        try {
            const user = queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [uid]);
            if (!user) {
                res.status(404).send('用户不存在');
                return;
            }
            if (user.role === 'root') {
                res.send("Cannot ban root");
                return;
            }
            execute("UPDATE users SET isBanned = 1 WHERE id = ?", [uid]);
            invalidateBanCache(Number(uid));
            res.redirect('/admin');
        } catch (err) {
            logger.error(`Error banning user ${uid}`, err as Error);
            res.status(500).send('服务器错误');
        }
    });

    router.post('/admin/unban', requireRole('super_user'), (req, res, next) => {
        const { uid } = req.body;
        try {
            execute("UPDATE users SET isBanned = 0 WHERE id = ?", [uid]);
            invalidateBanCache(Number(uid));
            res.redirect('/admin');
        } catch (err) {
            logger.error(`Error unbanning user ${uid}`, err as Error);
            res.status(500).send('服务器错误');
        }
    });

    router.get('/admin/plugins', requireRole('super_user'), (req, res, next) => {
        res.render('admin_plugins', { plugins: pluginManager.getList() });
    });

    router.post('/admin/plugins/upload', requireRole('super_user'), upload.single('pluginFile'), (req, res, next) => {
        if (req.file && req.file.originalname.endsWith('.js')) {
            if (req.file.size > config.PLUGIN_UPLOAD_LIMIT) {
                try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
                res.status(413).send('插件文件过大（上限 256 KB）');
                return;
            }
            const targetPath = path.join(config.PLUGINS_DIR, req.file.originalname);
            moveSync(req.file.path, targetPath, { overwrite: true });
            pluginManager.loadAll();
        }
        res.redirect('/admin/plugins');
    });

    router.post('/admin/plugins/toggle', requireRole('super_user'), (req, res, next) => {
        const { filename, enabled } = req.body;
        pluginManager.toggle(filename, enabled === 'true');
        res.redirect('/admin/plugins');
    });

    router.post('/admin/plugins/delete', requireRole('super_user'), (req, res, next) => {
        pluginManager.delete(req.body.filename);
        res.redirect('/admin/plugins');
    });

    return router;
};
