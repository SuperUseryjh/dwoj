import { describe, expect, test } from 'bun:test';

// 这些测试只覆盖后端选择逻辑，不会真的启动虚拟机
// （JUDGE_SANDBOX / DWOJ_DB_NAME 由 tests/setup.ts 在 preload 阶段统一设置）

import {
    STATUS_TEXT,
    UNFINISHED_STATUS,
    getBackend,
    resetBackend,
    resolveSandboxMode,
    v86AssetsReady,
} from '../lib/judge/backend';

describe('judge backend / selection', () => {
    test('explicit process mode is respected', () => {
        resetBackend('process');
        expect(resolveSandboxMode()).toBe('process');
        const backend = getBackend();
        expect(backend.name).toBe('process');
        expect(backend.languages).toContain('python');
    });

    test('backend instance is a singleton', () => {
        expect(getBackend()).toBe(getBackend());
    });

    test('resetBackend drops the cached instance', () => {
        const first = getBackend();
        resetBackend('process');
        expect(getBackend()).not.toBe(first);
    });

    test('v86 asset check is safe when directory is missing', () => {
        expect(typeof v86AssetsReady()).toBe('boolean');
    });
});

describe('judge backend / verdict vocabulary', () => {
    test('status texts are stable', () => {
        expect(STATUS_TEXT.TLE).toBe('Time Limit Exceeded');
        expect(STATUS_TEXT.RE).toBe('Runtime Error');
        expect(STATUS_TEXT.OLE).toBe('Output Limit Exceeded');
        expect(STATUS_TEXT.SE).toBe('System Error');
        expect(STATUS_TEXT.CE).toBe('Compile Error');
    });

    test('unfinished statuses are re-queued on startup', () => {
        expect(UNFINISHED_STATUS).toContain('Pending');
        expect(UNFINISHED_STATUS).toContain('Running');
        expect(UNFINISHED_STATUS).not.toContain('Accepted');
    });
});
