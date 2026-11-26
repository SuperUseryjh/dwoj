import { describe, expect, test } from 'bun:test';
import { App, Router } from '../lib/bun-http';
import {
    RouteRegistry,
    createPluginRouteGuard,
    createPluginRouter,
    normalizeRouteAuth,
    routesOverlap,
} from '../lib/plugin/routes';

const noop = () => { };
const defaultUser = { id: 1, role: 'default' };
const adminUser = { id: 2, role: 'super_user' };

function fakeReq(path: string, user: any = null): any {
    return { path, user };
}

describe('插件路由鉴权守卫', () => {
    test('核心路由（无元数据）在 enforceAll=false 时不受影响', () => {
        const guard = createPluginRouteGuard({ enforceAll: false });
        expect(guard(undefined, fakeReq('/login', null))).toBeNull();
    });

    test('enforceAll=true 时无元数据路由按默认登录处理', () => {
        const guard = createPluginRouteGuard({ enforceAll: true });
        expect(guard(undefined, fakeReq('/anything', null))?.status).toBe(401);
        expect(guard(undefined, fakeReq('/anything', defaultUser))).toBeNull();
    });

    test('public / default / super_user 的判定', () => {
        const guard = createPluginRouteGuard();
        expect(guard({ auth: 'public' }, fakeReq('/x', null))).toBeNull();
        expect(guard({ auth: 'default' }, fakeReq('/x', null))?.status).toBe(401);
        expect(guard({ auth: 'default' }, fakeReq('/x', defaultUser))).toBeNull();
        expect(guard({ auth: 'super_user' }, fakeReq('/x', defaultUser))?.status).toBe(403);
        expect(guard({ auth: 'super_user' }, fakeReq('/x', adminUser))).toBeNull();
    });

    test('/admin 与 /admin/* 强制 super_user，忽略声明的 public', () => {
        const guard = createPluginRouteGuard();
        expect(guard({ auth: 'public' }, fakeReq('/admin/x', null))?.status).toBe(401);
        expect(guard({ auth: 'public' }, fakeReq('/admin/x', defaultUser))?.status).toBe(403);
        expect(guard({ auth: 'public' }, fakeReq('/admin/x', adminUser))).toBeNull();
        expect(guard({ auth: 'root' }, fakeReq('/admin', { id: 3, role: 'root' }))).toBeNull();
    });

    test('非法 auth 值会抛错', () => {
        expect(normalizeRouteAuth(undefined)).toBeUndefined();
        expect(normalizeRouteAuth('public')).toBe('public');
        expect(() => normalizeRouteAuth('owner')).toThrow(/未知的路由权限/);
    });
});

describe('插件路由注册', () => {
    test('注册时写入 owner 与 auth 元数据', () => {
        const app = new App();
        const registry = new RouteRegistry(app);
        const { router, view } = createPluginRouter('owner-a', registry);

        view.get('/a/public', { auth: 'public' }, noop);
        view.get('/a/default', noop);

        const routes = router.listRoutes();
        expect(routes[0].path).toBe('/a/public');
        expect(routes[0].meta).toEqual({ owner: 'owner-a', auth: 'public' });
        expect(routes[1].meta).toEqual({ owner: 'owner-a', auth: undefined });
    });

    test('路径必须以 / 开头', () => {
        const app = new App();
        const { view } = createPluginRouter('owner-a', new RouteRegistry(app));
        expect(() => view.get('no-slash', noop)).toThrow(/必须以 \/ 开头/);
    });

    test('跨插件重复路由会被拒绝', () => {
        const app = new App();
        const registry = new RouteRegistry(app);
        const first = createPluginRouter('owner-a', registry);
        const second = createPluginRouter('owner-b', registry);

        first.view.get('/same', noop);
        expect(() => second.view.get('/same', { auth: 'public' }, noop)).toThrow(/owner-a/);
    });

    test('跨插件重叠模板会被拒绝', () => {
        const app = new App();
        const registry = new RouteRegistry(app);
        const first = createPluginRouter('owner-a', registry);
        const second = createPluginRouter('owner-b', registry);

        first.view.get('/items/:id', noop);
        expect(() => second.view.get('/items/foo', noop)).toThrow(/冲突/);
        expect(() => second.view.get('/items/:name', noop)).toThrow(/冲突/);
    });

    test('与核心路由冲突会被拒绝（含参数模板重叠）', () => {
        const app = new App();
        const core = new Router();
        core.get('/core/:id', noop);
        app.use(core);

        const registry = new RouteRegistry(app);
        expect(() => registry.claim('owner-a', 'GET', '/core/:id')).toThrow(/核心路由/);
        expect(() => registry.claim('owner-a', 'GET', '/core/foo')).toThrow(/核心路由/);
    });

    test('routesOverlap 只比较段数与参数位置', () => {
        expect(routesOverlap('/a/:id', '/a/foo')).toBe(true);
        expect(routesOverlap('/a/:id', '/a/:name')).toBe(true);
        expect(routesOverlap('/a/:id', '/a/foo/bar')).toBe(false);
        expect(routesOverlap('/a/foo', '/a/bar')).toBe(false);
        expect(routesOverlap('/a', '/a')).toBe(true);
    });

    test('Router.reset 清空路由、中间件与子路由', () => {
        const router = new Router();
        router.get('/x', noop);
        router.use(noop);
        router.use(new Router());

        router.reset();

        expect(router.listRoutes()).toHaveLength(0);
        expect(router._match('GET', '/x')).toBeNull();
    });
});
