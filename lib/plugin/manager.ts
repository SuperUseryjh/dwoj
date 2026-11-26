import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import * as config from '../../config';
import { createLogger, normalizeModuleName } from '../logger';
import { queryOne, execute, upsertSql, db as databaseDb } from '../database';
import { App, Router } from '../bun-http';
import { BUILTIN_PLUGINS } from '../builtin_plugins';
import { discoverPluginFiles, loadPluginDefinition } from './loader';
import { createPluginDb, normalizeStoredPermissions } from './permissions';
import { RouteRegistry, createPluginRouter } from './routes';
import type {
    PluginContext,
    PluginDefinition,
    PluginHookName,
    PluginInfo,
    PluginPermission,
    PluginRequest,
} from './types';

const logger = createLogger('plugin');

export interface PluginManagerOptions {
    app: App;
    builtinEnabled?: string[];
    /** 测试注入用；默认使用 lib/builtin_plugins 注册表 */
    builtinPlugins?: PluginDefinition[];
}

interface PluginEntryBase {
    info: PluginInfo;
}

interface LoadedPluginEntry extends PluginEntryBase {
    definition: PluginDefinition;
    ctx: PluginContext;
}

interface FailedPluginEntry extends PluginEntryBase {
    definition?: undefined;
    ctx?: undefined;
}

type PluginEntry = LoadedPluginEntry | FailedPluginEntry;

/** 插件日志模块名：优先插件名，规整成 ≤6 字符的小写标识 */
function resolveLogModule(name: string | undefined, fallback: string): string {
    const base = String(name || fallback).replace(/^builtin:/, '');
    return normalizeModuleName(base) || 'plugin';
}

function errorMessage(err: unknown): string {
    return (err as Error)?.message || String(err);
}

/** 把 static styles / injectStyles 的返回值统一成 CSS 片段列表 */
function cssParts(value: unknown): string[] {
    if (typeof value === 'string') return value.trim() ? [value] : [];
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    }
    return [];
}

