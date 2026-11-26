import type { Logger } from '../logger';
import type { RouteHandler } from '../bun-http';

/** 插件可申请的数据库权限 */
export type PluginPermission = 'db:read' | 'db:write';

export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = ['db:read', 'db:write'];

/** 插件路由可声明的访问要求 */
export type RouteAuth = 'public' | 'default' | 'super_user' | 'root';

export interface RouteOptions {
    auth?: RouteAuth;
}

/** 注入钩子看到的请求快照 */
export interface PluginRequest {
    method: string;
    path: string;
    url: string;
    query: Record<string, string>;
    cookies: Record<string, string>;
    params: Record<string, string>;
    headers: Headers;
    user: { id: number; username?: string; role: string } | null;
}

/** 带权限校验的数据库访问接口 */
export interface PluginDatabase {
    query<T = any>(sql: string, params?: readonly any[]): Promise<T[]>;
    queryOne<T = any>(sql: string, params?: readonly any[]): Promise<T | undefined>;
    execute(sql: string, params?: readonly any[]): Promise<{ lastInsertRowid: number; changes: number }>;
}

export interface PluginContext {
    readonly name: string;
    readonly logger: Logger;
    readonly config: typeof import('../../config');
    readonly db: PluginDatabase;
    readonly plugins: { get(name: string): any };
}

/** 插件注册路由时拿到的受限接口 */
export interface PluginRouter {
    get(path: string, ...handlers: RouteHandler[]): void;
    get(path: string, options: RouteOptions, ...handlers: RouteHandler[]): void;
    post(path: string, ...handlers: RouteHandler[]): void;
    post(path: string, options: RouteOptions, ...handlers: RouteHandler[]): void;
    put(path: string, ...handlers: RouteHandler[]): void;
    put(path: string, options: RouteOptions, ...handlers: RouteHandler[]): void;
    delete(path: string, ...handlers: RouteHandler[]): void;
    delete(path: string, options: RouteOptions, ...handlers: RouteHandler[]): void;
}

export interface PluginHooks {
    injectHeader?(req: PluginRequest, ctx: PluginContext): string | void | Promise<string | void>;
    injectFooter?(req: PluginRequest, ctx: PluginContext): string | void | Promise<string | void>;
    beforeJudge?(submission: any, ctx: PluginContext): void | Promise<void>;
    afterJudge?(submission: any, ctx: PluginContext): void | Promise<void>;
}

export const PLUGIN_HOOK_NAMES = [
    'injectHeader',
    'injectFooter',
    'beforeJudge',
    'afterJudge',
] as const;

export type PluginHookName = (typeof PLUGIN_HOOK_NAMES)[number];

/** 插件模块的默认导出对象 */
export interface PluginDefinition {
    name: string;
    version?: string;
    description?: string;
    permissions?: PluginPermission[];
    setup?(ctx: PluginContext): void | Promise<void>;
    routes?(router: PluginRouter, ctx: PluginContext): void | Promise<void>;
    hooks?: PluginHooks;
    api?: Record<string, any>;
}

export type PluginStatus = 'enabled' | 'disabled' | 'error';

/** 管理界面 / RPC 返回的插件条目 */
export interface PluginInfo {
    filename: string;
    name: string;
    version: string;
    description: string;
    status: PluginStatus;
    error?: string;
    token: string;
    permissions: PluginPermission[];
    builtin: boolean;
}
