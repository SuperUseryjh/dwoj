import { App, Router } from '../bun-http';
import type { RouteGuard, RouteHandler } from '../bun-http';
import { ROLE_LV } from '../../middleware/auth';
import type { PluginRouter, RouteAuth, RouteOptions } from './types';

/**
 * 插件路由注册与鉴权。
 *
 *   - `/admin` 与 `/admin/*` 一律强制 `super_user`；
 *   - 其它插件路由默认“已登录”，可用 `{ auth: 'public' | 'default' | 'super_user' | 'root' }` 声明；
 *   - 同方法 + 同路径模板与核心路由或其它插件冲突时，注册直接报错；
 *   - 插件只能通过受控的 `PluginRouter` 注册路由，拿不到 App 内部结构。
 */

const ADMIN_AUTH: RouteAuth = 'super_user';
const DEFAULT_AUTH: RouteAuth = 'default';

const AUTH_VALUES = new Set<string>(['public', ...Object.keys(ROLE_LV)]);

/** `/admin` 及其子路径统一按管理员路由处理 */
export function isAdminPath(pathname: string): boolean {
    return pathname === '/admin' || pathname.startsWith('/admin/');
}

/** 校验插件声明的路由权限；未声明返回 undefined */
export function normalizeRouteAuth(value: unknown): RouteAuth | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !AUTH_VALUES.has(value)) {
        throw new Error(`未知的路由权限：${String(value)}（可选：${[...AUTH_VALUES].join(' / ')}）`);
    }
    return value as RouteAuth;
}

/**
 * 创建路由守卫。
 *
 * @param enforceAll 为 true 时，没有元数据的路由也按“默认已登录”处理。
 *                   plugin 进程里的所有路由都属于插件，因此设为 true；
 *                   单进程模式下主应用还承载核心路由，因此设为 false。
 */
export function createPluginRouteGuard(options: { enforceAll?: boolean } = {}): RouteGuard {
    const enforceAll = options.enforceAll === true;

    return (meta, req) => {
        if (!meta && !enforceAll) return null;

        const pathname = String(req.path || '');
        const required = isAdminPath(pathname)
            ? ADMIN_AUTH
            : ((meta?.auth as RouteAuth | undefined) || DEFAULT_AUTH);

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

/**
 * 判断两个路径模板是否可能匹配同一个请求。
 * 这里只支持 Router 的 `:param` 语法：段数必须相同，且每一段要么相同、要么至少一边是参数。
 */
export function routesOverlap(a: string, b: string): boolean {
    const left = a.split('/');
    const right = b.split('/');
    if (left.length !== right.length) return false;
    return left.every((segment, index) =>
        segment.startsWith(':') || right[index].startsWith(':') || segment === right[index],
    );
}

/** 在应用里查找与给定方法 + 路径模板重叠的路由（含核心子路由） */
function findOverlappingRoute(app: App, method: string, path: string): { path: string } | undefined {
    return app.listRoutes().find(
        route => route.method === method && routesOverlap(route.path, path),
    );
}

interface RouteClaim {
    owner: string;
    method: string;
    path: string;
}

/**
 * 记录本次加载中已被占用的路由。
 * 除完全相同的 METHOD + 路径模板外，也会拒绝会匹配同一请求的重叠模板
 * （例如 `/x/:id` 与 `/x/foo`）。
 */
export class RouteRegistry {
    private readonly claims = new Map<string, RouteClaim>();

    constructor(private readonly app: App) { }

    reset(): void {
        this.claims.clear();
    }

    /** 撤销某个插件已占用的路由（该插件加载失败时调用） */
    release(owner: string): void {
        for (const [key, claim] of this.claims) {
            if (claim.owner === owner) this.claims.delete(key);
        }
    }

    claim(owner: string, method: string, path: string): void {
        const key = `${method} ${path}`;
        const exact = this.claims.get(key);
        if (exact) {
            throw new Error(`路由 ${key} 已被插件 ${exact.owner} 注册，插件 ${owner} 不能修改其访问权限`);
        }

        for (const claim of this.claims.values()) {
            if (claim.method !== method) continue;
            if (routesOverlap(claim.path, path)) {
                throw new Error(
                    `路由 ${method} ${path} 与插件 ${claim.owner} 的 ${claim.path} 冲突，` +
                    `插件 ${owner} 不能修改其访问权限`,
                );
            }
        }

        const core = findOverlappingRoute(this.app, method, path);
        if (core) {
            throw new Error(
                `路由 ${method} ${path} 与核心路由 ${core.path} 冲突，插件 ${owner} 不能修改其访问权限`,
            );
        }

        this.claims.set(key, { owner, method, path });
    }
}

function isOptionsObject(value: unknown): value is RouteOptions {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 创建插件专用的路由注册视图。
 * 返回底层 Router 供 manager 挂载；插件只接触 `view`。
 */
export function createPluginRouter(
    owner: string,
    registry: RouteRegistry,
): { router: Router; view: PluginRouter } {
    const router = new Router();

    const register = (method: string, path: string, args: any[]): void => {
        if (typeof path !== 'string' || !path.startsWith('/')) {
            throw new Error(`路由路径必须以 / 开头：${String(path)}`);
        }

        let options: RouteOptions = {};
        if (args.length >= 2 && isOptionsObject(args[0]) && typeof args[1] === 'function') {
            options = args.shift() as RouteOptions;
        }

        const handlers = args as RouteHandler[];
        if (handlers.length === 0 || handlers.some(handler => typeof handler !== 'function')) {
            throw new Error(`路由 ${method} ${path} 需要至少一个处理函数`);
        }

        const auth = normalizeRouteAuth(options.auth);
        registry.claim(owner, method, path);
        router.addRoute(method, path, handlers, { owner, auth });
    };

    const view: PluginRouter = {
        get: (path: string, ...args: any[]) => register('GET', path, args),
        post: (path: string, ...args: any[]) => register('POST', path, args),
        put: (path: string, ...args: any[]) => register('PUT', path, args),
        delete: (path: string, ...args: any[]) => register('DELETE', path, args),
    } as PluginRouter;

    return { router, view };
}
