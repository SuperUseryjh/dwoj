import { describe, expect, test, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';

// 测试库/后端由 tests/setup.ts 在 preload 阶段统一设置

import { compareOutput, normalizeOutput } from '../lib/judge/compare';
import { compareCaseName, clampTimeLimit, loadCases } from '../lib/judge/testcase';
import { executeProgram } from '../lib/judge/process_backend';
import { JUDGE_DIR, DEFAULT_TIME_LIMIT_MS, MIN_TIME_LIMIT_MS, MAX_TIME_LIMIT_MS } from '../config';

const tmpRoot = path.join(__dirname, 'judge_tmp_fixture');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const HAS_PYTHON = (() => {
    try {
        return spawnSync(PYTHON_CMD, ['-c', 'print(1)']).status === 0;
    } catch {
        return false;
    }
})();

afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe('judge / output comparison', () => {
    test('ignores trailing whitespace on each line', () => {
        expect(compareOutput('1 2   \n3\n', '1 2\n3')).toBe(true);
    });

    test('ignores trailing blank lines', () => {
        expect(compareOutput('42\n\n\n', '42')).toBe(true);
    });

    test('treats LF and CRLF as equivalent', () => {
        expect(compareOutput('a\nb\n', 'a\r\nb\r\n')).toBe(true);
    });

    test('keeps leading and inner whitespace significant', () => {
        expect(compareOutput(' 1', '1')).toBe(false);
        expect(compareOutput('1  2', '1 2')).toBe(false);
    });

    test('distinguishes empty output from non-empty expected', () => {
        expect(compareOutput('', '0')).toBe(false);
        expect(compareOutput('', '\n\n')).toBe(true);
    });

    test('normalizeOutput does not join separate lines', () => {
        expect(normalizeOutput('a\nb')).toBe('a\nb');
    });
});

describe('judge / case ordering', () => {
    test('sorts numerically instead of lexicographically', () => {
        expect(['10.in', '2.in', '1.in'].sort(compareCaseName)).toEqual(['1.in', '2.in', '10.in']);
    });

    test('non-numeric names still sort deterministically', () => {
        expect(['b.in', 'a.in'].sort(compareCaseName)).toEqual(['a.in', 'b.in']);
    });
});

describe('judge / time limit clamping', () => {
    test('falls back to default for invalid values', () => {
        expect(clampTimeLimit(null)).toBe(DEFAULT_TIME_LIMIT_MS);
        expect(clampTimeLimit(0)).toBe(DEFAULT_TIME_LIMIT_MS);
        expect(clampTimeLimit(Number.NaN)).toBe(DEFAULT_TIME_LIMIT_MS);
    });

    test('clamps into the allowed range', () => {
        expect(clampTimeLimit(1)).toBe(MIN_TIME_LIMIT_MS);
        expect(clampTimeLimit(999999)).toBe(MAX_TIME_LIMIT_MS);
        expect(clampTimeLimit(1500)).toBe(1500);
    });
});

describe('judge / testcase loading', () => {
    test('reports a system error when there is no data at all', () => {
        fs.mkdirSync(tmpRoot, { recursive: true });
        expect(() => loadCases(tmpRoot)).toThrow(/未找到 \.in/);
    });

    test('reports a system error when a .out is missing', () => {
        const dir = path.join(tmpRoot, 'missing-out');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '1.in'), '1');
        fs.writeFileSync(path.join(dir, '2.in'), '2');
        fs.writeFileSync(path.join(dir, '2.out'), '2');
        expect(() => loadCases(dir)).toThrow(/1\.out/);
    });

    test('returns cases in numeric order', () => {
        const dir = path.join(tmpRoot, 'sorted');
        fs.mkdirSync(dir, { recursive: true });
        for (const n of [1, 2, 10]) {
            fs.writeFileSync(path.join(dir, `${n}.in`), String(n));
            fs.writeFileSync(path.join(dir, `${n}.out`), String(n));
        }
        expect(loadCases(dir).map(c => c.name)).toEqual(['1', '2', '10']);
    });
});

describe('judge / c++ execution', () => {
    const HAS_COMPILER = (() => {
        try {
            return ['g++', 'gcc'].some(cmd => {
                try { return spawnSync(cmd, ['--version']).status === 0; } catch { return false; }
            });
        } catch {
            return false;
        }
    })();

    test('compiles and runs a c++ program', async () => {
        if (!HAS_COMPILER) return;
        const code = [
            '#include <cstdio>',
            'int main() {',
            '    int a, b;',
            '    if (scanf("%d %d", &a, &b) != 2) return 0;',
            '    printf("%d\\n", a + b);',
            '    return 0;',
            '}',
        ].join('\n');
        const out = await executeProgram('cpp', code, '2 3\n', 20000);
        expect(compareOutput(out, '5')).toBe(true);
    });

    test('reports compile errors instead of runtime errors', async () => {
        if (!HAS_COMPILER) return;
        await expect(executeProgram('cpp', 'int main() { this is not c++ }', '', 20000))
            .rejects.toMatchObject({ kind: 'CE' });
    });

    test('classifies crashing binaries as runtime errors', async () => {
        if (!HAS_COMPILER) return;
        await expect(executeProgram('cpp', 'int main() { int *p = nullptr; *p = 1; return 0; }', '', 20000))
            .rejects.toMatchObject({ kind: 'RE' });
    });
});

describe('judge / sandboxed execution', () => {
    test('returns stdout for a passing program', async () => {
        if (!HAS_PYTHON) return;
        const out = await executeProgram('python', 'a, b = map(int, input().split())\nprint(a + b)', '1 2\n', 3000);
        expect(compareOutput(out, '3')).toBe(true);
    });

    test('classifies infinite loops as Time Limit Exceeded', async () => {
        if (!HAS_PYTHON) return;
        await expect(executeProgram('python', 'while True:\n    pass', '', 500)).rejects.toThrow(/超时/);
    });

    test('classifies crashing programs as Runtime Error without echoing stderr', async () => {
        if (!HAS_PYTHON) return;
        // issue #5：stderr 里可能有隐藏测试输入，只能进 diagnostic，不能进公开 message
        const err = await executeProgram('python', 'raise SystemError("boom")', '', 3000).catch(e => e);
        expect(err).toMatchObject({ kind: 'RE' });
        expect(err.message).not.toContain('boom');
        expect(err.diagnostic).toContain('boom');
    });

    test('does not crash when the program never reads stdin', async () => {
        if (!HAS_PYTHON) return;
        const big = 'x'.repeat(200000);
        await expect(executeProgram('python', 'print("ok")', big, 3000)).resolves.toContain('ok');
    });

    test('rejects unknown languages as Compile Error', async () => {
        await expect(executeProgram('cobol', 'DISPLAY "HI".', '', 1000)).rejects.toThrow(/不支持的语言/);
    });

    test('cleans up its working directory after each run', async () => {
        if (!HAS_PYTHON) return;
        const before = fs.existsSync(JUDGE_DIR) ? fs.readdirSync(JUDGE_DIR).length : 0;
        await executeProgram('python', 'print(input())', 'hi\n', 3000);
        const after = fs.existsSync(JUDGE_DIR) ? fs.readdirSync(JUDGE_DIR).length : 0;
        expect(after).toBeLessThanOrEqual(before);
    });
});
