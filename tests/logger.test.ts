import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { LOG_LEVELS, MAX_MODULE_LENGTH, createLogger, normalizeModuleName, setLogSink } from '../lib/logger';

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

describe('logger / 格式与模块名', () => {
    let captured: { level: string; line: string }[] = [];

    beforeEach(() => {
        captured = [];
        setLogSink((level, line) => captured.push({ level, line }));
    });

    afterEach(() => {
        setLogSink(null);
    });

    test('格式为 [等级][模块] 时间 信息', () => {
        createLogger('judge').info('submission 1 -> Accepted');

        expect(captured).toHaveLength(1);
        expect(captured[0].line).toMatch(
            /^\[INFO\]\[judge\] +\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z submission 1 -> Accepted$/,
        );
    });

    test('不同等级/模块的时间列左对齐', () => {
        createLogger('db').info('a');
        createLogger('broker').warn('b');
        createLogger('v86').error('c');
        createLogger('plugin').info('d');

        const columns = captured.map(c => c.line.search(TS));
        expect(new Set(columns).size).toBe(1);
        expect(columns[0]).toBeGreaterThan(0);
    });

    test('等级统一为 4 字符', () => {
        expect(LOG_LEVELS).toEqual(['INFO', 'WARN', 'ERRO']);
        expect(new Set(LOG_LEVELS.map(level => level.length)).size).toBe(1);
    });

    test('模块名超过 6 字符会被截断', () => {
        createLogger('verylongmodule').info('x');
        expect(captured[0].line).toContain('[INFO][verylo]');
        expect(MAX_MODULE_LENGTH).toBe(6);
    });

    test('模块名会被规整（小写、去掉非法字符与扩展名）', () => {
        expect(normalizeModuleName('db-monitor.js')).toBe('dbmon');
        expect(normalizeModuleName('My Plugin!')).toBe('myplu');
        expect(normalizeModuleName('v86')).toBe('v86');
        expect(normalizeModuleName('')).toBe('');
    });

    test('error 支持附加 Error 对象，且不会把 stack 混进单行', () => {
        createLogger('http').error('render failed', new Error('boom'));
        expect(captured[0].level).toBe('ERRO');
        expect(captured[0].line).toMatch(/^\[ERRO\]\[http\] +.* render failed$/);
    });

    test('日志行不带结尾换行（由打印方决定）', () => {
        createLogger('test').info('no-newline');
        expect(captured[0].line.endsWith('\n')).toBe(false);
    });

    test('清空 sink 后回到 console，不再投递', () => {
        setLogSink(null);
        createLogger('test').info('after-reset');
        expect(captured).toHaveLength(0);
    });
});
