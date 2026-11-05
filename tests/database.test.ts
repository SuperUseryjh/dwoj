import { beforeAll, describe, expect, test } from 'bun:test';

// 测试库名统一由 tests/setup.ts 在 preload 阶段指定（test_dwoj.db），
// 这里不再设置 env（静态 import 会被提升，写在文件里已经太晚），
// 也不删除/关闭共享库，避免影响同进程里其它测试文件。
import { initDb, query, queryOne, execute, dialect, upsertSql } from '../lib/database';

beforeAll(async () => {
    await initDb();
});

describe('database', () => {
    test('initDb creates all tables and inserts default data', async () => {
        const users = await query<{ username: string; role: string }>(
            'SELECT username, role FROM users WHERE username = ?', ['root']
        );
        expect(users.length).toBeGreaterThanOrEqual(1);
        expect(users[0].username).toBe('root');
        expect(users[0].role).toBe('root');
    });

    test('initDb is idempotent', async () => {
        await initDb();
        const users = await query('SELECT id FROM users WHERE username = ?', ['root']);
        expect(users.length).toBe(1);
    });

    test('query returns array of results', async () => {
        const marker = `Test Problem ${Date.now()}`;
        await execute(
            'INSERT INTO problems (title, description, authorId, timeLimit) VALUES (?, ?, ?, ?)',
            [marker, 'Description', 1, 1000]
        );

        const results = await query<{ id: number; title: string }>(
            'SELECT id, title FROM problems WHERE title = ?',
            [marker]
        );
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].title).toBe(marker);
    });

    test('query with parameters', async () => {
        const results = await query<{ id: number }>('SELECT id FROM users WHERE role = ?', ['root']);
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test('queryOne returns single result', async () => {
        const result = await queryOne<{ username: string }>(
            'SELECT username FROM users WHERE role = ?',
            ['root']
        );
        expect(result).toBeDefined();
        expect(result!.username).toBe('root');
    });

    test('queryOne returns undefined when no result', async () => {
        const result = await queryOne<{ id: number }>(
            'SELECT id FROM users WHERE username = ?',
            ['nonexistent']
        );
        expect(result).toBeUndefined();
    });

    test('execute inserts data and returns lastInsertRowid', async () => {
        const result = await execute(
            'INSERT INTO problems (title) VALUES (?)',
            ['Insert Test']
        );
        expect(result.lastInsertRowid).toBeGreaterThan(0);
        expect(typeof result.lastInsertRowid).toBe('number');
    });

    test('execute updates data and returns changes count', async () => {
        const marker = `Update Test ${Date.now()}`;
        await execute('INSERT INTO problems (title) VALUES (?)', [marker]);

        const result = await execute(
            'UPDATE problems SET title = ? WHERE title = ?',
            ['Updated', marker]
        );
        expect(result.changes).toBe(1);
    });

    test('execute deletes data', async () => {
        const marker = `Delete Me ${Date.now()}`;
        await execute('INSERT INTO problems (title) VALUES (?)', [marker]);

        const result = await execute('DELETE FROM problems WHERE title = ?', [marker]);
        expect(result.changes).toBe(1);

        const check = await queryOne('SELECT * FROM problems WHERE title = ?', [marker]);
        expect(check).toBeUndefined();
    });

    test('execute reports zero changes when nothing matched', async () => {
        const result = await execute(
            'UPDATE problems SET title = ? WHERE title = ?',
            ['x', 'NonExistent999']
        );
        expect(result.changes).toBe(0);
    });

    test('dialect reports the active database', () => {
        expect(dialect()).toBe('sqlite');
    });

    test('upsertSql generates sqlite upsert syntax', () => {
        const sql = upsertSql('plugin_configs', ['filename', 'enabled'], ['filename'], ['enabled']);
        expect(sql).toContain('ON CONFLICT(filename) DO UPDATE SET');
        expect(sql).toContain('excluded.enabled');
    });
});
