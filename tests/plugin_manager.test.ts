import { describe, expect, test, beforeEach, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { App } from '../lib/bun-http';
import { PluginManager } from '../lib/plugin/manager';
import { createPluginDb } from '../lib/plugin/permissions';
import { createPluginRouteGuard } from '../lib/plugin/routes';
import { execute, initDb, queryOne } from '../lib/database';

const TEST_PLUGIN_DIR = path.join(__dirname, '_test_plugins');

function pluginFile(name: string): string {
    return path.join(TEST_PLUGIN_DIR, name);
}

function writePlugin(name: string, source: string): void {
    fs.writeFileSync(pluginFile(name), source);
}

async function seedConfig(
    filename: string,
    options: { enabled?: boolean; permissions?: string[] | null; token?: string } = {},
): Promise<void> {
    await execute(
        'INSERT INTO plugin_configs (filename, enabled, token, permissions) VALUES (?, ?, ?, ?)',
        [
            filename,
            options.enabled ? 1 : 0,
            options.token ?? `token-${filename}`,
            options.permissions === null ? null : JSON.stringify(options.permissions ?? []),
        ],
    );
}

function createManager(options: { builtinPlugins?: any[]; builtinEnabled?: string[] } = {}): PluginManager {
    return new PluginManager(TEST_PLUGIN_DIR, {
        app: new App(),
        builtinPlugins: options.builtinPlugins ?? [],
        builtinEnabled: options.builtinEnabled ?? [],
    });
}

function clearGlobalFlags(): void {
    delete (globalThis as any).__pluginSetupRan;
    delete (globalThis as any).__pluginConsumerValue;
    delete (globalThis as any).__pluginBrokenApi;
}

describe('PluginManager', () => {
    beforeAll(async () => {
        await initDb();
    });

    beforeEach(async () => {
        await execute('DELETE FROM plugin_configs');
        clearGlobalFlags();

        if (fs.existsSync(TEST_PLUGIN_DIR)) {
            for (const entry of fs.readdirSync(TEST_PLUGIN_DIR)) {
                fs.unlinkSync(path.join(TEST_PLUGIN_DIR, entry));
            }
        } else {
            fs.mkdirSync(TEST_PLUGIN_DIR, { recursive: true });
        }
    });

    afterAll(() => {
        if (!fs.existsSync(TEST_PLUGIN_DIR)) return;
        for (const entry of fs.readdirSync(TEST_PLUGIN_DIR)) {
            fs.unlinkSync(path.join(TEST_PLUGIN_DIR, entry));
        }
        fs.rmdirSync(TEST_PLUGIN_DIR);
    });

    test('加载 ESM 定义并 await setup/routes', async () => {
        writePlugin('demo.js', `
export default {
    name: 'demo',
    version: '1.2.3',
    description: 'demo plugin',
    permissions: ['db:read'],
    async setup(ctx) {
        await new Promise(resolve => setTimeout(resolve, 5));
        globalThis.__pluginSetupRan = ctx.name;
    },
    routes(router) {
        router.get('/demo/ping', (req, res) => res.json({ ok: true }));
    },
    api: { ping: () => 'pong' }
};
`);
        await seedConfig('demo.js', { enabled: true, permissions: ['db:read'] });

        const manager = createManager();
        await manager.loadAll();

        const info = manager.getList().find(item => item.filename === 'demo.js');
        expect(info?.status).toBe('enabled');
        expect(info?.version).toBe('1.2.3');
        expect((globalThis as any).__pluginSetupRan).toBe('demo');
    });

    test('拒绝 CommonJS 插件并给出迁移提示', async () => {
        writePlugin('legacy.js', 'module.exports = { name: "legacy" };');

        const manager = createManager();
        await manager.loadAll();

        const info = manager.getList().find(item => item.filename === 'legacy.js');
        expect(info?.status).toBe('error');
        expect(info?.error).toContain('CommonJS');
    });

    test('未知权限、未知钩子与未知字段会导致加载失败', async () => {
        writePlugin('bad-perm.js', `
export default { name: 'bad-perm', permissions: ['read_db'] };
`);
        writePlugin('bad-hook.js', `
export default { name: 'bad-hook', hooks: { onProblemSubmit() {} } };
`);
        writePlugin('bad-field.js', `
export default { name: 'bad-field', hook: {} };
`);

        const manager = createManager();
        await manager.loadAll();

        const list = manager.getList();
        expect(list.find(item => item.filename === 'bad-perm.js')?.status).toBe('error');
        expect(list.find(item => item.filename === 'bad-hook.js')?.status).toBe('error');
        expect(list.find(item => item.filename === 'bad-field.js')?.error).toContain('未知的插件字段');
    });

    test('加载失败也会创建配置行，管理界面可以切换启用状态', async () => {
        writePlugin('bad-load.js', 'module.exports = { name: "bad-load" };');

        const manager = createManager();
        await manager.loadAll();

        const row = await queryOne<{ enabled: number; permissions: string | null }>(
            'SELECT enabled, permissions FROM plugin_configs WHERE filename = ?', ['bad-load.js'],
        );
        expect(row).toBeDefined();
        expect(row?.enabled).toBe(0);
        expect(row?.permissions).toBeNull();

        await manager.toggle('bad-load.js', true);
        const updated = await queryOne<{ enabled: number }>(
            'SELECT enabled FROM plugin_configs WHERE filename = ?', ['bad-load.js'],
        );
        expect(updated?.enabled).toBe(1);
    });

    test('失败插件修复后按定义重新授予权限', async () => {
        writePlugin('fixme.js', 'module.exports = { name: "fixme" };');
        const manager = createManager();
        await manager.loadAll();
        expect(manager.getList().find(item => item.filename === 'fixme.js')?.status).toBe('error');

        writePlugin('fixme.js', `
export default {
    name: 'fixme',
    permissions: ['db:read']
};
`);
        await manager.toggle('fixme.js', true);

        const info = manager.getList().find(item => item.filename === 'fixme.js');
        expect(info?.status).toBe('enabled');
        expect(info?.permissions).toEqual(['db:read']);
    });

    test('setup 抛错时进入 error 状态并撤销 api', async () => {
        writePlugin('broken.js', `
export default {
    name: 'broken',
    api: { value: 1 },
    setup() { throw new Error('setup boom'); }
};
`);
        writePlugin('z-checker.js', `
export default {
    name: 'checker',
    setup(ctx) {
        globalThis.__pluginBrokenApi = ctx.plugins.get('broken');
    }
};
`);
        await seedConfig('broken.js', { enabled: true });
        await seedConfig('z-checker.js', { enabled: true });

        const manager = createManager();
        await manager.loadAll();

        const info = manager.getList().find(item => item.filename === 'broken.js');
        expect(info?.status).toBe('error');
        expect(info?.error).toContain('setup boom');
        expect((globalThis as any).__pluginBrokenApi).toBeUndefined();
    });

    test('api 在 setup 之前注册，不依赖文件顺序', async () => {
        writePlugin('a-consumer.js', `
export default {
    name: 'consumer',
    setup(ctx) {
        globalThis.__pluginConsumerValue = ctx.plugins.get('provider')?.value;
    }
};
`);
        writePlugin('z-provider.js', `
export default {
    name: 'provider',
    api: { value: 42 }
};
`);
        await seedConfig('a-consumer.js', { enabled: true });
        await seedConfig('z-provider.js', { enabled: true });

        const manager = createManager();
        await manager.loadAll();

        expect((globalThis as any).__pluginConsumerValue).toBe(42);
    });

    test('启用/禁用持久化并重载，删除移除文件与配置', async () => {
        writePlugin('toggler.js', `
export default { name: 'toggler' };
`);
        await seedConfig('toggler.js', { enabled: false });

        const manager = createManager();
        await manager.loadAll();
        expect(manager.getList().find(item => item.filename === 'toggler.js')?.status).toBe('disabled');

        await manager.toggle('toggler.js', true);
        expect(manager.getList().find(item => item.filename === 'toggler.js')?.status).toBe('enabled');
        const row = await queryOne<{ enabled: number }>('SELECT enabled FROM plugin_configs WHERE filename = ?', ['toggler.js']);
        expect(row?.enabled).toBe(1);

        await manager.delete('toggler.js');
        expect(fs.existsSync(pluginFile('toggler.js'))).toBe(false);
        expect(manager.getList().find(item => item.filename === 'toggler.js')).toBeUndefined();
        expect(await queryOne('SELECT filename FROM plugin_configs WHERE filename = ?', ['toggler.js'])).toBeUndefined();
    });

    test('内置插件不可删除', async () => {
        const manager = createManager({
            builtinPlugins: [{ name: 'builtin-x', version: '1.0.0' }],
            builtinEnabled: ['builtin-x'],
        });
        await manager.loadAll();

        expect(manager.getList().find(item => item.filename === 'builtin:builtin-x')?.status).toBe('enabled');
        await manager.delete('builtin:builtin-x');
        expect(manager.getList().find(item => item.filename === 'builtin:builtin-x')).toBeDefined();
    });

    test('旧权限名自动映射并写回', async () => {
        writePlugin('legacy-perm.js', `
export default {
    name: 'legacy-perm',
    permissions: ['db:read', 'db:write'],
    async setup(ctx) {
        await ctx.db.query('SELECT 1');
        await ctx.db.execute('SELECT 1');
    }
};
`);
        await seedConfig('legacy-perm.js', {
            enabled: true,
            permissions: ['read_db', 'write_db', 'oj_access'],
        });

        const manager = createManager();
        await manager.loadAll();

        const info = manager.getList().find(item => item.filename === 'legacy-perm.js');
        expect(info?.status).toBe('enabled');
        expect(info?.permissions).toEqual(['db:read', 'db:write']);

        const row = await queryOne<{ permissions: string }>(
            'SELECT permissions FROM plugin_configs WHERE filename = ?', ['legacy-perm.js'],
        );
        expect(JSON.parse(row!.permissions)).toEqual(['db:read', 'db:write']);
    });

    test('钩子按加载顺序 await，且可以修改 submission', async () => {
        writePlugin('a-hook.js', `
export default {
    name: 'a-hook',
    hooks: {
        async injectHeader() {
            await new Promise(resolve => setTimeout(resolve, 5));
            return 'A';
        },
        beforeJudge(submission) { submission.status = 'Touched'; }
    }
};
`);
        writePlugin('b-hook.js', `
export default {
    name: 'b-hook',
    hooks: { injectHeader() { return 'B'; } }
};
`);
        await seedConfig('a-hook.js', { enabled: true });
        await seedConfig('b-hook.js', { enabled: true });

        const manager = createManager();
        await manager.loadAll();

        const injected = await manager.inject({
            method: 'GET',
            path: '/',
            url: 'http://localhost/',
            query: {},
            cookies: {},
            params: {},
            headers: new Headers(),
            user: null,
        });
        expect(injected.header).toBe('A\nB');

        const submission = { id: 1, status: 'Pending' };
        const updated = await manager.beforeJudge(submission);
        expect(updated.status).toBe('Touched');
    });

    test('数据库权限映射：query/queryOne 需要 db:read，execute 需要 db:write', async () => {
        const calls: string[] = [];
        const raw = {
            query: async () => { calls.push('query'); return []; },
            queryOne: async () => { calls.push('queryOne'); return undefined; },
            execute: async () => { calls.push('execute'); return { lastInsertRowid: 1, changes: 1 }; },
        };

        const readOnly = createPluginDb(raw, new Set(['db:read'] as const));
        await readOnly.query('select 1');
        await readOnly.queryOne('select 1');
        await expect(readOnly.execute('update')).rejects.toThrow('db:write');

        const writeOnly = createPluginDb(raw, new Set(['db:write'] as const));
        await writeOnly.execute('update');
        await expect(writeOnly.query('select 1')).rejects.toThrow('db:read');
        expect(calls).toEqual(['query', 'queryOne', 'execute']);
    });

    test('插件路由鉴权：默认登录、public、管理员与 /admin 强制提权', async () => {
        writePlugin('routes.js', `
export default {
    name: 'routes-demo',
    routes(router) {
        router.get('/auth/public', { auth: 'public' }, (req, res) => res.send('public'));
        router.get('/auth/default', (req, res) => res.send('default'));
        router.get('/auth/admin', { auth: 'super_user' }, (req, res) => res.send('admin'));
        router.get('/admin/plugin-route', { auth: 'public' }, (req, res) => res.send('forced-admin'));
    }
};
`);
        await seedConfig('routes.js', { enabled: true });

        const app = new App();
        app.setRouteGuard(createPluginRouteGuard({ enforceAll: false }));
        app.use((req, res, next) => {
            const role = req.headers.get('x-test-role');
            req.user = role ? { id: 1, username: role, role } : null;
            return next();
        });
        const manager = new PluginManager(TEST_PLUGIN_DIR, { app, builtinPlugins: [] });
        await manager.loadAll();

        const hit = (url: string, role?: string) => {
            const headers = new Headers();
            if (role) headers.set('x-test-role', role);
            return app.handle(new Request(url, { headers }));
        };

        expect((await hit('http://localhost/auth/public')).status).toBe(200);
        expect((await hit('http://localhost/auth/default')).status).toBe(401);
        expect((await hit('http://localhost/auth/default', 'default')).status).toBe(200);
        expect((await hit('http://localhost/auth/admin', 'default')).status).toBe(403);
        expect((await hit('http://localhost/auth/admin', 'super_user')).status).toBe(200);
        expect((await hit('http://localhost/admin/plugin-route')).status).toBe(401);
        expect((await hit('http://localhost/admin/plugin-route', 'default')).status).toBe(403);
        expect((await hit('http://localhost/admin/plugin-route', 'root')).status).toBe(200);
    });

    test('重载不会累积插件路由', async () => {
        writePlugin('reload.js', `
export default {
    name: 'reload-demo',
    routes(router) {
        router.get('/reload/demo', (req, res) => res.send('ok'));
    }
};
`);
        await seedConfig('reload.js', { enabled: true });

        const app = new App();
        const manager = new PluginManager(TEST_PLUGIN_DIR, { app, builtinPlugins: [] });
        await manager.loadAll();

        const routeCount = () => app.listRoutes()
            .filter(route => route.method === 'GET' && route.path === '/reload/demo').length;
        expect(routeCount()).toBe(1);

        await manager.reload();
        expect(routeCount()).toBe(1);

        const response = await app.handle(new Request('http://localhost/reload/demo'));
        expect(await response.text()).toBe('ok');
    });
});
