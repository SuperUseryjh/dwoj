const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');
const { db } = require('./database'); // 引入 db 模块
const crypto = require('crypto'); // For generating tokens

// New Plugin class
class Plugin {
    constructor(pluginModule, oj, db, token, permissions, pluginSystemRef) {
        this.module = pluginModule;
        this.oj = oj;
        this.db = db;
        this.token = token;
        this.permissions = new Set(permissions || []); // Store granted permissions
        this.exports = pluginModule.exports || {}; // Store plugin's exposed functions/data
        this.pluginSystem = pluginSystemRef; // Store reference to PluginSystem

        // Create permission-aware proxies for oj and db
        this.ojProxy = this._createPermissionProxy(this.oj, 'oj');
        this.dbProxy = this._createPermissionProxy(this.db, 'db');
    }

    _checkPermission(resource, action, permissionToCheck) { // Add permissionToCheck parameter
        const actualPermission = permissionToCheck || `${resource}_${action}`; // Use permissionToCheck if provided, otherwise default
        this.oj.logger.info(`[Plugin] Checking permission: ${actualPermission}, Plugin permissions: ${Array.from(this.permissions).join(', ')}`); // 添加调试日志
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

                        // Explicitly bind the function to the original target (db object)
                        return target[prop].bind(target);
                    }
                    // If it's not a function, just return the property
                    return Reflect.get(target, prop, receiver);
                } else if (resourceName === 'oj') {
                    // For oj, we'll need more specific permission checks based on the property/method
                    // For now, let's allow access to app and config without specific oj permissions
                    if (prop === 'app' || prop === 'config' || prop === 'logger') {
                        return Reflect.get(target, prop, receiver);
                    }
                    // For other oj properties/methods, we might need specific permissions
                    // For example, if oj had an 'executeCommand' method, it might require 'oj_execute_command'
                    // For now, let's assume general 'oj_access' for other properties
                    this._checkPermission(resourceName, 'access');
                    return Reflect.get(target, prop, receiver);
                }
                return Reflect.get(target, prop, receiver);
            },
            apply: (target, thisArg, argumentsList) => {
                // This handles direct function calls if the target itself is a function
                // Not typically used for db or oj objects, but good to have for completeness
                this._checkPermission(resourceName, 'execute'); // Generic execute permission
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    }

    // Execute a plugin hook with permission-aware oj and db
    executeHook(hookName, ...args) {
        if (typeof this.module[hookName] === 'function') {
            // Pass the permission-aware proxies and a way to access other plugin exports to the plugin
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
        this.oj = ojRef; // Store the full oj object
        this.db = ojRef.db; // Extract db for convenience
        this.app = ojRef.app; // Extract app for convenience 
        this.pluginExports = {}; // Store exposed functions/data from all enabled plugins 
        
        fs.ensureDirSync(pluginDir);
    }

    async loadAll() {
        const files = fs.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
        this.plugins = {};
        this.pluginExports = {}; // Clear exports before reloading all plugins

        for (const file of files) {
            const fullPath = path.join(this.pluginDir, file);
            try {
                delete require.cache[require.resolve(fullPath)];
                const pluginModule = require(fullPath); // Renamed to pluginModule

                const manifest = pluginModule.manifest || {};
                const requestedPermissions = manifest.permissions || [];

                // Get plugin config and permissions from DB
                const dbConfig = await new Promise((resolve, reject) => {
                    this.db.get("SELECT enabled, token, permissions FROM plugin_configs WHERE filename = ?", [file], (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    });
                });

                let isEnabled = dbConfig ? (dbConfig.enabled === 1) : false;
                let token = dbConfig ? dbConfig.token : crypto.randomBytes(16).toString('hex');
                let grantedPermissions = dbConfig && dbConfig.permissions ? JSON.parse(dbConfig.permissions) : requestedPermissions; // For now, grant all requested if new

                this.oj.logger.info(`[PluginSystem] Loading ${file}: dbConfig = ${JSON.stringify(dbConfig)}, grantedPermissions = ${JSON.stringify(grantedPermissions)}`);

                // If new plugin or token missing, save to DB
                if (!dbConfig || !dbConfig.token) {
                    await new Promise((resolve, reject) => {
                        this.db.run("INSERT OR REPLACE INTO plugin_configs (filename, enabled, token, permissions) VALUES (?, ?, ?, ?)",
                            [file, isEnabled ? 1 : 0, token, JSON.stringify(grantedPermissions)],
                            (err) => {
                                if (err) reject(err);
                                else resolve();
                            });
                    });
                }

                const wrappedPlugin = new Plugin(pluginModule, this.oj, this.db, token, grantedPermissions, this); // Pass this (PluginSystem instance)

                this.plugins[file] = {
                    module: wrappedPlugin, // Store the wrapped plugin
                    filename: file,
                    enabled: isEnabled,
                    name: manifest.name || file,
                    description: manifest.description || '',
                    version: manifest.version || '1.0.0',
                    token: token,
                    permissions: grantedPermissions
                };

                // If plugin is enabled, collect its exports
                if (isEnabled) {
                    this.pluginExports[manifest.name || file] = wrappedPlugin.exports;
                }

                // If plugin is enabled and has onRoute hook, execute it via the wrapper
                if (isEnabled && typeof pluginModule.onRoute === 'function') {
                    logger.info(`[Plugin] Hot-registering routes for ${file}`);
                    wrappedPlugin.executeHook('onRoute', this.app); // Pass app directly for route registration
                }

            } catch (e) {
                logger.error(`[Plugin] Failed to load ${file}:`, e);
            }
        }
    }

    getPluginExports(pluginName) {
        return this.pluginExports[pluginName];
    }

    emit(hookName, ...args) {
        let results = [];
        Object.values(this.plugins).forEach(p => {
            if (p.enabled) { // Check if the plugin is enabled
                try {
                    // Call executeHook on the wrapped plugin module
                    const res = p.module.executeHook(hookName, ...args);
                    if (res) results.push(res);
                } catch (e) {
                    logger.error(`[Plugin Error] [${p.name || p.filename}] [${hookName}]:`, e);
                }
            }
        });
        return results;
    }

    getList() {
        const list = [];
        // Iterate over the loaded plugins directly from this.plugins
        Object.values(this.plugins).forEach(p => {
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
        // Also include files that are in the directory but not loaded (e.g., due to errors)
        const loadedFiles = new Set(Object.keys(this.plugins));
        const allFiles = fs.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
        allFiles.forEach(f => {
            if (!loadedFiles.has(f)) {
                list.push({ filename: f, name: "Unknown/Error", enabled: false });
            }
        });
        return list;
    }

    async toggle(filename, enabled) {
        const enabledValue = enabled ? 1 : 0; // SQLite 存储 0/1
        await new Promise((resolve, reject) => {
            // Update only the enabled status, keep token and permissions
            this.db.run("UPDATE plugin_configs SET enabled = ? WHERE filename = ?", [enabledValue, filename], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        await this.loadAll(); // Reload to refresh memory state and routes
    }

    async delete(filename) {
        const p = path.join(this.pluginDir, filename);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (e) {
                logger.error(`Error deleting plugin file ${p}`, e);
            }
        }
        await new Promise((resolve, reject) => {
            this.db.run("DELETE FROM plugin_configs WHERE filename = ?", [filename], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        await this.loadAll();
    }
}

module.exports = PluginSystem;