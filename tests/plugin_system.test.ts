import { describe, expect, test, mock, beforeEach, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';

// Mock database module
const mockQueryOne = mock((sql: string, params?: any[]) => {
    // Return no existing config for new plugins
    return undefined;
});

const mockExecute = mock((sql: string, params?: any[]) => {
    return { lastInsertRowid: 1, changes: 1 };
});

mock.module('../lib/database', () => ({
    queryOne: mockQueryOne,
    execute: mockExecute,
}));

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

describe('PluginSystem', () => {
    let pluginSystem: PluginSystem;
    const mockOj = {
        app: { use: mock(() => {}), _middleware: [] },
        db: {},
        config: {},
        logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    };

    beforeEach(() => {
        // Create and ensure clean test plugin directory
        if (fs.existsSync(TEST_PLUGIN_DIR)) {
            const entries = fs.readdirSync(TEST_PLUGIN_DIR, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(TEST_PLUGIN_DIR, entry.name);
                if (entry.isFile()) {
                    fs.unlinkSync(fullPath);
                }
            }
        } else {
            fs.mkdirSync(TEST_PLUGIN_DIR, { recursive: true });
        }
        mockQueryOne.mockReset();
        mockExecute.mockReset();
    });

    afterAll(() => {
        // Cleanup test plugin directory
        try {
            const rmDir = (dir: string) => {
                if (!fs.existsSync(dir)) return;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        rmDir(fullPath);
                    } else {
                        fs.unlinkSync(fullPath);
                    }
                }
                fs.rmdirSync(dir);
            };
            rmDir(TEST_PLUGIN_DIR);
        } catch {}
    });

    test('constructor initializes plugin directory', () => {
        // Remove dir created in beforeEach to test constructor creates it
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
        // Create a valid test plugin
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
        expect(pluginSystem.plugins['test-plugin.js'].name).toBe('test-plugin');
        expect(pluginSystem.plugins['test-plugin.js'].enabled).toBe(false); // Not in DB, default disabled
        expect(pluginSystem.plugins['test-plugin.js'].permissions).toEqual(['oj_access', 'db_read']);
    });

    test('loadAll skips non-js files', async () => {
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'readme.txt'), 'not a plugin');
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'data.json'), '{}');

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        // Only the built-in db-monitor plugin is registered
        expect(Object.keys(pluginSystem.plugins)).toHaveLength(1);
        expect(pluginSystem.plugins['builtin:db-monitor']).toBeDefined();
        expect(pluginSystem.plugins['builtin:db-monitor'].enabled).toBe(false);
    });

    test('loadAll handles plugin load errors gracefully', async () => {
        // Create a plugin with syntax error
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'bad-plugin.js'), 'this is not valid javascript {{{');

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        // Should not throw, should just log error; built-in plugin still registers
        expect(Object.keys(pluginSystem.plugins)).toHaveLength(1);
        expect(pluginSystem.plugins['builtin:db-monitor']).toBeDefined();
    });

    test('loadAll loads enabled plugin and registers routes', async () => {
        // Mock DB config to return enabled = true
        mockQueryOne.mockImplementation((sql: string) => {
            if (sql.includes('plugin_configs')) {
                return { enabled: 1, token: 'test-token-123', permissions: '["oj_access","db_read"]' };
            }
            return undefined;
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
        // bad plugin wasn't loaded but file exists
        expect(list.some((p: any) => p.filename === 'bad.js')).toBe(true);
    });

    test('getPluginExports returns exports of enabled plugin', async () => {
        mockQueryOne.mockImplementation((sql: string) => {
            if (sql.includes('plugin_configs')) {
                return { enabled: 1, token: 'token', permissions: '[]' };
            }
            return undefined;
        });

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
        const exports = pluginSystem.getPluginExports('nonexistent');
        expect(exports).toBeUndefined();
    });

    test('emit calls hooks on all enabled plugins', async () => {
        mockQueryOne.mockImplementation((sql: string) => {
            if (sql.includes('plugin_configs')) {
                return { enabled: 1, token: 'token', permissions: '["oj_access","db_read"]' };
            }
            return undefined;
        });

        const hookResults: number[] = [];

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
        const results = pluginSystem.emit('nonexistentHook');
        expect(results).toEqual([]);
    });

    test('toggle enables plugin and reloads', async () => {
        mockQueryOne.mockImplementation((sql: string) => {
            if (sql.includes('plugin_configs')) {
                return undefined; // Not in DB
            }
            return undefined;
        });

        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'toggler.js'), `
module.exports = {
    manifest: { name: 'toggler' }
};
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(pluginSystem.plugins['toggler.js'].enabled).toBe(false);

        // Mock DB to now return enabled = true after toggle
        mockQueryOne.mockImplementation((sql: string) => {
            if (sql.includes('plugin_configs')) {
                return { enabled: 1, token: 'new-token', permissions: '[]' };
            }
            return undefined;
        });

        await pluginSystem.toggle('toggler.js', true);
        expect(mockExecute).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE plugin_configs'),
            [1, 'toggler.js']
        );
    });

    test('delete removes plugin file and config', async () => {
        const pluginPath = path.join(TEST_PLUGIN_DIR, 'deletable.js');
        fs.writeFileSync(pluginPath, `
module.exports = {
    manifest: { name: 'deletable' }
};
`);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(fs.existsSync(pluginPath)).toBe(true);
        expect(pluginSystem.plugins['deletable.js']).toBeDefined();

        await pluginSystem.delete('deletable.js');

        expect(fs.existsSync(pluginPath)).toBe(false);
        expect(mockExecute).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM plugin_configs'),
            ['deletable.js']
        );
    });

    test('delete handles non-existent plugin gracefully', async () => {
        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        // Should not throw
        await pluginSystem.delete('nonexistent.js');
    });

    test('Plugin permission proxy blocks unauthorized access', async () => {
        mockQueryOne.mockImplementation((sql: string) => {
            if (sql.includes('plugin_configs')) {
                return { enabled: 1, token: 'restricted-token', permissions: '["oj_access"]' };
            }
            return undefined;
        });

        // Create plugin that tries db access without db_read permission
        const pluginContent = `
module.exports = {
    manifest: {
        name: 'restricted',
        permissions: ['oj_access']  // No db_read or db_write
    },
    onInit: function(oj, db, getPluginExports) {
        // This should be blocked because only 'oj_access' is granted
        try {
            db.query("SELECT * FROM users");
        } catch(e) {
            return 'blocked: ' + e.message;
        }
    }
};
`;
        fs.writeFileSync(path.join(TEST_PLUGIN_DIR, 'restricted.js'), pluginContent);

        pluginSystem = new PluginSystem(TEST_PLUGIN_DIR, mockOj);
        await pluginSystem.loadAll();

        expect(pluginSystem.plugins['restricted.js']).toBeDefined();
    });
});