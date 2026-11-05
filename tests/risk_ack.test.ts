import { afterEach, describe, expect, test } from 'bun:test';

// 测试环境变量由 tests/setup.ts 在 preload 阶段统一设置

import { resetBackend } from '../lib/judge/backend';
import {
    RISK_ACK_ENV,
    RISK_ACK_PHRASE,
    confirmUnisolatedJudge,
    needsRiskAcknowledgement,
} from '../lib/judge/risk_ack';

const originalAck = process.env[RISK_ACK_ENV];

function setAck(value: string | undefined): void {
    if (value === undefined) delete process.env[RISK_ACK_ENV];
    else process.env[RISK_ACK_ENV] = value;
}

afterEach(() => {
    setAck(originalAck);
    resetBackend();
});

describe('judge risk acknowledgement', () => {
    test('process 后端需要风险确认', () => {
        resetBackend('process');
        expect(needsRiskAcknowledgement()).toBe(true);
    });

    test('确认短语是逐字匹配的固定字符串', () => {
        expect(RISK_ACK_PHRASE).toBe('I UNDERSTAND');
    });

    test('设置 JUDGE_SANDBOX_ACK=1 时跳过交互确认', () => {
        resetBackend('process');
        setAck('1');
        expect(confirmUnisolatedJudge()).toBe(true);
    });

    test('ack 只认 "1"，其它值不生效', () => {
        resetBackend('process');
        setAck('true');
        // 非 TTY 环境下应仍然拒绝
        if (!process.stdin.isTTY) {
            expect(confirmUnisolatedJudge()).toBe(false);
        }
    });

    test('非 TTY 环境且未确认时拒绝启动', () => {
        resetBackend('process');
        setAck(undefined);
        if (process.stdin.isTTY) return; // 交互终端下无法覆盖此分支
        expect(confirmUnisolatedJudge()).toBe(false);
    });
});
