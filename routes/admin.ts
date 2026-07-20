import { Router, UploadHandler } from '../lib/bun-http';
import path from 'path';
import fs from 'fs-extra';
import * as config from '../config';
import { requireRole } from '../middleware/auth';
import { User, Role, query, queryOne, execute } from '../lib/database';
import { createLogger } from '../lib/logger';
const logger = createLogger('Admin');

const router = new Router();
const upload = new UploadHandler({ dest: config.UPLOAD_DIR });

export default (pluginManager: any): Router => {
    router.get('/admin', requireRole('super_user'), (req, res, next) => {
        try {
            const users = query<any>("SELECT id, username, role, isBanned, tags FROM users");
            users.forEach(user => {
                if (user.tags) {
                    try {
                        user.tags = JSON.parse(user.tags);
                    } catch (_) {
                        user.tags = [];
                    }
                }
            });
            const roles = query<Role>("SELECT name FROM roles");
            res.render('admin', { users, roles: roles.map(r => r.name) });
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
            res.redirect('/admin');
        } catch (err) {
            logger.error(`Error unbanning user ${uid}`, err as Error);
            res.status(500).send('服务器错误');
        }
    });

    router.post('/admin/tag', requireRole('super_user'), (req, res, next) => {
        const { uid, tag } = req.body;
        try {
            const user = queryOne<{ tags: string | null }>("SELECT tags FROM users WHERE id = ?", [uid]);
            if (!user) {
                res.status(404).send('用户不存在');
                return;
            }
            let tags: string[] = user.tags ? JSON.parse(user.tags) : [];
            if (!tags.includes(tag)) tags.push(tag);
            execute("UPDATE users SET tags = ? WHERE id = ?", [JSON.stringify(tags), uid]);
            res.redirect('/admin');
        } catch (err) {
            logger.error(`Error tagging user ${uid}`, err as Error);
            res.status(500).send('服务器错误');
        }
    });

    router.post('/admin/addRole', requireRole('super_user'), (req, res, next) => {
        const { roleName } = req.body;
        try {
            const role = queryOne<Role>("SELECT name FROM roles WHERE name = ?", [roleName]);
            if (role) {
                res.send('角色已存在');
                return;
            }
            execute("INSERT INTO roles (name) VALUES (?)", [roleName]);
            res.redirect('/admin');
        } catch (err) {
            logger.error(`Error adding new role ${roleName}`, err as Error);
            res.status(500).send('服务器错误');
        }
    });

    router.get('/admin/plugins', requireRole('super_user'), (req, res, next) => {
        res.render('admin_plugins', { plugins: pluginManager.getList() });
    });

    router.post('/admin/plugins/upload', requireRole('super_user'), upload.single('pluginFile'), (req, res, next) => {
        if (req.file && req.file.originalname.endsWith('.js')) {
            const targetPath = path.join(config.PLUGINS_DIR, req.file.originalname);
            fs.moveSync(req.file.path, targetPath, { overwrite: true });
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