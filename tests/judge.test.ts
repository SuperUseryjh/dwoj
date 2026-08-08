import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'fs-extra';
import path from 'path';

process.env.DWOJ_DB_NAME = 'test_judge.db';
process.env.JUDGE_TOKEN = 'test-judge-token';

import { initDb, execute, queryOne } from '../lib/database';
import { runJudge } from '../controllers/judge';

const problemId = 990001;
const problemDir = path.join(__dirname, '..', 'problems_data', String(problemId));
const databasePath = path.join(__dirname, '..', 'data', 'test_judge.db');

describe('C++ judge dispatch', () => {
    beforeEach(() => {
        initDb();
        fs.emptyDirSync(problemDir);
        fs.writeFileSync(path.join(problemDir, '1.in'), '2 3\n');
        fs.writeFileSync(path.join(problemDir, '1.out'), '5\n');
        execute('DELETE FROM submissions');
        execute('DELETE FROM problems WHERE id = ?', [problemId]);
        execute('INSERT INTO problems (id, title, timeLimit) VALUES (?, ?, ?)', [problemId, 'sum', 500]);
        execute('UPDATE judge_settings SET judgeToken = ?, maxConcurrency = ? WHERE id = 1', ['test-judge-token', 1]);
    });

    test('sends C++ submissions to the isolated judge and stores an accepted result', async () => {
        const fetchMock = mock(async (url: string, init: RequestInit) => {
            expect(url).toBe('http://judge:8080/judge');
            expect(init.headers).toMatchObject({ Authorization: 'Bearer test-judge-token' });
            expect(JSON.parse(String(init.body))).toMatchObject({ input: '2 3\n', timeLimitMs: 500 });
            return new Response(JSON.stringify({ status: 'OK', output: '5\n' }), { status: 200 });
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fetchMock as typeof fetch;
        try {
            const result = execute(
                'INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [problemId, 1, 'root', 'cpp', '#include <iostream>', 'Pending', 'now', '[]'],
            );
            await runJudge(result.lastInsertRowid, { emit: mock(() => []) });
            const submission = queryOne<{ status: string; caseResults: string }>('SELECT status, caseResults FROM submissions WHERE id = ?', [result.lastInsertRowid]);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(submission!.status).toBe('Accepted');
            expect(JSON.parse(submission!.caseResults)).toEqual([{ name: '1', status: 'AC' }]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

afterAll(() => {
    fs.removeSync(problemDir);
    fs.removeSync(databasePath);
    fs.removeSync(`${databasePath}-shm`);
    fs.removeSync(`${databasePath}-wal`);
});
