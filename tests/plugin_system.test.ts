import { describe, expect, test, beforeEach, afterAll, mock } from 'bun:test';
import path from 'path';
import fs from 'fs';

mock.module('../lib/logger', () => ({
    default: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
}));

import PluginSystem from '../lib/plugin_system';

const TEST_PLUGIN_DIR = path.join(__dirname, '_test_plugins');
const CONFIG_PATH = path.join(TEST_PLUGIN_DIR, 'config.json');

function resetPluginDir(): void {
    if (fs.existsSync(TEST_PLUGIN_DIR)) {
        for (const entry of fs.readdirSync(TEST_PLUGIN_DIR, { withFileTypes: true })) {
            fs.rmSync(path.join(TEST_PLUGIN_DIR, entry.name), { recursive: true, force: true });
        }
    } else {
        fs.mkdirSync(TEST_PLUGIN_DIR, { recursive: true });
    }
}

describe('PluginSystem', () => {
    let pluginSystem: PluginSystem;
    const mockOj = {
        app: { use: mock(() => {}), _middleware: [] },
        db: {},
        config: {},
        logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    };

    beforeEach(() => {
        resetPluginDir();
    });

    afterAll(() => {
        try { fs.rmSync(TEST_PLUGIN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('constructor creates plugin directory', () => {
        fs.rmSync(TEST_PLUGIN_DIR, { recursive: true, force: true });
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        expect(fs.existsSync(TEST_PLUGIN_DIR)).toBe(true);
        expect(pluginSystem.pluginDir).toBe(TEST_PLUGIN_DIR);
        expect(pluginSystem.plugins).toEqual({});
    });

    test('loadAll only registers builtin plugin (disabled) when directory is empty', async () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();
        expect(Object.keys(pluginSystem.plugins)).toHaveLength(1);
        expect(pluginSystem.plugins['builtin:db-monitor'].enabled).toBe(false);
    });

    test('loadAll loads valid .js plugins as disabled by default', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'test-plugin.js'), `
module.exports = {
    manifest: { name: 'test-plugin', description: 'A test plugin', version: '1.0.0' },
    onRoute: function(oj, db, getPluginExports) { oj.app.use(function(req, res, next) { next(); }); }
};
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(Object.keys(pluginSystem.plugins)).toHaveLength(2);
        expect(pluginSystem.plugins['test-plugin.js'].name).toBe('test-plugin');
        expect(pluginSystem.plugins['test-plugin.js'].enabled).toBe(false);
        expect(pluginSystem.plugins['test-plugin.js'].builtin).toBeUndefined();
    });

    test('loadAll skips non-js files', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'readme.txt'), 'not a plugin');
        fs.mkdirSync(path.join(TEST_PLUGIN_DIR, 'assets'));

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(Object.keys(pluginSystem.plugins)).toHaveLength(1);
    });

    test('loadAll handles plugin load errors gracefully', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'bad-plugin.js'), 'this is not valid javascript {{{');

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(Object.keys(pluginSystem.plugins)).toHaveLength(1);
        expect(pluginSystem.plugins['builtin:db-monitor']).toBeDefined();
    });

    test('enabled plugin from config.json registers routes and exports', async () => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ 'active-plugin.js': { enabled: true } }));
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'active-plugin.js'), `
module.exports = {
    manifest: { name: 'active-plugin' },
    onRoute: function(oj) { oj.app.use('plugin_route'); },
    exports: { helper: function() { return 42; } }
};
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(pluginSystem.plugins['active-plugin.js'].enabled).toBe(true);
        expect(mockOj.app.use).toHaveBeenCalled();
        expect(pluginSystem.getPluginExports('active-plugin').helper()).toBe(42);
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

    test('getPluginExports returns undefined for unknown plugin', () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        expect(pluginSystem.getPluginExports('nonexistent')).toBeUndefined();
    });

    test('emit calls hooks on enabled plugins and short-circuits when none', async () => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ 'hook1.js': { enabled: true } }));
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'hook1.js'), `
module.exports = {
    manifest: { name: 'hook1' },
    onCustomHook: function(oj, db, getPluginExports, value) { return value * 2; }
};
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(pluginSystem.hasHook('onCustomHook')).toBe(true);
        const results = pluginSystem.emit('onCustomHook', 21);
        expect(results).toContain(42);
    });

    test('emit returns empty array when no hooks match', () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        expect(pluginSystem.emit('nonexistentHook')).toEqual([]);
    });

    test('toggle persists state to plugins/config.json', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'toggler.js'), `
module.exports = { manifest: { name: 'toggler' } };
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();
        expect(pluginSystem.plugins['toggler.js'].enabled).toBe(false);

        await pluginSystem.toggle('toggler.js', true);
        expect(pluginSystem.plugins['toggler.js'].enabled).toBe(true);

        const state = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        expect(state['toggler.js'].enabled).toBe(true);
    });

    test('delete removes plugin file and its config entry', async () => {
        const pluginPath = path.join(TEST_PLUGIN_DIR, 'deletable.js');
        fs.writeFileSync(pluginPath, `module.exports = { manifest: { name: 'deletable' } };`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();
        await pluginSystem.toggle('deletable.js', true);

        expect(fs.existsSync(pluginPath)).toBe(true);
        await pluginSystem.delete('deletable.js');

        expect(fs.existsSync(pluginPath)).toBe(false);
        const state = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        expect(state['deletable.js']).toBeUndefined();
    });

    test('delete handles non-existent plugin gracefully', async () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.delete('nonexistent.js');
    });

    test('builtin plugins cannot be deleted', async () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();
        await pluginSystem.delete('builtin:db-monitor');
        expect(pluginSystem.plugins['builtin:db-monitor']).toBeDefined();
    });
});
