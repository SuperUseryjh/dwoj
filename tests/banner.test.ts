import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { renderBanner, stripAnsi, supportsColor } from '../lib/banner';
import { CURRENT_VERSION } from '../config';

const INFO = {
    version: '9.9.9',
    port: 3000,
    mode: 'multi-process' as const,
    backend: 'v86',
    languages: ['python', 'cpp'],
    pid: 12345,
    logFile: 'app_20261104_180324.log',
};

describe('banner / 渲染', () => {
    test('所有行等宽（含边框），不会因模块名/语言多少而错位', () => {
        const lines = renderBanner(INFO).split('\n');
        const widths = new Set(lines.map(line => [...line].length));
        expect(widths.size).toBe(1);
        expect(lines.length).toBeGreaterThanOrEqual(10);
    });

    test('包含版本 / 端口 / 模式 / 后端 / 日志文件', () => {
        const text = renderBanner(INFO);
        expect(text).toContain('DWOJ 9.9.9');
        expect(text).toContain('http://localhost:3000');
        expect(text).toContain('multi-process (broker 12345)');
        expect(text).toContain('v86 (python, cpp)');
        expect(text).toContain('app_20261104_180324.log');
    });

    test('v86 后端会提示客户机在后台启动', () => {
        expect(renderBanner(INFO)).toContain('booting in background');
        expect(renderBanner({ ...INFO, backend: 'process' })).not.toContain('booting in background');
    });

    test('单进程模式不显示 broker pid', () => {
        const text = renderBanner({ ...INFO, mode: 'single-process' });
        expect(text).toContain('single-process');
        expect(text).not.toContain('broker 12345');
    });

    test('彩色版本只是套了 ANSI，去掉后与纯文本完全一致', () => {
        const plain = renderBanner(INFO, { color: false });
        const colored = renderBanner(INFO, { color: true });
        expect(colored).toContain('\x1b[');
        expect(stripAnsi(colored)).toBe(plain);
    });

    test('缺少 backend / languages 时不会崩', () => {
        const text = renderBanner({ version: '1.0.0', port: 80, mode: 'multi-process', pid: 1 });
        expect(text).toContain('unknown (n/a)');
    });

    test('supportsColor 返回布尔值', () => {
        expect(typeof supportsColor()).toBe('boolean');
    });
});

describe('banner / 版本号', () => {
    test('config.CURRENT_VERSION 与 package.json 保持一致', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
        expect(pkg.version).toBe(CURRENT_VERSION);
    });
});
