"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const config_1 = __importDefault(require("../config"));
const auth_1 = require("../middleware/auth");
const database_1 = __importDefault(require("../lib/database"));
const logger_1 = __importDefault(require("../lib/logger"));
const router = express_1.default.Router();
const upload = (0, multer_1.default)({ dest: config_1.default.UPLOAD_DIR });
exports.default = (pluginManager) => {
    router.get('/admin', (0, auth_1.requireRole)('super_user'), (req, res) => {
        database_1.default.all("SELECT id, username, role, isBanned, tags FROM users", [], (err, users) => {
            if (err) {
                logger_1.default.error('Error fetching users for admin page', err);
                return res.status(500).send('服务器错误');
            }
            users.forEach(user => {
                if (user.tags) {
                    try {
                        user.tags = JSON.parse(user.tags);
                    }
                    catch (e) {
                        logger_1.default.error(`Error parsing tags for user ${user.id}`, e);
                        user.tags = [];
                    }
                }
            });
            database_1.default.all("SELECT name FROM roles", [], (err, roles) => {
                if (err) {
                    logger_1.default.error('Error fetching roles for admin page', err);
                    return res.status(500).send('服务器错误');
                }
                res.render('admin', { users: users, roles: roles.map((r) => r.name) });
            });
        });
    });
    router.post('/admin/ban', (0, auth_1.requireRole)('super_user'), (req, res) => {
        const { uid } = req.body;
        database_1.default.get("SELECT role FROM users WHERE id = ?", [uid], (err, user) => {
            if (err) {
                logger_1.default.error(`Error fetching user ${uid} for ban`, err);
                return res.status(500).send('服务器错误');
            }
            if (!user)
                return res.status(404).send('用户不存在');
            if (user.role === 'root')
                return res.send("Cannot ban root");
            database_1.default.run("UPDATE users SET isBanned = 1 WHERE id = ?", [uid], (err) => {
                if (err) {
                    logger_1.default.error(`Error banning user ${uid}`, err);
                    return res.status(500).send('服务器错误');
                }
                res.redirect('/admin');
            });
        });
    });
    router.post('/admin/unban', (0, auth_1.requireRole)('super_user'), (req, res) => {
        const { uid } = req.body;
        database_1.default.run("UPDATE users SET isBanned = 0 WHERE id = ?", [uid], (err) => {
            if (err) {
                logger_1.default.error(`Error unbanning user ${uid}`, err);
                return res.status(500).send('服务器错误');
            }
            res.redirect('/admin');
        });
    });
    router.post('/admin/tag', (0, auth_1.requireRole)('super_user'), (req, res) => {
        const { uid, tag } = req.body;
        database_1.default.get("SELECT tags FROM users WHERE id = ?", [uid], (err, user) => {
            if (err) {
                logger_1.default.error(`Error fetching user ${uid} for tagging`, err);
                return res.status(500).send('服务器错误');
            }
            if (!user)
                return res.status(404).send('用户不存在');
            let tags = user.tags ? JSON.parse(user.tags) : [];
            if (!tags.includes(tag)) {
                tags.push(tag);
            }
            database_1.default.run("UPDATE users SET tags = ? WHERE id = ?", [JSON.stringify(tags), uid], (err) => {
                if (err) {
                    logger_1.default.error(`Error tagging user ${uid}`, err);
                    return res.status(500).send('服务器错误');
                }
                res.redirect('/admin');
            });
        });
    });
    router.post('/admin/addRole', (0, auth_1.requireRole)('super_user'), (req, res) => {
        const { roleName } = req.body;
        database_1.default.get("SELECT name FROM roles WHERE name = ?", [roleName], (err, role) => {
            if (err) {
                logger_1.default.error(`Error checking role ${roleName} existence`, err);
                return res.status(500).send('服务器错误');
            }
            if (role)
                return res.send('角色已存在');
            database_1.default.run("INSERT INTO roles (name) VALUES (?)", [roleName], (err) => {
                if (err) {
                    logger_1.default.error(`Error adding new role ${roleName}`, err);
                    return res.status(500).send('服务器错误');
                }
                res.redirect('/admin');
            });
        });
    });
    router.get('/admin/plugins', (0, auth_1.requireRole)('super_user'), (req, res) => {
        res.render('admin_plugins', { plugins: pluginManager.getList() });
    });
    router.post('/admin/plugins/upload', (0, auth_1.requireRole)('super_user'), upload.single('pluginFile'), (req, res) => {
        if (req.file && req.file.originalname.endsWith('.js')) {
            const targetPath = path_1.default.join(config_1.default.PLUGINS_DIR, req.file.originalname);
            fs_extra_1.default.moveSync(req.file.path, targetPath, { overwrite: true });
            pluginManager.loadAll();
        }
        res.redirect('/admin/plugins');
    });
    router.post('/admin/plugins/toggle', (0, auth_1.requireRole)('super_user'), (req, res) => {
        const { filename, enabled } = req.body;
        pluginManager.toggle(filename, enabled === 'true');
        res.redirect('/admin/plugins');
    });
    router.post('/admin/plugins/delete', (0, auth_1.requireRole)('super_user'), (req, res) => {
        pluginManager.delete(req.body.filename);
        res.redirect('/admin/plugins');
    });
    return router;
};
//# sourceMappingURL=admin.js.map