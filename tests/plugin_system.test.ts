import { describe, expect, test, mock, beforeEach, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';

// 注意：这里**不使用 mock.module**。
// Bun 的 mock.module 是进程级的，而且会在所有测试文件被加载时就生效，
// 会污染同进程里其它文件（曾经把 logger.test.ts / database.test.ts 全带崩）。
// 所以插件测试直接用 tests/setup.ts 指定的测试库（test_dwoj.db）。
import { execute, initDb, queryOne } from '../lib/database';
import PluginSystem, { resolveLogModule } from '../lib/plugin_system';

const TEST_PLUGIN_DIR = path.join(__dirname, '_test_plugins');

async function seedConfig(
    filename: string,
    options: { enabled?: boolean; token?: string; permissions?: string[] } = {},
): Promise<void> {
    await execute(
        'INSERT INTO plugin_configs (filename, enabled, token, permissions) VALUES (?, ?, ?, ?)',
        [
            filename,
            options.enabled ? 1 : 0,
            options.token ?? `token-${filename}`,
            JSON.stringify(options.permissions ?? []),
        ],
    );
}

describe('PluginSystem', () => {
    let pluginSystem: PluginSystem;
    const mockOj = {
        app: { use: mock(() => {}), _middleware: [] },
        // 权限代理只拦截"函数属性"，所以这里要有真实的函数才能验证拦截逻辑
        db: {
            query: mock(() => []),
            execute: mock(() => ({ lastInsertRowid: 1, changes: 1 })),
            get: mock(() => undefined),
            all: mock(() => []),
            run: mock(() => ({})),
        },
        config: {},
        logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    };

    beforeAll(async () => {
        await initDb();
    });

    beforeEach(async () => {
        // 每个用例从干净状态开始
        await execute('DELETE FROM plugin_configs');

        if (fs.existsSync(TEST_PLUGIN_DIR)) {
            const entries = fs.readdirSync(TEST_PLUGIN_DIR, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(TEST_PLUGIN_DIR, entry.name);
                if (entry.isFile()) fs.unlinkSync(fullPath);
            }
        } else {
            fs.mkdirSync(TEST_PLUGIN_DIR, { recursive: true });
        }
    });

    afterAll(() => {
        const rmDir = (dir: string): void => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) rmDir(fullPath);
                else fs.unlinkSync(fullPath);
            }
            fs.rmdirSync(dir);
        };
        try { rmDir(TEST_PLUGIN_DIR); } catch { /* ignore */ }
    });

    test('插件日志模块名：manifest.name 优先、截断到 6 字符', () => {
        expect(resolveLogModule('db-monitor', 'db-monitor.js')).toBe('dbmon');
        expect(resolveLogModule('my-plugin', 'whatever.js')).toBe('myplu');
        expect(resolveLogModule(undefined, 'my-plugin.js')).toBe('myplu');
        expect(resolveLogModule('', 'x.js')).toBe('x');
        expect(resolveLogModule('!!!', '')).toBe('plugin');
    });

    test('constructor initializes plugin directory', () => {
        fs.rmdirSync(TEST_PLUGIN_DIR);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        expect(fs.existsSync(TEST_PLUGIN_DIR)).toBe(true);
        expect(pluginSystem.pluginDir).toBe(TEST_PLUGIN_DIR);
        expect(pluginSystem.plugins).toEqual({});
    });

    test('loadAll loads no plugins when directory is empty', async () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();
        // built-in db-monitor is always registered (disabled by default)
        expect(Object.keys(pluginSystem.plugins)).toHaveLength(1);
        expect(pluginSystem.plugins['builtin:db-monitor']).toBeDefined();
        expect(pluginSystem.plugins['builtin:db-monitor'].enabled).toBe(false);
    });

    test('loadAll loads valid .js plugins', async () => {
        const pluginContent = `
module.exports = {
    manifest: {
        name: 'test-plugin',
        description: 'A test plugin',
        version: '1.0.0',
        permissions: ['oj_access', 'db_read']
    },
    onRoute: function(oj, db, getPluginExports) {
        oj.app.use(function(req, res, next) { next(); });
    }
};
`;
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'test-plugin.js'), pluginContent);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(Object.keys(pluginSystem.plugins)).toHaveLength(2); // 1 external + 1 built-in
        // 'test-plugin' → 截断到 6 字符 "test-p" → 去掉连字符 → "testp"
        expect(pluginSystem.plugins['test-plugin.js'].module.logModule).toBe('testp');
        expect(pluginSystem.plugins['test-plugin.js'].name).toBe('test-plugin');
        expect(pluginSystem.plugins['test-plugin.js'].enabled).toBe(false); // 库里没有 → 默认禁用
        expect(pluginSystem.plugins['test-plugin.js'].permissions).toEqual(['oj_access', 'db_read']);
    });

    test('loadAll skips non-js files', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'readme.txt'), 'not a plugin');
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'data.json'), '{}');

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(Object.keys(pluginSystem.plugins)).toHaveLength(1);
        expect(pluginSystem.plugins['builtin:db-monitor']).toBeDefined();
    });

    test('loadAll handles plugin load errors gracefully', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'bad-plugin.js'), 'this is not valid javascript {{{');

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(Object.keys(pluginSystem.plugins)).toHaveLength(1);
        expect(pluginSystem.plugins['builtin:db-monitor']).toBeDefined();
    });

    test('loadAll loads enabled plugin and registers routes', async () => {
        await seedConfig('active-plugin.js', {
            enabled: true,
            token: 'test-token-123',
            permissions: ['oj_access', 'db_read'],
        });

        const pluginContent = `
module.exports = {
    manifest: {
        name: 'active-plugin',
        description: 'An active plugin',
        version: '2.0.0',
        permissions: ['oj_access', 'db_read']
    },
    onRoute: function(oj, db, getPluginExports) {
        oj.app.use('plugin_route');
    }
};
`;
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'active-plugin.js'), pluginContent);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(pluginSystem.plugins['active-plugin.js'].enabled).toBe(true);
        expect(pluginSystem.plugins['active-plugin.js'].token).toBe('test-token-123');
    });

    test('getList returns all plugins including errored ones', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'good.js'), `
module.exports = { manifest: { name: 'good' } };
`);
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'bad.js'), 'invalid{{{');

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        const list = pluginSystem.getList();
        const names = list.map((p: any) => p.name);

        expect(names).toContain('good');
        expect(list.some((p: any) => p.filename === 'bad.js')).toBe(true);
    });

    test('getPluginExports returns exports of enabled plugin', async () => {
        await seedConfig('exporter.js', { enabled: true, token: 'token', permissions: [] });

        const pluginContent = `
module.exports = {
    manifest: { name: 'exporter' },
    exports: { helper: function() { return 42; } }
};
`;
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'exporter.js'), pluginContent);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        const exports = pluginSystem.getPluginExports('exporter');
        expect(exports).toBeDefined();
        expect(exports.helper()).toBe(42);
    });

    test('getPluginExports returns undefined for unknown plugin', () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        expect(pluginSystem.getPluginExports('nonexistent')).toBeUndefined();
    });

    test('emit calls hooks on all enabled plugins', async () => {
        await seedConfig('hook1.js', { enabled: true, token: 'token', permissions: ['oj_access', 'db_read'] });

        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'hook1.js'), `
module.exports = {
    manifest: { name: 'hook1' },
    onCustomHook: function(oj, db, getPluginExports, value) {
        return value * 2;
    }
};
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        const results = pluginSystem.emit('onCustomHook', 21);
        expect(results).toContain(42);
    });

    test('emit returns empty array when no hooks match', async () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        expect(pluginSystem.emit('nonexistentHook')).toEqual([]);
    });

    test('toggle enables plugin, persists to db and reloads', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'toggler.js'), `
module.exports = {
    manifest: { name: 'toggler' }
};
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(pluginSystem.plugins['toggler.js'].enabled).toBe(false);

        await pluginSystem.toggle('toggler.js', true);

        const row = await queryOne<{ enabled: number }>(
            'SELECT enabled FROM plugin_configs WHERE filename = ?', ['toggler.js'],
        );
        expect(row?.enabled).toBe(1);
        expect(pluginSystem.plugins['toggler.js'].enabled).toBe(true);
    });

    test('delete removes plugin file and config', async () => {
        const pluginPath = path.join(TEST_PLUGIN_DIR, 'deletable.js');
        fs.writeFileSync(pluginPath, `
module.exports = { manifest: { name: 'deletable' } };
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(fs.existsSync(pluginPath)).toBe(true);
        expect(pluginSystem.plugins['deletable.js']).toBeDefined();

        await pluginSystem.delete('deletable.js');

        expect(fs.existsSync(pluginPath)).toBe(false);
        const row = await queryOne('SELECT filename FROM plugin_configs WHERE filename = ?', ['deletable.js']);
        expect(row).toBeUndefined();
        expect(pluginSystem.plugins['deletable.js']).toBeUndefined();
    });

    test('delete handles non-existent plugin gracefully', async () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await expect(pluginSystem.delete('nonexistent.js')).resolves.toBeUndefined();
    });

    test('Plugin permission proxy blocks unauthorized access', async () => {
        await seedConfig('restricted.js', {
            enabled: true,
            token: 'restricted-token',
            permissions: ['oj_access'],
        });

        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'restricted.js'), `
module.exports = {
    manifest: {
        name: 'restricted',
        permissions: ['oj_access']
    },
    onLoad: function(oj, db) {
        db.query("SELECT 1");
    }
};
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        const plugin = pluginSystem.plugins['restricted.js'];
        expect(plugin).toBeDefined();
        // 没有 db 权限，调用 db.query 应该被代理拦截
        expect(() => plugin.module.executeHook('onLoad')).toThrow(/Unauthorized action/);
    });
});
