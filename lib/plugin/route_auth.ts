import { App, Router } from '../bun-http';
import type { RouteGuard, RouteHandler } from '../bun-http';
import { ROLE_LV } from '../../middleware/auth';

/**
 * 插件路由鉴权。
 *
 * 规则：
 *   - `/admin` 与 `/admin/*` 一律强制 `super_user`，插件声明无法覆盖；
 *   - 其余插件路由未声明权限时默认“已登录”（default）；
 *   - 插件可在注册路由时用 `{ permission: '角色名' | 'public' }` 显式声明；
 *   - 没有元数据的核心路由不受影响（单进程模式下尤其重要）。
 *
 * 插件只能为自己在 `onRoute` 中注册的路由声明权限：与核心路由或其它插件
 * 已注册的路由（同方法 + 同路径模板）冲突时会直接报错，避免改写别人的访问策略。
 */

const ADMIN_PERMISSION = 'super_user';
const DEFAULT_PERMISSION = 'default';

/** `/admin` 及其子路径统一按管理员路由处理 */
export function isAdminPath(pathname: string): boolean {
    return pathname === '/admin' || pathname.startsWith('/admin/');
}

/** 校验并规整插件声明的权限值；未声明返回 undefined */
export function normalizeDeclaredPermission(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
        throw new Error('路由权限必须是字符串（角色名或 "public"）');
    }
    if (value === 'public') return value;
    if (!(value in ROLE_LV)) {
        throw new Error(`未知的路由权限：${value}（可选：public / ${Object.keys(ROLE_LV).join(' / ')}）`);
    }
    return value;
}

/**
 * 创建路由守卫。
 *
 * @param enforceAll 为 true 时，没有元数据的路由也按“默认已登录”处理。
 *                   plugin 进程里的所有路由都属于插件，因此应设为 true；
 *                   单进程模式下主应用还承载核心路由，因此应设为 false。
 */
export function createPluginRouteGuard(options: { enforceAll?: boolean } = {}): RouteGuard {
    const enforceAll = options.enforceAll === true;

    return (meta, req) => {
        // 核心路由：没有插件元数据，保持原有访问策略
        if (!meta && !enforceAll) return null;

        const pathname = String(req.path || '');
        const required = isAdminPath(pathname)
            ? ADMIN_PERMISSION
            : (meta?.permission || DEFAULT_PERMISSION);

        if (required === 'public') return null;

        const user = req.user;
        if (!user) {
            return { status: 401, message: '请先登录' };
        }

        const need = ROLE_LV[required];
        const have = ROLE_LV[user.role] ?? -1;
        if (need === undefined || have < need) {
            return { status: 403, message: '权限不足' };
        }
        return null;
    };
}

function isOptionsObject(value: any): boolean {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && !(value instanceof Router);
}

/**
 * 在应用里查找同方法、同路径模板的路由：
 *   - 插件直接注册的路由在 `app._router`；
 *   - 核心路由以子 Router 的形式挂在 `app._middleware` 上。
 */
function findExistingRoute(app: App, method: string, path: string): any {
    const seen = new Set<Router>();

    const visit = (router: Router): any => {
        if (!router || seen.has(router)) return null;
        seen.add(router);

        const found = (router._routes as any[]).find(
            route => route.method === method && route.path === path,
        );
        if (found) return found;

        for (const sub of router._subRouters) {
            const nested = visit(sub);
            if (nested) return nested;
        }
        return null;
    };

    const direct = visit(app._router);
    if (direct) return direct;

    for (const entry of app._middleware) {
        if (entry.isRouter && entry.handler instanceof Router) {
            const found = visit(entry.handler);
            if (found) return found;
        }
    }
    return null;
}

/**
 * 检查同方法、同路径模板的路由是否已被核心或其它插件注册。
 * 同一插件重复注册（例如单进程模式下重新加载）是允许的。
 */
function ensureRouteOwnership(app: App, method: string, path: string, owner: string): void {
    const existing = findExistingRoute(app, method, path);
    if (!existing) return;

    const existingOwner: string | undefined = existing.meta?.owner;
    if (existingOwner === owner) return;

    const who = existingOwner ? `插件 ${existingOwner}` : '核心路由';
    throw new Error(`路由 ${method} ${path} 已被${who}注册，插件 ${owner} 不能修改其访问权限`);
}

/** 给子 Router 里已有的路由补上归属，保证子路由也走默认鉴权 */
function tagRouterRoutes(router: Router, owner: string): void {
    for (const route of router._routes as any[]) {
        if (!route.meta) route.meta = { owner };
        else if (!route.meta.owner) route.meta.owner = owner;
    }
    for (const sub of router._subRouters) {
        tagRouterRoutes(sub, owner);
    }
}

/**
 * 为单个插件创建受限的 App 视图：
 *   - `app.get/post/put/delete` 注册路由时自动带上 owner 与声明的权限；
 *   - 禁止访问内部路由结构、修改守卫配置；
 *   - 其余能力（app.use、app.set、app.renderView 等）透传给真实 App。
 */
export function createScopedApp(app: App, owner: string): App {
    const register = (method: string, path: string, args: any[]): void => {
        let options: Record<string, any> = {};
        if (args.length >= 2 && isOptionsObject(args[0]) && typeof args[1] === 'function') {
            options = args.shift();
        }
        const handlers = args as RouteHandler[];
        if (handlers.length === 0) {
            throw new Error(`路由 ${method} ${path} 缺少处理函数`);
        }

        const permission = normalizeDeclaredPermission(options.permission);
        ensureRouteOwnership(app, method, path, owner);
        app.defineRoute(method, path, { owner, permission }, ...handlers);
    };

    return new Proxy(app, {
        get(target, prop, receiver) {
            // 不允许插件直接操作内部路由表或绕过守卫
            if (prop === 'defineRoute' || prop === 'setRouteGuard' || prop === 'setNotFoundHandler'
                || prop === '_router' || prop === '_settings' || prop === '_routeGuard' || prop === '_notFoundHandler') {
                return () => {
                    throw new Error(`插件不能直接访问 ${String(prop)}`);
                };
            }

            if (prop === 'get') {
                return (path: string, ...args: any[]) => {
                    // 保留 App.get(key) 读取设置的原语义
                    if (args.length === 0) return target.get(path);
                    return register('GET', path, args);
                };
            }
            if (prop === 'post') return (path: string, ...args: any[]) => register('POST', path, args);
            if (prop === 'put') return (path: string, ...args: any[]) => register('PUT', path, args);
            if (prop === 'delete') return (path: string, ...args: any[]) => register('DELETE', path, args);

            if (prop === 'set') {
                return (key: string, value: any) => {
                    if (key === 'routeGuard') {
                        throw new Error('插件不能修改路由鉴权配置');
                    }
                    return target.set(key, value);
                };
            }

            if (prop === 'use') {
                return (...args: any[]) => {
                    for (const arg of args) {
                        if (arg instanceof Router) tagRouterRoutes(arg, owner);
                    }
                    return target.use(...args);
                };
            }

            return Reflect.get(target, prop, receiver);
        },
    });
}
