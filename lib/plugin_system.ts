import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { createLogger, normalizeModuleName } from './logger';



import { queryOne, execute, upsertSql } from './database';
import { createScopedApp } from './plugin/route_auth';

const logger = createLogger('plugin');

/**
 * 判断一个模块导出对象是否「看起来像插件」：
 * 有 manifest、有任一个钩子，或定义了导出集合。
 */
function looksLikePlugin(value: any): boolean {
    if (!value || typeof value !== 'object') return false;
    const hookNames = ['onLoad', 'onRoute', 'injectHeader', 'injectFooter', 'beforeJudge', 'afterJudge'];
    return 'manifest' in value
        || 'exports' in value
        || 'pluginExports' in value
        || hookNames.some(name => typeof value[name] === 'function');
}

/**
 * 把动态 import 的结果归一化成插件模块对象。
 *
 * 同时兼容两种写法：
 *   - ES Module：`export const manifest = ...` / `export function onLoad ...`
 *   - CommonJS（历史插件）：`module.exports = { manifest, ... }`（import 后位于 default）
 */
function normalizePluginNamespace(ns: any): any {
    if (ns && looksLikePlugin(ns.default)) return ns.default;
    return ns;
}

/** 动态加载插件文件；带时间戳参数，保证重新加载时不会命中模块缓存 */
async function loadPluginModule(fullPath: string): Promise<any> {
    const url = `${pathToFileURL(fullPath).href}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ns = await import(url);
    return normalizePluginNamespace(ns);
}

// New Plugin class
/**
 * 插件日志的模块名：
 *   优先用 manifest.name，没有就用文件名（内置插件去掉 "builtin:" 前缀），
 *   规整成 ≤6 字符的小写标识；实在推导不出来就退回 "plugin"。
 */
export function resolveLogModule(name: string | undefined, fallback: string): string {
    const base = String(name || fallback).replace(/^builtin:/, '');
    return normalizeModuleName(base) || 'plugin';
}

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

    /** 插件日志的模块名（≤6 字符），由 manifest.name / 文件名推导，见 resolveLogModule */
    readonly logModule: string;
    /** 插件注册路由时的归属名（manifest.name / 文件名），用于路由权限校验 */
    readonly owner: string;

    constructor(
        pluginModule: any,
        oj: any,
        db: any,
        token: string,
        permissions: string[],
        pluginSystemRef: PluginSystem,
        logModule: string = 'plugin',
        owner: string = '',
    ) {
        this.module = pluginModule;
        this.logModule = logModule;
        this.owner = owner || pluginModule?.manifest?.name || logModule;
        // 给插件一个带自己名字的 logger：oj.logger.info() 会打印成 [INFO][插件名]
        // 并把 app 换成受限视图：注册的路由会自动带上归属与权限元数据
        this.oj = {
            ...oj,
            app: oj?.app ? createScopedApp(oj.app, this.owner) : oj?.app,
            logger: createLogger(logModule),
        };
        this.db = db;
        this.token = token;
        this.permissions = new Set(permissions || []);
        this.exports = pluginModule.exports || pluginModule.pluginExports || {};
        this.pluginSystem = pluginSystemRef;

        this.ojProxy = this._createPermissionProxy(this.oj, 'oj');
        this.dbProxy = this._createPermissionProxy(this.db, 'db');
    }

    _checkPermission(resource: string, action: string, permissionToCheck?: string): void {
        const actualPermission = permissionToCheck || `${resource}_${action}`;
        if (!this.permissions.has(actualPermission)) {
            logger.warn(`plugin attempted unauthorized action: ${actualPermission}`);
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
    builtin?: boolean;
}

class PluginSystem {
    pluginDir: string;
    plugins: Record<string, PluginInfo> = {};
    oj: any;
    db: any;
    app: any;
    pluginExports: Record<string, any> = {};
    private _builtinEnabled: Set<string> = new Set();

    constructor(pluginDir: string, ojRef: any, enabledBuiltins: string[] = []) {
        this.pluginDir = pluginDir;
        this.plugins = {};
        this.oj = ojRef;
        this.db = ojRef.db;
        this.app = ojRef.app;
        this.pluginExports = {};
        this._builtinEnabled = new Set(enabledBuiltins.filter(Boolean));

        fs.ensureDirSync(pluginDir);
    }

    async loadAll(): Promise<void> {
        const files = fs.readdirSync(this.pluginDir).filter((f: string) => f.endsWith('.js'));
        this.plugins = {};
        this.pluginExports = {};

        for (const file of files) {
            const fullPath = path.join(this.pluginDir, file);
            let exportKey: string | null = null;
            try {
                const pluginModule = await loadPluginModule(fullPath);

                const manifest = pluginModule.manifest || {};
                const requestedPermissions = manifest.permissions || [];
                exportKey = manifest.name || file;

                const dbConfig = await queryOne<{ enabled: number; token: string; permissions: string | null }>(
                    "SELECT enabled, token, permissions FROM plugin_configs WHERE filename = ?", [file]
                );

                let isEnabled = dbConfig ? (dbConfig.enabled === 1) : false;
                let token = dbConfig ? dbConfig.token : crypto.randomBytes(16).toString('hex');
                let grantedPermissions = dbConfig && dbConfig.permissions ? JSON.parse(dbConfig.permissions) : requestedPermissions;

                logger.info(`loading ${file}: dbConfig = ${JSON.stringify(dbConfig)}, grantedPermissions = ${JSON.stringify(grantedPermissions)}`);

                if (!dbConfig || !dbConfig.token) {
                    // 不同数据库的 upsert 语法不同，交给数据库层生成
                    await execute(upsertSql(
                        'plugin_configs',
                        ['filename', 'enabled', 'token', 'permissions'],
                        ['filename'],
                        ['enabled', 'token', 'permissions'],
                    ),
                        [file, isEnabled ? 1 : 0, token, JSON.stringify(grantedPermissions)]);
                }

                const logModule = resolveLogModule(manifest.name, file);
                const wrappedPlugin = new Plugin(pluginModule, this.oj, this.db, token, grantedPermissions, this, logModule, manifest.name || file);

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

                if (isEnabled) {
                    // 外部插件此前漏掉了 onLoad（只有内置插件会调用），
                    // 导致插件没办法在加载阶段初始化自己的日志/状态
                    if (typeof pluginModule.onLoad === 'function') {
                        wrappedPlugin.executeHook('onLoad');
                    }
                    if (typeof pluginModule.onRoute === 'function') {
                        logger.info(`hot-registering routes for ${file}`);
                        wrappedPlugin.executeHook('onRoute', wrappedPlugin.oj.app);
                    }
                }

            } catch (e) {
                logger.error(`Failed to load ${file}:`, e as Error);
                // 加载/钩子执行失败时不能留下“已启用”的假象：
                // 保留条目（便于管理界面看到并排查），但标记为禁用并撤销导出。
                const entry = this.plugins[file];
                if (entry) entry.enabled = false;
                if (exportKey) delete this.pluginExports[exportKey];
            }
        }

        // 加载内置插件
        this._loadBuiltinPlugins();
    }

    /** 内置插件注册表 */
    private _builtinPluginRegistry(): Record<string, any> {
        const registry: Record<string, any> = {};
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            registry['db-monitor'] = require('./builtin_plugins/db-monitor');
        } catch (e) {
            logger.error('Failed to load builtin plugin db-monitor:', e as Error);
        }
        return registry;
    }

    private _loadBuiltinPlugins(): void {
        const registry = this._builtinPluginRegistry();

        for (const [name, pluginModule] of Object.entries(registry)) {
            const manifest = pluginModule.manifest || {};
            const isEnabled = this._builtinEnabled.has(name);
            const token = `builtin:${name}`;
            const permissions = manifest.permissions || [];

            const logModule = resolveLogModule(manifest.name, `builtin:${name}`);
            const wrappedPlugin = new Plugin(pluginModule, this.oj, this.db, token, permissions, this, logModule, manifest.name || name);

            const filename = `builtin:${name}`;
            this.plugins[filename] = {
                module: wrappedPlugin,
                filename,
                enabled: isEnabled,
                name: manifest.name || name,
                description: manifest.description || '',
                version: manifest.version || '1.0.0',
                token,
                permissions,
                builtin: true,
            };

            if (isEnabled) {
                if (typeof pluginModule.onLoad === 'function') {
                    wrappedPlugin.executeHook('onLoad');
                }
                this.pluginExports[manifest.name || name] = wrappedPlugin.exports;
                if (typeof pluginModule.onRoute === 'function') {
                    logger.info(`Hot-registering routes for builtin:${name}`);
                    wrappedPlugin.executeHook('onRoute', wrappedPlugin.oj.app);
                }
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
                    logger.error(`hook ${hookName} failed in ${p.name || p.filename}`, e as Error);
                }
            }
        });
        return results;
    }

    /**
     * 执行页面注入钩子，把各插件返回的 HTML 片段拼接起来。
     * 供 HTTP 进程通过 IPC 调用（单进程模式下直接调用）。
     */
    async inject(req: any): Promise<{ header: string; footer: string }> {
        const collect = (hookName: string): string => this.emit(hookName, req)
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .join('\n');
        return { header: collect('injectHeader'), footer: collect('injectFooter') };
    }

    /**
     * 执行判题钩子。插件可以直接修改传入的 submission，返回值会经 IPC 带回调用方。
     */
    async runJudgeHook(hookName: string, submission: any): Promise<any> {
        this.emit(hookName, submission);
        return submission;
    }

    /** 重新扫描插件目录（管理界面启用/禁用/上传后使用） */
    async reload(): Promise<void> {
        await this.loadAll();
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
                permissions: p.permissions,
                builtin: p.builtin || false,
            });
        });
        const loadedFiles = new Set(Object.keys(this.plugins).filter(k => !k.startsWith('builtin:')));
        const allFiles = fs.readdirSync(this.pluginDir).filter((f: string) => f.endsWith('.js'));
        allFiles.forEach(f => {
            if (!loadedFiles.has(f)) {
                list.push({ filename: f, name: "Unknown/Error", enabled: false, builtin: false });
            }
        });
        return list;
    }

    async toggle(filename: string, enabled: boolean): Promise<void> {
        if (filename.startsWith('builtin:')) {
            const name = filename.slice('builtin:'.length);
            if (enabled) this._builtinEnabled.add(name);
            else this._builtinEnabled.delete(name);
        } else {
            const enabledValue = enabled ? 1 : 0;
            await execute("UPDATE plugin_configs SET enabled = ? WHERE filename = ?", [enabledValue, filename]);
        }
        await this.loadAll();
    }

    async delete(filename: string): Promise<void> {
        if (filename.startsWith('builtin:')) {
            logger.warn(`Cannot delete builtin plugin: ${filename}`);
            return;
        }
        const p = path.join(this.pluginDir, filename);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (e) {
                logger.error(`Error deleting plugin file ${p}`, e as Error);
            }
        }
        await execute("DELETE FROM plugin_configs WHERE filename = ?", [filename]);
        await this.loadAll();
    }
}

export default PluginSystem;