/** 每个插件一个 <style>，方便 DevTools 定位，也便于禁用插件时整体移除 */
function pluginStyleTag(name: string, css: string): string {
    const attr = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<style data-plugin="${attr}">\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`;
}

/**
 * 插件管理器：唯一加载/调度插件代码的地方。
 *
 * 生命周期：
 *   1. 加载与校验所有定义（外部文件 + 内置注册表）；
 *   2. 读取数据库状态，创建 Context；
 *   3. 先注册所有 api，再依次执行 `setup`；
 *   4. 执行 `routes` 并把成功的路由挂到稳定的 hostRouter 上。
 *
 * hostRouter 只在第一次 loadAll 时挂到 App 一次，重载时通过
 * `Router.reset()` 清空，避免单进程模式下重复注册路由。
 */
export class PluginManager {
    private readonly app: App;
    private readonly pluginDir: string;
    private readonly builtinPlugins: PluginDefinition[];
    private readonly builtinEnabled: Set<string>;
    private readonly hostRouter = new Router();
    private readonly routeRegistry: RouteRegistry;
    private readonly entries = new Map<string, PluginEntry>();
    private readonly apiByName = new Map<string, any>();
    private mounted = false;

    constructor(pluginDir: string, options: PluginManagerOptions) {
        this.pluginDir = pluginDir;
        this.app = options.app;
        this.builtinPlugins = options.builtinPlugins ?? BUILTIN_PLUGINS;
        this.builtinEnabled = new Set((options.builtinEnabled || []).filter(Boolean));
        this.routeRegistry = new RouteRegistry(options.app);

        fs.ensureDirSync(pluginDir);
    }

    async loadAll(): Promise<void> {
        fs.ensureDirSync(this.pluginDir);

        this.hostRouter.reset();
        this.routeRegistry.reset();
        this.entries.clear();
        this.apiByName.clear();

        if (!this.mounted) {
            this.app.use(this.hostRouter);
            this.mounted = true;
        }

        // 1. 外部插件
        for (const file of discoverPluginFiles(this.pluginDir)) {
            try {
                const definition = await loadPluginDefinition(path.join(this.pluginDir, file));
                await this.addEntry(file, definition, false);
            } catch (err) {
                // 即使加载失败也要保证数据库里有配置行，否则管理界面的启用/禁用无法生效
                let token = '';
                try {
                    token = await this.ensureConfigRow(file);
                } catch (dbErr) {
                    logger.error(`failed to ensure plugin config for ${file}`, dbErr as Error);
                }
                this.entries.set(file, {
                    info: {
                        filename: file,
                        name: file,
                        version: '',
                        description: '',
                        status: 'error',
                        error: errorMessage(err),
                        token,
                        permissions: [],
                        builtin: false,
                    },
                });
            }
        }

        // 2. 内置插件
        for (const definition of this.builtinPlugins) {
            await this.addEntry(`builtin:${definition.name}`, definition, true);
        }

        // 3. 先注册 api，保证 setup 中 ctx.plugins.get() 可用
        for (const entry of this.entries.values()) {
            if (entry.info.status !== 'enabled' || !entry.definition) continue;
            const name = entry.definition.name;
            if (this.apiByName.has(name)) {
                // 不要撤销已注册的同名 api，只把后来者标记为错误
                this.fail(entry, `插件名 ${name} 重复`, { removeApi: false });
                continue;
            }
            // 没有 api 的插件注册为 undefined，ctx.plugins.get() 会返回 undefined
            this.apiByName.set(name, entry.definition.api);
        }

        // 4. setup
        for (const entry of this.entries.values()) {
            if (entry.info.status !== 'enabled' || !entry.definition?.setup || !entry.ctx) continue;
            try {
                await entry.definition.setup(entry.ctx);
            } catch (err) {
                this.fail(entry, `setup 失败：${errorMessage(err)}`);
            }
        }

        // 5. routes（先注册到插件自己的 Router，全部成功后再挂载）
        for (const entry of this.entries.values()) {
            if (entry.info.status !== 'enabled' || !entry.definition?.routes || !entry.ctx) continue;

            const { router, view } = createPluginRouter(entry.definition.name, this.routeRegistry);
            try {
                await entry.definition.routes(view, entry.ctx);
                this.hostRouter.use(router);
            } catch (err) {
                this.routeRegistry.release(entry.definition.name);
                this.fail(entry, `routes 失败：${errorMessage(err)}`);
            }
        }
    }

    /** 确保外部插件在数据库里有一行配置（加载失败时也要能启用/禁用） */
    private async ensureConfigRow(filename: string): Promise<string> {
        const row = await queryOne<{ token: string }>(
            'SELECT token FROM plugin_configs WHERE filename = ?',
            [filename],
        );
        if (row?.token) return row.token;

        const token = crypto.randomBytes(16).toString('hex');
        await execute(upsertSql(
            'plugin_configs',
            ['filename', 'enabled', 'token', 'permissions'],
            ['filename'],
            ['enabled', 'token', 'permissions'],
        // permissions 留 NULL：等插件修好首次加载成功时再按定义自动授予
        ), [filename, 0, token, null]);
        return token;
    }

    private async addEntry(filename: string, definition: PluginDefinition, builtin: boolean): Promise<void> {
        const requested = definition.permissions || [];
        let enabled: boolean;
        let token: string;
        let permissions: PluginPermission[];

        if (builtin) {
            enabled = this.builtinEnabled.has(definition.name);
            token = `builtin:${definition.name}`;
            permissions = [...new Set(requested)];
        } else {
            const row = await queryOne<{ enabled: number; token: string; permissions: string | null }>(
                'SELECT enabled, token, permissions FROM plugin_configs WHERE filename = ?',
                [filename],
            );
            const normalized = normalizeStoredPermissions(row?.permissions ?? null, requested);

            if (!row || !row.token) {
                enabled = false;
                token = crypto.randomBytes(16).toString('hex');
                permissions = normalized.permissions;
                await execute(upsertSql(
                    'plugin_configs',
                    ['filename', 'enabled', 'token', 'permissions'],
                    ['filename'],
                    ['enabled', 'token', 'permissions'],
                ), [filename, 0, token, JSON.stringify(permissions)]);
            } else {
                enabled = row.enabled === 1;
                token = row.token;
                permissions = normalized.permissions;
                if (normalized.changed) {
                    await execute('UPDATE plugin_configs SET permissions = ? WHERE filename = ?',
                        [JSON.stringify(permissions), filename]);
                }
            }
        }

        const ctx: PluginContext = {
            name: definition.name,
            logger: createLogger(resolveLogModule(definition.name, filename)),
            config,
            db: createPluginDb(databaseDb, new Set(permissions)),
            plugins: { get: (name: string) => this.apiByName.get(name) },
        };

        this.entries.set(filename, {
            info: {
                filename,
                name: definition.name,
                version: definition.version || '1.0.0',
                description: definition.description || '',
                status: enabled ? 'enabled' : 'disabled',
                token,
                permissions,
                builtin,
            },
            definition,
            ctx,
        });
    }

    /** 标记插件加载失败，并撤销其 api 与路由占位 */
    private fail(entry: PluginEntry, message: string, options: { removeApi?: boolean } = {}): void {
        entry.info.status = 'error';
        entry.info.error = message;
        if (entry.definition) {
            if (options.removeApi !== false) {
                this.apiByName.delete(entry.definition.name);
            }
            this.routeRegistry.release(entry.definition.name);
        }
        logger.error(`plugin ${entry.info.name} failed: ${message}`);
    }

    getList(): PluginInfo[] {
        return [...this.entries.values()].map(entry => ({
            ...entry.info,
            permissions: [...entry.info.permissions],
        }));
    }

    getBuiltinEnabled(): string[] {
        return [...this.builtinEnabled];
    }

    private async runHook(name: PluginHookName, ...args: any[]): Promise<any[]> {
        const results: any[] = [];
        for (const entry of this.entries.values()) {
            if (entry.info.status !== 'enabled' || !entry.ctx) continue;

            const hooks = entry.definition?.hooks as Record<string, any> | undefined;
            const hook = hooks?.[name];
            if (typeof hook !== 'function') continue;

            try {
                results.push(await hook.call(hooks, ...args, entry.ctx));
            } catch (err) {
                logger.error(`plugin ${entry.info.name} hook ${name} failed`, err as Error);
            }
        }
        return results;
    }

    async inject(req: PluginRequest): Promise<{ header: string; footer: string; styles: string }> {
        const headers: string[] = [];
        const footers: string[] = [];
        const styles: string[] = [];

        for (const entry of this.entries.values()) {
            if (entry.info.status !== 'enabled' || !entry.definition || !entry.ctx) continue;

            const definition = entry.definition;
            const ctx = entry.ctx;
            const hooks = definition.hooks as Record<string, any> | undefined;

            const runHook = async (name: string): Promise<any> => {
                const hook = hooks?.[name];
                if (typeof hook !== 'function') return undefined;
                try {
                    return await hook.call(hooks, req, ctx);
                } catch (err) {
                    logger.error(`plugin ${definition.name} hook ${name} failed`, err as Error);
                    return undefined;
                }
            };

            const header = await runHook('injectHeader');
            if (typeof header === 'string' && header.trim()) headers.push(header);

            const footer = await runHook('injectFooter');
            if (typeof footer === 'string' && footer.trim()) footers.push(footer);

            const css = [
                ...cssParts(definition.styles),
                ...cssParts(await runHook('injectStyles')),
            ];
            if (css.length > 0) {
                styles.push(pluginStyleTag(definition.name, css.join('\n')));
            }
        }

        return { header: headers.join('\n'), footer: footers.join('\n'), styles: styles.join('\n') };
    }

    async beforeJudge(submission: any): Promise<any> {
        await this.runHook('beforeJudge', submission);
        return submission;
    }

    async afterJudge(submission: any): Promise<any> {
        await this.runHook('afterJudge', submission);
        return submission;
    }

    async toggle(filename: string, enabled: boolean, options: { reload?: boolean } = {}): Promise<void> {
        if (filename.startsWith('builtin:')) {
            const name = filename.slice('builtin:'.length);
            if (enabled) this.builtinEnabled.add(name);
            else this.builtinEnabled.delete(name);
        } else {
            await execute('UPDATE plugin_configs SET enabled = ? WHERE filename = ?',
                [enabled ? 1 : 0, filename]);
        }

        if (options.reload !== false) {
            await this.loadAll();
        }
    }

    async delete(filename: string, options: { reload?: boolean } = {}): Promise<void> {
        if (filename.startsWith('builtin:')) {
            logger.warn(`Cannot delete builtin plugin: ${filename}`);
            return;
        }

        const filePath = path.join(this.pluginDir, filename);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (err) {
                logger.error(`Error deleting plugin file ${filePath}`, err as Error);
                // 文件没删掉就不能删配置，否则下次加载会以禁用状态“复活”
                throw new Error(`删除插件文件失败：${errorMessage(err)}`);
            }
        }
        await execute('DELETE FROM plugin_configs WHERE filename = ?', [filename]);

        if (options.reload !== false) {
            await this.loadAll();
        }
    }

    async reload(): Promise<void> {
        await this.loadAll();
    }
}

export default PluginManager;
