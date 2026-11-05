/**
 * 回归测试：issue #5
 *
 * 普通用户可以让程序把当前隐藏测试点的 stdin 原样写进 stderr，再以非零状态退出。
 * 修复前后端把用户 stderr 当作 RE 的 errorInfo 回显到本人提交详情页，
 * 等于把未公开的测试输入直接送给用户。
 *
 * 这里锁死三层：
 *   1. 后端（process）返回的公开 message 不含 stderr，stderr 只进 diagnostic；
 *   2. runJudge 写库时 errorInfo 不含 stderr/隐藏输入，errorDetail 才保存；
 *   3. 公开文案函数 runtimeErrorMessage 只包含退出码/信号。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

import { PROB_DIR } from '../config';
import { execute, initDb, queryOne } from '../lib/database';
import { resetBackend, runtimeErrorMessage } from '../lib/judge/backend';
import { runJudge } from '../controllers/judge';
import { ProcessBackend } from '../lib/judge/process_backend';
import { classifyGuestResult } from '../lib/judge/v86_backend';

const SECRET = 'AUDIT_401_SECRET=still-hidden';
const SECRET_INPUT = `${SECRET}\n`;
const SECRET_HEX = Buffer.from(SECRET_INPUT, 'utf-8').toString('hex');
const SECRET_B64 = Buffer.from(SECRET_INPUT, 'utf-8').toString('base64');
const SECRET_HEX_NO_NL = Buffer.from(SECRET, 'utf-8').toString('hex');
const SECRET_B64_NO_NL = Buffer.from(SECRET, 'utf-8').toString('base64');

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const HAS_PYTHON = (() => {
    try {
        return spawnSync(PYTHON_CMD, ['-c', 'print(1)']).status === 0;
    } catch {
        return false;
    }
})();

function assertNoLeak(publicText: string): void {
    expect(publicText).not.toContain(SECRET);
    expect(publicText).not.toContain(SECRET_HEX);
    expect(publicText).not.toContain(SECRET_HEX_NO_NL);
    expect(publicText).not.toContain(SECRET_B64);
    expect(publicText).not.toContain(SECRET_B64_NO_NL);
}

const LEAK_SCRIPTS: Array<{ name: string; code: string; expectedDiagnostic: string }> = [
    {
        name: '原文写 stderr',
        code: 'import sys\nsys.stderr.write(sys.stdin.read())\nsys.stderr.flush()\nsys.exit(1)',
        expectedDiagnostic: SECRET,
    },
    {
        name: 'hex 编码写 stderr',
        code: 'import sys\nsys.stderr.write(sys.stdin.buffer.read().hex())\nsys.stderr.flush()\nsys.exit(1)',
        expectedDiagnostic: SECRET_HEX,
    },
    {
        name: 'base64 编码写 stderr',
        code: [
            'import sys, base64',
            'sys.stderr.write(base64.b64encode(sys.stdin.buffer.read()).decode())',
            'sys.stderr.flush()',
            'sys.exit(1)',
        ].join('\n'),
        expectedDiagnostic: SECRET_B64,
    },
    {
        // v86 后端曾把退出码 123 当成 CE；process 后端这里也要保证不因退出码改变公开文案
        name: '退出码 123 + stderr',
        code: [
            'import sys, os',
            'sys.stderr.write(sys.stdin.buffer.read().hex())',
            'sys.stderr.flush()',
            'os._exit(123)',
        ].join('\n'),
        expectedDiagnostic: SECRET_HEX,
    },
];

describe('security / RE 诊断通道（issue #5）', () => {
    test('runtimeErrorMessage 只包含退出码/信号', () => {
        assertNoLeak(runtimeErrorMessage(1));
        assertNoLeak(runtimeErrorMessage(null, 'SIGSEGV'));
        assertNoLeak(runtimeErrorMessage(137, 'SIGKILL'));
        expect(runtimeErrorMessage(1)).toContain('退出码 1');
        expect(runtimeErrorMessage(null, 'SIGSEGV')).toContain('SIGSEGV');
    });

    test('v86 客户机返回码分类：CE 只认 compileError，运行期 123 是 RE', () => {
        expect(classifyGuestResult(0)).toBe('OK');
        expect(classifyGuestResult(123)).toBe('RE');
        expect(classifyGuestResult(123, 'error: something')).toBe('CE');
        expect(classifyGuestResult(124)).toBe('TLE');
        expect(classifyGuestResult(125)).toBe('OLE');
        expect(classifyGuestResult(1)).toBe('RE');
    });

    test('process 后端：stderr 只进 diagnostic，公开 message 不泄露输入', async () => {
        if (!HAS_PYTHON) return;
        const backend = new ProcessBackend();
        await backend.init();

        for (const script of LEAK_SCRIPTS) {
            const outcome = await backend.execute({
                language: 'python',
                code: script.code,
                input: SECRET_INPUT,
                timeLimitMs: 5000,
                maxOutputBytes: 64 * 1024,
            });

            expect(outcome.status).toBe('RE');
            if (outcome.status !== 'RE') return;

            assertNoLeak(outcome.message);
            // 管理员通道仍然保留诊断内容，便于排障
            expect(outcome.diagnostic || '').toContain(script.expectedDiagnostic);
            expect(JSON.stringify({ status: outcome.status, message: outcome.message })).not.toContain(SECRET_HEX);
        }
    });

    test('executeProgram 抛出的 RE 也只把 stderr 放进 diagnostic', async () => {
        if (!HAS_PYTHON) return;
        const { executeProgram } = await import('../lib/judge/process_backend');
        const err: any = await executeProgram(
            'python',
            LEAK_SCRIPTS[0].code,
            SECRET_INPUT,
            5000,
        ).catch(e => e);

        expect(err?.kind).toBe('RE');
        assertNoLeak(String(err?.message || ''));
        expect(String(err?.diagnostic || '')).toContain(SECRET);
    });
});

describe('security / runJudge 落库策略（issue #5）', () => {
    let problemId = 0;
    let submissionId = 0;

    beforeAll(async () => {
        await initDb();
        // 强制使用进程后端，避免在测试里启动虚拟机
        resetBackend('process');
    });

    afterAll(async () => {
        try {
            if (submissionId) await execute('DELETE FROM submissions WHERE id = ?', [submissionId]);
            if (problemId) {
                await execute('DELETE FROM submissions WHERE problemId = ?', [problemId]);
                await execute('DELETE FROM problems WHERE id = ?', [problemId]);
                fs.removeSync(path.join(PROB_DIR, String(problemId)));
            }
        } catch { /* ignore */ }
        resetBackend();
    });

    test('隐藏测试输入不出现在 errorInfo，只出现在 errorDetail', async () => {
        if (!HAS_PYTHON) return;

        const problem = await execute(
            'INSERT INTO problems (title, description, authorId, timeLimit) VALUES (?, ?, ?, ?)',
            [`__stderr_leak_${Date.now()}__`, '', 1, 2000],
        );
        problemId = Number(problem.lastInsertRowid);

        const caseDir = path.join(PROB_DIR, String(problemId));
        fs.ensureDirSync(caseDir);
        fs.writeFileSync(path.join(caseDir, '1.in'), SECRET_INPUT, 'utf-8');
        fs.writeFileSync(path.join(caseDir, '1.out'), 'OK\n', 'utf-8');

        const submission = await execute(
            `INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [problemId, 1, 'root', 'python', LEAK_SCRIPTS[1].code, 'Pending', new Date().toISOString(), '[]'],
        );
        submissionId = Number(submission.lastInsertRowid);

        await runJudge(submissionId, null);

        const row = await queryOne<{ status: string; errorInfo: string | null; errorDetail: string | null }>(
            'SELECT status, errorInfo, errorDetail FROM submissions WHERE id = ?',
            [submissionId],
        );

        expect(row?.status).toBe('Runtime Error');
        // 普通用户能看到的字段：只能有测试点 + 退出码
        const publicView = `${row?.errorInfo || ''}\n${row?.status || ''}`;
        assertNoLeak(publicView);
        expect(row?.errorInfo).toContain('测试点 1');
        expect(row?.errorInfo).toContain('退出码');
        // 管理员诊断字段：保留 stderr 便于定位
        expect(row?.errorDetail || '').toContain(SECRET_HEX);
    });
});
