import fs from 'node:fs';
import * as config from '../../config';
import logger from '../logger';
import { resolveSandboxMode } from './backend';

/**
 * 无隔离后端的启动风险确认。
 *
 * `process` 后端直接在服务器上运行用户代码，用户代码拥有与服务器进程相同的
 * 权限（可读写任意文件、发起网络请求、耗尽 CPU / 内存 / 磁盘）。因此当评测
 * 后端解析为 `process` 时 —— 无论是显式设置 JUDGE_SANDBOX=process，还是
 * auto 模式下沙箱资源缺失导致的降级 —— 都必须在启动时由运维人员在控制台
 * 显式确认，否则拒绝启动。
 *
 * 注意：这里刻意使用同步读取 stdin，以避免在 app.ts 里引入 top-level await
 * （tsconfig 的 module 是 commonjs，tsc build 不接受顶层 await）。
 */

/** 需要逐字输入的确认短语 */
export const RISK_ACK_PHRASE = 'I UNDERSTAND';

/** 设为 1 可跳过交互确认（仅供已明确接受风险、无法交互的部署使用） */
export const RISK_ACK_ENV = 'JUDGE_SANDBOX_ACK';

/** 当前评测后端是否为无隔离的 process 后端 */
export function needsRiskAcknowledgement(): boolean {
    return resolveSandboxMode() === 'process';
}

function envAcknowledged(): boolean {
    return String(process.env[RISK_ACK_ENV] || '').trim() === '1';
}

/** 说明为什么会落到 process 后端，方便运维定位 */
function describeReason(): string {
    const requested = String(config.JUDGE_SANDBOX || 'auto').toLowerCase();
    if (requested === 'process') {
        return 'JUDGE_SANDBOX=process（显式禁用了沙箱）';
    }
    return `JUDGE_SANDBOX=${requested}，但 ${config.V86_DIR} 下的沙箱资源不完整`;
}

function buildBanner(reason: string): string {
    const line = '='.repeat(72);
    return [
        '',
        line,
        '  [警告] 评测机未启用隔离沙箱（process 后端）',
        line,
        `  原因：${reason}`,
        '',
        '  用户提交的代码将直接在服务器上运行，与服务器进程权限相同，可以：',
        '    - 读写服务器上的任意文件（数据库、题目答案、配置、密钥）',
        '    - 发起任意网络请求',
        '    - 启动额外进程，或耗尽 CPU / 内存 / 磁盘',
        '',
        '  仅在本地开发或完全可信的内网中使用。生产环境请：',
        '    1) 运行 `bun run sandbox:setup` 生成沙箱资源，然后保持 JUDGE_SANDBOX=auto；',
        '    2) 或显式设置 JUDGE_SANDBOX=v86。',
        '',
        `  确认接受风险并继续，请输入：${RISK_ACK_PHRASE}`,
        `  （在无法交互的部署中可设置 ${RISK_ACK_ENV}=1 跳过确认）`,
        line,
        '',
    ].join('\n');
}

/** 同步从 stdin 读一行（读到 \n 或 EOF 为止），用于启动期的阻塞确认 */
function readLineSync(): string {
    const one = Buffer.alloc(1);
    const bytes: number[] = [];
    for (;;) {
        let n: number;
        try {
            n = fs.readSync(0, one, 0, 1, null);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // 非阻塞 stdin 暂时无数据：稍等后重试，避免忙等烧 CPU
            if (code === 'EAGAIN') {
                Bun.sleepSync(5);
                continue;
            }
            if (code === 'EOF') break;
            throw err;
        }
        if (n === 0) break;
        const byte = one[0];
        if (byte === 0x0a) break; // \n
        if (byte === 0x0d) continue; // \r，兼容 Windows 换行
        bytes.push(byte);
    }
    return Buffer.from(bytes).toString('utf-8');
}

/**
 * 启动前调用。返回 true 表示可以继续启动，false 表示应终止。
 * 后端为 v86 时直接返回 true，不产生任何输出。
 */
export function confirmUnisolatedJudge(): boolean {
    if (!needsRiskAcknowledgement()) return true;

    if (envAcknowledged()) {
        logger.warn(`[Judge] 评测后端为 process（无隔离），已通过 ${RISK_ACK_ENV}=1 跳过交互确认。`);
        return true;
    }

    // 非交互环境（CI、守护进程、stdin 被重定向）无法完成确认。
    // 这里直接拒绝启动，避免无隔离模式被静默带上线。
    if (!process.stdin.isTTY) {
        logger.error(
            '[Judge] 评测后端为 process（无隔离），但标准输入不是 TTY，无法完成风险确认，拒绝启动。\n' +
            `若确认接受风险，请设置 ${RISK_ACK_ENV}=1 后重启，或配置 v86 沙箱资源。`
        );
        return false;
    }

    process.stdout.write(buildBanner(describeReason()) + '\n');
    process.stdout.write('> ');

    const answer = readLineSync().trim();
    if (answer === RISK_ACK_PHRASE) {
        logger.warn('[Judge] 已确认：将以无隔离模式（process 后端）运行评测机。');
        return true;
    }

    logger.error(`[Judge] 输入不匹配（需要逐字输入 "${RISK_ACK_PHRASE}"），拒绝启动。`);
    return false;
}
