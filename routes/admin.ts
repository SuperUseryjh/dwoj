import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import config from '../config';
import { requireRole, ROLE_LV } from '../middleware/auth';
import db from '../lib/database';
import logger from '../lib/logger';
import PluginSystem from '../lib/plugin_system';

const router = express.Router();
const upload = multer({ dest: config.UPLOAD_DIR });

export default (pluginManager: PluginSystem): express.Router => {
    router.get('/admin', requireRole('super_user'), (req, res) => {
        db.all("SELECT id, username, role, isBanned, tags FROM users", [], (err: Error, users: any[]) => {
            if (err) {
                logger.error('Error fetching users for admin page', err);
                return res.status(500).send('服务器错误');
            }
            users.forEach(user => {
                if (user.tags) {
                    try {
                        user.tags = JSON.parse(user.tags);
                    } catch (e) {
                        logger.error(`Error parsing tags for user ${user.id}`, e as Error);
                        user.tags = [];
                    }
                }
            });
            db.all("SELECT name FROM roles", [], (err: Error, roles: any[]) => {
                if (err) {
                    logger.error('Error fetching roles for admin page', err);
                    return res.status(500).send('服务器错误');
                }
                res.render('admin', { users: users, roles: roles.map((r: any) => r.name) });
            });
        });
    });

    router.post('/admin/ban', requireRole('super_user'), (req, res) => {
        const { uid } = req.body;
        db.get("SELECT role FROM users WHERE id = ?", [uid], (err: Error, user: any) => {
            if (err) {
                logger.error(`Error fetching user ${uid} for ban`, err);
                return res.status(500).send('服务器错误');
            }
            if (!user) return res.status(404).send('用户不存在');
            if (user.role === 'root') return res.send("Cannot ban root");

            db.run("UPDATE users SET isBanned = 1 WHERE id = ?", [uid], (err: Error) => {
                if (err) {
                    logger.error(`Error banning user ${uid}`, err);
                    return res.status(500).send('服务器错误');
                }
                res.redirect('/admin');
            });
        });
    });

    router.post('/admin/unban', requireRole('super_user'), (req, res) => {
        const { uid } = req.body;
        db.run("UPDATE users SET isBanned = 0 WHERE id = ?", [uid], (err: Error) => {
            if (err) {
                logger.error(`Error unbanning user ${uid}`, err);
                return res.status(500).send('服务器错误');
            }
            res.redirect('/admin');
        });
    });

    router.post('/admin/tag', requireRole('super_user'), (req, res) => {
        const { uid, tag } = req.body;
        db.get("SELECT tags FROM users WHERE id = ?", [uid], (err: Error, user: any) => {
            if (err) {
                logger.error(`Error fetching user ${uid} for tagging`, err);
                return res.status(500).send('服务器错误');
            }
            if (!user) return res.status(404).send('用户不存在');

            let tags = user.tags ? JSON.parse(user.tags) : [];
            if (!tags.includes(tag)) {
                tags.push(tag);
            }
            db.run("UPDATE users SET tags = ? WHERE id = ?", [JSON.stringify(tags), uid], (err: Error) => {
                if (err) {
                    logger.error(`Error tagging user ${uid}`, err);
                    return res.status(500).send('服务器错误');
                }
                res.redirect('/admin');
            });
        });
    });

    router.post('/admin/addRole', requireRole('super_user'), (req, res) => {
        const { roleName } = req.body;
        db.get("SELECT name FROM roles WHERE name = ?", [roleName], (err: Error, role: any) => {
            if (err) {
                logger.error(`Error checking role ${roleName} existence`, err);
                return res.status(500).send('服务器错误');
            }
            if (role) return res.send('角色已存在');

            db.run("INSERT INTO roles (name) VALUES (?)", [roleName], (err: Error) => {
                if (err) {
                    logger.error(`Error adding new role ${roleName}`, err);
                    return res.status(500).send('服务器错误');
                }
                res.redirect('/admin');
            });
        });
    });

    router.get('/admin/plugins', requireRole('super_user'), (req, res) => {
        res.render('admin_plugins', { plugins: pluginManager.getList() });
    });

    router.post('/admin/plugins/upload', requireRole('super_user'), upload.single('pluginFile'), (req, res) => {
        if (req.file && req.file.originalname.endsWith('.js')) {
            const targetPath = path.join(config.PLUGINS_DIR, req.file.originalname);
            fs.moveSync(req.file.path, targetPath, { overwrite: true });
            pluginManager.loadAll();
        }
        res.redirect('/admin/plugins');
    });

    router.post('/admin/plugins/toggle', requireRole('super_user'), (req, res) => {
        const { filename, enabled } = req.body;
        pluginManager.toggle(filename, enabled === 'true');
        res.redirect('/admin/plugins');
    });

    router.post('/admin/plugins/delete', requireRole('super_user'), (req, res) => {
        pluginManager.delete(req.body.filename);
        res.redirect('/admin/plugins');
    });

    return router;
};
