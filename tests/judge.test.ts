import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';

process.env.DWOJ_DB_NAME = 'test_judge.db';

import * as config from '../config';
import { initDb, execute, queryOne } from '../lib/database';
import { runJudge } from '../lib/judge/runner';
import { judgeQueue } from '../lib/judge/queue';

function pythonAvailable(): boolean {
    for (const cmd of ['python3', 'python']) {
        try {
            const res = Bun.spawnSync([cmd, '-V']);
            if (res.exitCode === 0) return true;
        } catch { /* ignore */ }
    }
    return false;
}

const HAS_PYTHON = pythonAvailable();
const BASE_PROBLEM_ID = 990000 + (Date.now() % 1000);
let problemSeq = 0;

function createProblemFiles(input: string, output: string | null): number {
    const problemId = BASE_PROBLEM_ID + ++problemSeq;
    const dir = path.join(config.PROB_DIR, String(problemId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.in'), input);
    if (output !== null) fs.writeFileSync(path.join(dir, '1.out'), output);
    return problemId;
}

function createSubmission(problemId: number, code: string): number {
    const now = new Date().toLocaleString();
    const result = execute(
        `INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [problemId, 1, 'root', 'python', code, 'Pending', now, '[]']);
    return Number(result.lastInsertRowid);
}

function getSubmission(id: number): any {
    return queryOne<any>('SELECT * FROM submissions WHERE id = ?', [id]);
}

describe('judge', () => {
    beforeAll(() => {
        initDb();
    });

    afterAll(() => {
        for (let i = 1; i <= problemSeq; i++) {
            try { fs.rmSync(path.join(config.PROB_DIR, String(BASE_PROBLEM_ID + i)), { recursive: true, force: true }); } catch { /* ignore */ }
        }
        try { fs.rmSync(path.join(config.DATA_DIR, 'test_judge.db'), { force: true }); } catch { /* ignore */ }
    });

    test.skipIf(!HAS_PYTHON)('AC submission', async () => {
        const problemId = createProblemFiles('hello\n', 'hello\n');
        const id = createSubmission(problemId, 'import sys\nprint(sys.stdin.read().strip())\n');
        await runJudge(id);
        const sub = getSubmission(id);
        expect(sub.status).toBe('Accepted');
        expect(JSON.parse(sub.caseResults).every((c: any) => c.status === 'AC')).toBe(true);
    });

    test.skipIf(!HAS_PYTHON)('WA submission', async () => {
        const problemId = createProblemFiles('hello\n', 'hello\n');
        const id = createSubmission(problemId, 'print("wrong")\n');
        await runJudge(id);
        expect(getSubmission(id).status).toBe('Wrong Answer');
    });

    test.skipIf(!HAS_PYTHON)('infinite loop is killed with TLE', async () => {
        const problemId = createProblemFiles('1\n', '1\n');
        const id = createSubmission(problemId, 'while True:\n    pass\n');
        const startedAt = Date.now();
        await runJudge(id);
        const sub = getSubmission(id);
        expect(sub.status).toBe('Runtime Error');
        expect(String(sub.errorInfo)).toMatch(/Time Limit|TLE/);
        expect(Date.now() - startedAt).toBeLessThanOrEqual(3000);
    });

    test.skipIf(!HAS_PYTHON)('10MB output is OLE', async () => {
        const problemId = createProblemFiles('1\n', '1\n');
        const id = createSubmission(problemId, 'for _ in range(2000):\n    print("x" * 6000)\n');
        await runJudge(id);
        const sub = getSubmission(id);
        expect(sub.status).toBe('Runtime Error');
        expect(String(sub.errorInfo)).toMatch(/Output Limit/);
    });

    test('missing .out is Data Error, never AC', async () => {
        const problemId = createProblemFiles('1\n', null);
        const id = createSubmission(problemId, 'print(1)\n');
        await runJudge(id);
        expect(getSubmission(id).status).toBe('Data Error');
    });

    test.skipIf(!HAS_PYTHON)('recover resumes Pending submissions', async () => {
        const problemId = createProblemFiles('hello\n', 'hello\n');
        const id = createSubmission(problemId, 'import sys\nprint(sys.stdin.read().strip())\n');
        judgeQueue.recover();

        const deadline = Date.now() + 10000;
        let status = 'Pending';
        while (Date.now() < deadline) {
            status = getSubmission(id)?.status;
            if (status !== 'Pending' && status !== 'Running') break;
            await new Promise(r => setTimeout(r, 200));
        }
        expect(status).toBe('Accepted');
    });
});
