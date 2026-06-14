import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import logger from './logger';
import { queryOne, execute } from './database';

// New Plugin class
class Plugin {
    module: Record<string, any>;
    oj: any;
    db: any;
    token: string;
    permissions: Set<string>;
    exports: any;
    pluginSystem: PluginSystem;
    ojProxy: any;
    dbProxy: any;

    constructor(pluginModule: any, oj: any, db: any, token: string, permissions: string[], pluginSystemRef: PluginSystem) {
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

    _checkPermission(resource: string, action: string, permissionToCheck?: string): void {
        const actualPermission = permissionToCheck || `${resource}_${action}`;
        if (!this.permissions.has(actualPermission)) {
            this.oj.logger.warn(`[Plugin] Plugin with token ${this.token} attempted unauthorized action: ${actualPermission}`);
            throw new Error(`Unauthorized action: ${actualPermission}`);
        }
    }

    _createPermissionProxy(target: any, resourceName: string): any {
        const self = this;
        return new Proxy(target, {
            get(target: any, prop: string | symbol, receiver: any) {
                if (resourceName === 'db') {
                    if (typeof target[prop] === 'function') {
                        const action = String(prop).startsWith('get') || String(prop).startsWith('all') || String(prop).startsWith('each') ? 'read' : 'write';
                        const permissionToCheck = `${action}_${resourceName}`;
                        self._checkPermission(resourceName, action, permissionToCheck);
                        return target[prop].bind(target);
                    }
                    return Reflect.get(target, prop, receiver);
                } else if (resourceName === 'oj') {
                    if (prop === 'app' || prop === 'config' || prop === 'logger') {
                        return Reflect.get(target, prop, receiver);
                    }
                    self._checkPermission(resourceName, 'access');
                    return Reflect.get(target, prop, receiver);
                }
                return Reflect.get(target, prop, receiver);
            },
            apply(target: any, thisArg: any, argumentsList: any[]) {
                self._checkPermission(resourceName, 'execute');
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    }

    executeHook(hookName: string, ...args: any[]): any {
        if (typeof this.module[hookName] === 'function') {
            const getPluginExports = (pluginName: string) => this.pluginSystem.getPluginExports(pluginName);
            return this.module[hookName](this.ojProxy, this.dbProxy, getPluginExports, ...args);
        }
        return null;
    }
}

export interface PluginInfo {
    module: Plugin;
    filename: string;
    enabled: boolean;
    name: string;
    description: string;
    version: string;
    token: string;
    permissions: string[];
}

class PluginSystem {
    pluginDir: string;
    plugins: Record<string, PluginInfo> = {};
    oj: any;
    db: any;
    app: any;
    pluginExports: Record<string, any> = {};

    constructor(pluginDir: string, ojRef: any) {
        this.pluginDir = pluginDir;
        this.plugins = {};
        this.oj = ojRef;
        this.db = ojRef.db;
        this.app = ojRef.app;
        this.pluginExports = {};

        fs.ensureDirSync(pluginDir);
    }

    async loadAll(): Promise<void> {
        const files = fs.readdirSync(this.pluginDir).filter((f: string) => f.endsWith('.js'));
        this.plugins = {};
        this.pluginExports = {};

        for (const file of files) {
            const fullPath = path.join(this.pluginDir, file);
            try {
                delete require.cache[require.resolve(fullPath)];
                const pluginModule = require(fullPath);

                const manifest = pluginModule.manifest || {};
                const requestedPermissions = manifest.permissions || [];

                const dbConfig = queryOne("SELECT enabled, token, permissions FROM plugin_configs WHERE filename = ?", [file]);

                let isEnabled = dbConfig ? (dbConfig.enabled === 1) : false;
                let token = dbConfig ? dbConfig.token : crypto.randomBytes(16).toString('hex');
                let grantedPermissions = dbConfig && dbConfig.permissions ? JSON.parse(dbConfig.permissions) : requestedPermissions;

                this.oj.logger.info(`[PluginSystem] Loading ${file}: dbConfig = ${JSON.stringify(dbConfig)}, grantedPermissions = ${JSON.stringify(grantedPermissions)}`);

                if (!dbConfig || !dbConfig.token) {
                    execute("INSERT OR REPLACE INTO plugin_configs (filename, enabled, token, permissions) VALUES (?, ?, ?, ?)",
                        [file, isEnabled ? 1 : 0, token, JSON.stringify(grantedPermissions)]);
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
                    logger.info(`[Plugin] Hot-registering routes for ${file}`);
                    wrappedPlugin.executeHook('onRoute', this.app);
                }

            } catch (e) {
                logger.error(`[Plugin] Failed to load ${file}:`, e as Error);
            }
        }
    }

    getPluginExports(pluginName: string): any {
        return this.pluginExports[pluginName];
    }

    emit(hookName: string, ...args: any[]): any[] {
        const results: any[] = [];
        Object.values(this.plugins).forEach(p => {
            if (p.enabled) {
                try {
                    const res = p.module.executeHook(hookName, ...args);
                    if (res) results.push(res);
                } catch (e) {
                    logger.error(`[Plugin Error] [${p.name || p.filename}] [${hookName}]:`, e as Error);
                }
            }
        });
        return results;
    }

    getList(): any[] {
        const list: any[] = [];
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
        const loadedFiles = new Set(Object.keys(this.plugins));
        const allFiles = fs.readdirSync(this.pluginDir).filter((f: string) => f.endsWith('.js'));
        allFiles.forEach(f => {
            if (!loadedFiles.has(f)) {
                list.push({ filename: f, name: "Unknown/Error", enabled: false });
            }
        });
        return list;
    }

    async toggle(filename: string, enabled: boolean): Promise<void> {
        const enabledValue = enabled ? 1 : 0;
        execute("UPDATE plugin_configs SET enabled = ? WHERE filename = ?", [enabledValue, filename]);
        await this.loadAll();
    }

    async delete(filename: string): Promise<void> {
        const p = path.join(this.pluginDir, filename);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (e) {
                logger.error(`Error deleting plugin file ${p}`, e as Error);
            }
        }
        execute("DELETE FROM plugin_configs WHERE filename = ?", [filename]);
        await this.loadAll();
    }
}

export default PluginSystem;