import fs from 'fs-extra';
import path from 'path';
import * as config from '../../config';
import { JudgeError } from './backend';

export interface TestCase {
    name: string;
    inPath: string;
    outPath: string;
}

/** 把题目的 timeLimit 规整到允许区间内（毫秒） */
export function clampTimeLimit(timeLimit: number | null | undefined): number {
    const value = Number(timeLimit);
    if (!Number.isFinite(value) || value <= 0) return config.DEFAULT_TIME_LIMIT_MS;
    return Math.min(config.MAX_TIME_LIMIT_MS, Math.max(config.MIN_TIME_LIMIT_MS, Math.round(value)));
}

/** 按数字自然序比较测试点文件名：1.in < 2.in < 10.in */
export function compareCaseName(a: string, b: string): number {
    const numA = /^(\d+)/.exec(path.basename(a, '.in'));
    const numB = /^(\d+)/.exec(path.basename(b, '.in'));
    if (numA && numB) {
        const diff = Number(numA[1]) - Number(numB[1]);
        if (diff !== 0) return diff;
        return a.localeCompare(b);
    }
    if (numA) return -1;
    if (numB) return 1;
    return a.localeCompare(b);
}

/**
 * 加载测试点。缺少 .out 的测试点会直接报 System Error，
 * 而不是像以前那样静默跳过（那样会导致永远 AC 不了又查不出原因）。
 */
export function loadCases(probPath: string): TestCase[] {
    const files = fs.readdirSync(probPath);
    const inputs = files.filter(f => f.endsWith('.in')).sort(compareCaseName);

    if (inputs.length === 0) {
        throw new JudgeError('SE', '测试数据缺失（未找到 .in 文件）');
    }

    const cases: TestCase[] = [];
    const missing: string[] = [];
    for (const file of inputs) {
        const name = path.basename(file, '.in');
        const outPath = path.join(probPath, `${name}.out`);
        if (!fs.existsSync(outPath)) {
            missing.push(`${name}.out`);
            continue;
        }
        cases.push({ name, inPath: path.join(probPath, file), outPath });
    }

    if (missing.length > 0) {
        const preview = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ' …' : '');
        throw new JudgeError('SE', `测试数据不完整，缺少 ${preview}`);
    }
    return cases;
}
