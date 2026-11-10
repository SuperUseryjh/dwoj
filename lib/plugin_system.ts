import fs from 'fs';
import path from 'path';
import logger from './logger';

/** 插件实例：直接注入 oj / db（插件 = 可信代码，不做权限代理） */
class Plugin {
    module: Record<string, any>;
    oj: any;
    db: any;
    exports: any;
    pluginSystem: PluginSystem;

    constructor(pluginModule: any, oj: any, db: any, pluginSystemRef: PluginSystem) {
        this.module = pluginModule;
        this.oj = oj;
        this.db = db;
        this.exports = pluginModule.exports || {};
        this.pluginSystem = pluginSystemRef;
    }

    executeHook(hookName: string, ...args: any[]): any {
        if (typeof this.module[hookName] === 'function') {
            const getPluginExports = (pluginName: string) => this.pluginSystem.getPluginExports(pluginName);
            return this.module[hookName](this.oj, this.db, getPluginExports, ...args);
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
    builtin?: boolean;
}

interface PluginState {
    enabled?: boolean;
}

class PluginSystem {
    pluginDir: string;
    plugins: Record<string, PluginInfo> = {};
    oj: any;
    db: any;
    app: any;
    pluginExports: Record<string, any> = {};
    private _builtinEnabled: Set<string> = new Set();
    private _enabledPlugins: PluginInfo[] = [];
    private _configPath: string;
    private _state: Record<string, PluginState> = {};
    private _enabledHooks: Set<string> = new Set();

    constructor(pluginDir: string, ojRef: any, enabledBuiltins: string[] = []) {
        this.pluginDir = pluginDir;
        this.plugins = {};
        this.oj = ojRef;
        this.db = ojRef.db;
        this.app = ojRef.app;
        this.pluginExports = {};
        this._builtinEnabled = new Set(enabledBuiltins.filter(Boolean));
        this._configPath = path.join(pluginDir, 'config.json');

        fs.mkdirSync(pluginDir, { recursive: true });
        this._loadState();
    }

    /** 启停状态存放于 plugins/config.json，不再查库 */
    private _loadState(): void {
        try {
            if (fs.existsSync(this._configPath)) {
                this._state = JSON.parse(fs.readFileSync(this._configPath, 'utf-8')) || {};
            }
        } catch (e) {
            logger.error('[PluginSystem] Failed to read config.json', e as Error);
            this._state = {};
        }
    }

    private _saveState(): void {
        try {
            fs.writeFileSync(this._configPath, JSON.stringify(this._state, null, 2));
        } catch (e) {
            logger.error('[PluginSystem] Failed to write config.json', e as Error);
        }
    }

    private _isEnabled(filename: string, fallback: boolean): boolean {
        const state = this._state[filename];
        return state ? !!state.enabled : fallback;
    }

    async loadAll(): Promise<void> {
        if (!fs.existsSync(this.pluginDir)) fs.mkdirSync(this.pluginDir, { recursive: true });
        const files = fs.readdirSync(this.pluginDir).filter((f: string) => f.endsWith('.js'));
        this.plugins = {};
        this.pluginExports = {};
        this._enabledPlugins = [];
        this._enabledHooks = new Set();
        let stateChanged = false;

        for (const file of files) {
            const fullPath = path.join(this.pluginDir, file);
            try {
                delete require.cache[require.resolve(fullPath)];
                const pluginModule = require(fullPath);

                const manifest = pluginModule.manifest || {};
                const isEnabled = this._isEnabled(file, false);

                if (!this._state[file]) {
                    this._state[file] = { enabled: isEnabled };
                    stateChanged = true;
                }

                const wrappedPlugin = new Plugin(pluginModule, this.oj, this.db, this);

                this.plugins[file] = {
                    module: wrappedPlugin,
                    filename: file,
                    enabled: isEnabled,
                    name: manifest.name || file,
                    description: manifest.description || '',
                    version: manifest.version || '1.0.0',
                };

                if (isEnabled) {
                    this.pluginExports[manifest.name || file] = wrappedPlugin.exports;
                    this._collectHooks(pluginModule);

                    if (typeof pluginModule.onLoad === 'function') {
                        wrappedPlugin.executeHook('onLoad');
                    }
                    if (typeof pluginModule.onRoute === 'function') {
                        logger.info(`[Plugin] Registering routes for ${file}`);
                        wrappedPlugin.executeHook('onRoute', this.app);
                    }
                }
            } catch (e) {
                logger.error(`[Plugin] Failed to load ${file}:`, e as Error);
            }
        }

        // 加载内置插件（默认不启用）
        this._loadBuiltinPlugins();

        this._refreshEnabled();
        if (stateChanged) this._saveState();
    }

    private _collectHooks(pluginModule: Record<string, any>): void {
        // 记录所有导出函数名，用于 emit 的零开销短路
        for (const key of Object.keys(pluginModule)) {
            if (typeof pluginModule[key] === 'function') this._enabledHooks.add(key);
        }
    }

    private _refreshEnabled(): void {
        this._enabledPlugins = Object.values(this.plugins).filter(p => p.enabled);
    }

    /** 是否存在已启用插件实现了某个钩子（用于零开销短路） */
    hasHook(hookName: string): boolean {
        return this._enabledHooks.has(hookName);
    }

    /** 内置插件注册表 */
    private _builtinPluginRegistry(): Record<string, any> {
        const registry: Record<string, any> = {};
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            registry['db-monitor'] = require('./builtin_plugins/db-monitor');
        } catch (e) {
            logger.error('[PluginSystem] Failed to load builtin plugin db-monitor:', e as Error);
        }
        return registry;
    }

    private _loadBuiltinPlugins(): void {
        const registry = this._builtinPluginRegistry();

        for (const [name, pluginModule] of Object.entries(registry)) {
            const manifest = pluginModule.manifest || {};
            const filename = `builtin:${name}`;
            const isEnabled = this._isEnabled(filename, this._builtinEnabled.has(name));

            if (!this._state[filename]) {
                this._state[filename] = { enabled: isEnabled };
                this._saveState();
            }

            const wrappedPlugin = new Plugin(pluginModule, this.oj, this.db, this);

            this.plugins[filename] = {
                module: wrappedPlugin,
                filename,
                enabled: isEnabled,
                name: manifest.name || name,
                description: manifest.description || '',
                version: manifest.version || '1.0.0',
                builtin: true,
            };

            if (isEnabled) {
                this._collectHooks(pluginModule);
                if (typeof pluginModule.onLoad === 'function') {
                    wrappedPlugin.executeHook('onLoad');
                }
                this.pluginExports[manifest.name || name] = wrappedPlugin.exports;
                if (typeof pluginModule.onRoute === 'function') {
                    logger.info(`[Plugin] Registering routes for builtin:${name}`);
                    wrappedPlugin.executeHook('onRoute', this.app);
                }
            }
        }
    }

    getPluginExports(pluginName: string): any {
        return this.pluginExports[pluginName];
    }

    /** 无启用插件时直接返回空数组，避免每请求遍历 */
    emit(hookName: string, ...args: any[]): any[] {
        if (this._enabledPlugins.length === 0 || !this._enabledHooks.has(hookName)) return [];

        const results: any[] = [];
        for (const p of this._enabledPlugins) {
            try {
                const res = p.module.executeHook(hookName, ...args);
                if (res) results.push(res);
            } catch (e) {
                logger.error(`[Plugin Error] [${p.name || p.filename}] [${hookName}]:`, e as Error);
            }
        }
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
                builtin: p.builtin || false,
            });
        });
        const loadedFiles = new Set(Object.keys(this.plugins).filter(k => !k.startsWith('builtin:')));
        if (fs.existsSync(this.pluginDir)) {
            const allFiles = fs.readdirSync(this.pluginDir).filter((f: string) => f.endsWith('.js'));
            allFiles.forEach(f => {
                if (!loadedFiles.has(f)) {
                    list.push({ filename: f, name: "Unknown/Error", enabled: false, builtin: false });
                }
            });
        }
        return list;
    }

    async toggle(filename: string, enabled: boolean): Promise<void> {
        this._state[filename] = { enabled };
        this._saveState();

        if (filename.startsWith('builtin:')) {
            const name = filename.slice('builtin:'.length);
            if (enabled) this._builtinEnabled.add(name);
            else this._builtinEnabled.delete(name);
        }
        await this.loadAll();
    }

    async delete(filename: string): Promise<void> {
        if (filename.startsWith('builtin:')) {
            logger.warn(`[PluginSystem] Cannot delete builtin plugin: ${filename}`);
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
        delete this._state[filename];
        this._saveState();
        await this.loadAll();
    }
}

export default PluginSystem;
