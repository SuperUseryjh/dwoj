"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = __importDefault(require("./logger"));
class Plugin {
    constructor(pluginModule, oj, db, token, permissions, pluginSystemRef) {
        this.module = pluginModule;
        this.oj = oj;
        this.db = db;
        this.token = token;
        this.permissions = new Set(permissions || []);
        this.exports = pluginModule.exports || {};
        this.pluginSystem = pluginSystemRef;
        this.ojProxy = this._createPermissionProxy(this.oj, 'oj');
        this.dbProxy = this._createPermissionProxy(this.db, 'db');
    }
    _checkPermission(resource, action, permissionToCheck) {
        const actualPermission = permissionToCheck || `${resource}_${action}`;
        this.oj.logger.info(`[Plugin] Checking permission: ${actualPermission}, Plugin permissions: ${Array.from(this.permissions).join(', ')}`);
        if (!this.permissions.has(actualPermission)) {
            this.oj.logger.warn(`[Plugin] Plugin with token ${this.token} attempted unauthorized action: ${actualPermission}`);
            throw new Error(`Unauthorized action: ${actualPermission}`);
        }
    }
    _createPermissionProxy(target, resourceName) {
        return new Proxy(target, {
            get: (target, prop, receiver) => {
                if (resourceName === 'db') {
                    if (typeof target[prop] === 'function') {
                        const action = prop.startsWith('get') || prop.startsWith('all') || prop.startsWith('each') ? 'read' : 'write';
                        const permissionToCheck = `${action}_${resourceName}`;
                        this._checkPermission(resourceName, action, permissionToCheck);
                        return target[prop].bind(target);
                    }
                    return Reflect.get(target, prop, receiver);
                }
                else if (resourceName === 'oj') {
                    if (prop === 'app' || prop === 'config' || prop === 'logger') {
                        return Reflect.get(target, prop, receiver);
                    }
                    this._checkPermission(resourceName, 'access');
                    return Reflect.get(target, prop, receiver);
                }
                return Reflect.get(target, prop, receiver);
            },
            apply: (target, thisArg, argumentsList) => {
                this._checkPermission(resourceName, 'execute');
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    }
    executeHook(hookName, ...args) {
        if (typeof this.module[hookName] === 'function') {
            const getPluginExports = (pluginName) => this.pluginSystem.getPluginExports(pluginName);
            return this.module[hookName](this.ojProxy, this.dbProxy, getPluginExports, ...args);
        }
        return null;
    }
}
class PluginSystem {
    constructor(pluginDir, ojRef) {
        this.pluginDir = pluginDir;
        this.plugins = {};
        this.oj = ojRef;
        this.db = ojRef.db;
        this.app = ojRef.app;
        this.pluginExports = {};
        fs_extra_1.default.ensureDirSync(pluginDir);
    }
    async loadAll() {
        const files = fs_extra_1.default.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
        this.plugins = {};
        this.pluginExports = {};
        for (const file of files) {
            const fullPath = path_1.default.join(this.pluginDir, file);
            try {
                delete require.cache[require.resolve(fullPath)];
                const pluginModule = require(fullPath);
                const manifest = pluginModule.manifest || {};
                const requestedPermissions = manifest.permissions || [];
                const dbConfig = await new Promise((resolve, reject) => {
                    this.db.get("SELECT enabled, token, permissions FROM plugin_configs WHERE filename = ?", [file], (err, row) => {
                        if (err)
                            reject(err);
                        else
                            resolve(row);
                    });
                });
                let isEnabled = dbConfig ? (dbConfig.enabled === 1) : false;
                let token = dbConfig ? dbConfig.token : crypto_1.default.randomBytes(16).toString('hex');
                let grantedPermissions = dbConfig && dbConfig.permissions ? JSON.parse(dbConfig.permissions) : requestedPermissions;
                this.oj.logger.info(`[PluginSystem] Loading ${file}: dbConfig = ${JSON.stringify(dbConfig)}, grantedPermissions = ${JSON.stringify(grantedPermissions)}`);
                if (!dbConfig || !dbConfig.token) {
                    await new Promise((resolve, reject) => {
                        this.db.run("INSERT OR REPLACE INTO plugin_configs (filename, enabled, token, permissions) VALUES (?, ?, ?, ?)", [file, isEnabled ? 1 : 0, token, JSON.stringify(grantedPermissions)], (err) => {
                            if (err)
                                reject(err);
                            else
                                resolve(undefined);
                        });
                    });
                }
                const wrappedPlugin = new Plugin(pluginModule, this.oj, this.db, token, grantedPermissions, this);
                this.plugins[file] = {
                    module: wrappedPlugin,
                    filename: file,
                    enabled: isEnabled,
                    name: manifest.name || file,
                    description: manifest.description || '',
                    version: manifest.version || '1.0.0',
                    token: token,
                    permissions: grantedPermissions
                };
                if (isEnabled) {
                    this.pluginExports[manifest.name || file] = wrappedPlugin.exports;
                }
                if (isEnabled && typeof pluginModule.onRoute === 'function') {
                    logger_1.default.info(`[Plugin] Hot-registering routes for ${file}`);
                    wrappedPlugin.executeHook('onRoute', this.app);
                }
            }
            catch (e) {
                logger_1.default.error(`[Plugin] Failed to load ${file}:`, e);
            }
        }
    }
    getPluginExports(pluginName) {
        return this.pluginExports[pluginName];
    }
    emit(hookName, ...args) {
        let results = [];
        Object.values(this.plugins).forEach((p) => {
            if (p.enabled) {
                try {
                    const res = p.module.executeHook(hookName, ...args);
                    if (res)
                        results.push(res);
                }
                catch (e) {
                    logger_1.default.error(`[Plugin Error] [${p.name || p.filename}] [${hookName}]:`, e);
                }
            }
        });
        return results;
    }
    getList() {
        const list = [];
        Object.values(this.plugins).forEach((p) => {
            list.push({
                filename: p.filename,
                name: p.name,
                desc: p.description,
                version: p.version,
                enabled: p.enabled,
                token: p.token,
                permissions: p.permissions
            });
        });
        const loadedFiles = new Set(Object.keys(this.plugins));
        const allFiles = fs_extra_1.default.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
        allFiles.forEach(f => {
            if (!loadedFiles.has(f)) {
                list.push({ filename: f, name: "Unknown/Error", enabled: false, desc: '', version: '', token: '', permissions: [] });
            }
        });
        return list;
    }
    async toggle(filename, enabled) {
        const enabledValue = enabled ? 1 : 0;
        await new Promise((resolve, reject) => {
            this.db.run("UPDATE plugin_configs SET enabled = ? WHERE filename = ?", [enabledValue, filename], (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
        await this.loadAll();
    }
    async delete(filename) {
        const p = path_1.default.join(this.pluginDir, filename);
        if (fs_extra_1.default.existsSync(p)) {
            try {
                fs_extra_1.default.unlinkSync(p);
            }
            catch (e) {
                logger_1.default.error(`Error deleting plugin file ${p}`, e);
            }
        }
        await new Promise((resolve, reject) => {
            this.db.run("DELETE FROM plugin_configs WHERE filename = ?", [filename], (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
        await this.loadAll();
    }
}
exports.default = PluginSystem;
//# sourceMappingURL=plugin_system.js.map