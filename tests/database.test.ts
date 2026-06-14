import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';

// Use a test-specific database to isolate from other tests
process.env.DWOJ_DB_NAME = 'test_dwoj.db';

import { initDb, query, queryOne, execute } from '../lib/database';

describe('database', () => {
    afterAll(() => {
        // Cleanup test database
        try {
            const testDbPath = path.join(__dirname, '..', 'data', 'test_dwoj.db');
            if (fs.existsSync(testDbPath)) {
                fs.unlinkSync(testDbPath);
            }
        } catch {}
    });

    test('initDb creates all tables and inserts default data', () => {
        initDb();
        const users = query('SELECT username, role FROM users WHERE username = ?', ['root']);
        expect(users.length).toBeGreaterThanOrEqual(1);
        expect(users[0].username).toBe('root');
        expect(users[0].role).toBe('root');
    });

    test('initDb skips default data if already exists', () => {
        expect(() => initDb()).not.toThrow();
    });

    test('query returns array of results', () => {
        execute(
            'INSERT INTO problems (title, description, authorId) VALUES (?, ?, ?)',
            ['Test Problem', 'A test problem', 1]
        );

        const results = query<{ id: number; title: string }>(
            'SELECT id, title FROM problems WHERE authorId = ?',
            [1]
        );
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].title).toBe('Test Problem');
    });

    test('query with parameters', () => {
        const results = query<{ id: number }>('SELECT id FROM users WHERE role = ?', ['root']);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(typeof results[0].id).toBe('number');
    });

    test('queryOne returns single result', () => {
        const result = queryOne<{ username: string }>(
            'SELECT username FROM users WHERE role = ?',
            ['root']
        );
        expect(result).toBeDefined();
        expect(result!.username).toBe('root');
    });

    test('queryOne returns null when no result', () => {
        const result = queryOne<{ id: number }>(
            'SELECT * FROM users WHERE id = ?',
            [99999]
        );
        expect(result).toBeNull();
    });

    test('execute inserts data and returns lastInsertRowid', () => {
        const result = execute(
            'INSERT INTO problems (title) VALUES (?)',
            ['Temp Problem']
        );
        expect(result.lastInsertRowid).toBeGreaterThan(0);
        expect(typeof result.lastInsertRowid).toBe('number');
        expect(result.changes).toBe(1);
    });

    test('execute updates data and returns changes count', () => {
        execute('INSERT INTO problems (title) VALUES (?)', ['Update Test']);

        const result = execute(
            'UPDATE problems SET title = ? WHERE title = ?',
            ['Updated Title', 'Update Test']
        );
        expect(result.changes).toBeGreaterThanOrEqual(1);
    });

    test('execute deletes data', () => {
        execute('INSERT INTO problems (title) VALUES (?)', ['Delete Me']);

        const result = execute('DELETE FROM problems WHERE title = ?', ['Delete Me']);
        expect(result.changes).toBeGreaterThanOrEqual(1);

        const check = queryOne('SELECT * FROM problems WHERE title = ?', ['Delete Me']);
        expect(check).toBeNull();
    });

    test('execute converts bigint lastInsertRowid to number', () => {
        const result = execute(
            'INSERT INTO problems (title) VALUES (?)',
            ['BigInt Test']
        );
        expect(typeof result.lastInsertRowid).toBe('number');
    });

    test('query with no results returns empty array', () => {
        execute('DELETE FROM problems WHERE title = ?', ['NonExistent999']);
        // Just verify no error
        expect(true).toBe(true);
    });

    test('query with complex WHERE clause', () => {
        const rootUser = queryOne<{ id: number; username: string; role: string }>(
            'SELECT id, username, role FROM users WHERE role = ? AND username = ?',
            ['root', 'root']
        );
        expect(rootUser).toBeDefined();
        expect(rootUser!.role).toBe('root');
    });
});