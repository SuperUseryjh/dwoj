import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import logger from './logger';
import db from './database';
import { Application } from 'express';
import { OJContext, PluginModule, PluginInfo, PluginConfig } from '../types';

class Plugin {
    private module: PluginModule;
    private oj: OJContext;
    private db: any;
    public token: string;
    private permissions: Set<string>;
    public exports: Record<string, any>;
    private pluginSystem: PluginSystem;
    public ojProxy: any;
    public dbProxy: any;

    constructor(pluginModule: PluginModule, oj: OJContext, db: any, token: string, permissions: string[], pluginSystemRef: PluginSystem) {
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

    private _checkPermission(resource: string, action: string, permissionToCheck?: string): void {
        const actualPermission = permissionToCheck || `${resource}_${action}`;
        this.oj.logger.info(`[Plugin] Checking permission: ${actualPermission}, Plugin permissions: ${Array.from(this.permissions).join(', ')}`);
        if (!this.permissions.has(actualPermission)) {
            this.oj.logger.warn(`[Plugin] Plugin with token ${this.token} attempted unauthorized action: ${actualPermission}`);
            throw new Error(`Unauthorized action: ${actualPermission}`);
        }
    }

    private _createPermissionProxy(target: any, resourceName: string): any {
        return new Proxy(target, {
            get: (target: any, prop: string, receiver: any) => {
                if (resourceName === 'db') {
                    if (typeof target[prop] === 'function') {
                        const action = prop.startsWith('get') || prop.startsWith('all') || prop.startsWith('each') ? 'read' : 'write';
                        const permissionToCheck = `${action}_${resourceName}`;
                        this._checkPermission(resourceName, action, permissionToCheck);
                        return target[prop].bind(target);
                    }
                    return Reflect.get(target, prop, receiver);
                } else if (resourceName === 'oj') {
                    if (prop === 'app' || prop === 'config' || prop === 'logger') {
                        return Reflect.get(target, prop, receiver);
                    }
                    this._checkPermission(resourceName, 'access');
                    return Reflect.get(target, prop, receiver);
                }
                return Reflect.get(target, prop, receiver);
            },
            apply: (target: any, thisArg: any, argumentsList: any) => {
                this._checkPermission(resourceName, 'execute');
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    }

    public executeHook(hookName: string, ...args: any[]): any {
        if (typeof this.module[hookName] === 'function') {
            const getPluginExports = (pluginName: string) => this.pluginSystem.getPluginExports(pluginName);
            return this.module[hookName](this.ojProxy, this.dbProxy, getPluginExports, ...args);
        }
        return null;
    }
}

class PluginSystem {
    private pluginDir: string;
    private plugins: Record<string, any>;
    private oj: OJContext;
    private db: any;
    private app: Application;
    private pluginExports: Record<string, any>;

    constructor(pluginDir: string, ojRef: OJContext) {
        this.pluginDir = pluginDir;
        this.plugins = {};
        this.oj = ojRef;
        this.db = ojRef.db;
        this.app = ojRef.app;
        this.pluginExports = {};

        fs.ensureDirSync(pluginDir);
    }

    public async loadAll(): Promise<void> {
        const files = fs.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
        this.plugins = {};
        this.pluginExports = {};

        for (const file of files) {
            const fullPath = path.join(this.pluginDir, file);
            try {
                delete require.cache[require.resolve(fullPath)];
                const pluginModule: PluginModule = require(fullPath);

                const manifest = pluginModule.manifest || {};
                const requestedPermissions = manifest.permissions || [];

                const dbConfig: PluginConfig | undefined = await new Promise((resolve, reject) => {
                    this.db.get("SELECT enabled, token, permissions FROM plugin_configs WHERE filename = ?", [file], (err: Error, row: PluginConfig) => {
                        if (err) reject(err);
                        else resolve(row);
                    });
                });

                let isEnabled = dbConfig ? (dbConfig.enabled === 1) : false;
                let token = dbConfig ? dbConfig.token : crypto.randomBytes(16).toString('hex');
                let grantedPermissions = dbConfig && dbConfig.permissions ? JSON.parse(dbConfig.permissions) : requestedPermissions;

                this.oj.logger.info(`[PluginSystem] Loading ${file}: dbConfig = ${JSON.stringify(dbConfig)}, grantedPermissions = ${JSON.stringify(grantedPermissions)}`);

                if (!dbConfig || !dbConfig.token) {
                    await new Promise((resolve, reject) => {
                        this.db.run("INSERT OR REPLACE INTO plugin_configs (filename, enabled, token, permissions) VALUES (?, ?, ?, ?)",
                            [file, isEnabled ? 1 : 0, token, JSON.stringify(grantedPermissions)],
                            (err: Error) => {
                                if (err) reject(err);
                                else resolve(undefined);
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
                    logger.info(`[Plugin] Hot-registering routes for ${file}`);
                    wrappedPlugin.executeHook('onRoute', this.app);
                }

            } catch (e) {
                logger.error(`[Plugin] Failed to load ${file}:`, e as Error);
            }
        }
    }

    public getPluginExports(pluginName: string): any {
        return this.pluginExports[pluginName];
    }

    public emit(hookName: string, ...args: any[]): any[] {
        let results: any[] = [];
        Object.values(this.plugins).forEach((p: any) => {
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

    public getList(): PluginInfo[] {
        const list: PluginInfo[] = [];
        Object.values(this.plugins).forEach((p: any) => {
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
        const allFiles = fs.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
        allFiles.forEach(f => {
            if (!loadedFiles.has(f)) {
                list.push({ filename: f, name: "Unknown/Error", enabled: false, desc: '', version: '', token: '', permissions: [] });
            }
        });
        return list;
    }

    public async toggle(filename: string, enabled: boolean): Promise<void> {
        const enabledValue = enabled ? 1 : 0;
        await new Promise<void>((resolve, reject) => {
            this.db.run("UPDATE plugin_configs SET enabled = ? WHERE filename = ?", [enabledValue, filename], (err: Error) => {
                if (err) reject(err);
                else resolve();
            });
        });

        await this.loadAll();
    }

    public async delete(filename: string): Promise<void> {
        const p = path.join(this.pluginDir, filename);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (e) {
                logger.error(`Error deleting plugin file ${p}`, e as Error);
            }
        }
        await new Promise<void>((resolve, reject) => {
            this.db.run("DELETE FROM plugin_configs WHERE filename = ?", [filename], (err: Error) => {
                if (err) reject(err);
                else resolve();
            });
        });
        await this.loadAll();
    }
}

export default PluginSystem;
