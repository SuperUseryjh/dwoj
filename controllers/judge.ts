import fs from 'fs-extra';
import path from 'path';
import * as config from '../config';
import { query, queryOne, execute } from '../lib/database';
import { createLogger } from '../lib/logger';
import {
    JudgeError,
    JudgeErrorKind,
    STATUS_TEXT,
    UNFINISHED_STATUS,
    getBackend,
    resolveSandboxMode,
} from '../lib/judge/backend';
import { compareOutput } from '../lib/judge/compare';
import { clampTimeLimit, loadCases } from '../lib/judge/testcase';

const logger = createLogger('judge');

export { JudgeError, STATUS_TEXT } from '../lib/judge/backend';
export type { JudgeErrorKind } from '../lib/judge/backend';
export { compareOutput, normalizeOutput } from '../lib/judge/compare';
export { loadCases, compareCaseName, clampTimeLimit } from '../lib/judge/testcase';
export type { TestCase } from '../lib/judge/testcase';

// ============================================================
// 评测队列
// ============================================================

const pending: number[] = [];
const activeIds = new Set<number>();
let pluginManagerRef: any = null;

/** 提交是否正在评测 / 排队中 */
export function isJudging(submissionId: number): boolean {
    return activeIds.has(submissionId) || pending.includes(submissionId);
}

/** 当前执行后端支持的语言（前端用它渲染语言下拉框） */
export function getSupportedLanguages(): string[] {
    return getBackend().languages;
}

/**
 * 初始化评测机：绑定插件管理器、初始化执行后端，
 * 并把上次进程退出时残留的 Pending / Running 提交重新排队。
 */
export async function initJudge(pluginManager: any): Promise<void> {
    pluginManagerRef = pluginManager;
    cleanupStaleTmpDirs();

    const mode = resolveSandboxMode();
    logger.info(`backend=${getBackend().name} (JUDGE_SANDBOX=${config.JUDGE_SANDBOX})`);

    // 沙箱冷启动很慢（要解压 initramfs），提前在后台准备
    void getBackend().init().catch(err => {
        logger.error(`failed to initialize ${mode} backend`, err as Error);
    });

    try {
        const stale = await query<{ id: number }>(
            "SELECT id FROM submissions WHERE status IN ('Pending', 'Queued', 'Running') ORDER BY id ASC",
            []
        );
        if (stale.length > 0) {
            await execute("UPDATE submissions SET status = 'Pending' WHERE status IN ('Pending', 'Queued', 'Running')", []);
            logger.info(`Re-queued ${stale.length} unfinished submission(s).`);
            stale.forEach(row => enqueueJudge(row.id));
        }
    } catch (err) {
        logger.error('Failed to re-queue unfinished submissions', err as Error);
    }
}

/** 把一次提交放进评测队列（重复入队会被忽略） */
export function enqueueJudge(submissionId: number): void {
    if (isJudging(submissionId)) return;
    pending.push(submissionId);
    pump();
}

function pump(): void {
    while (activeIds.size < config.JUDGE_CONCURRENCY && pending.length > 0) {
        const id = pending.shift()!;
        activeIds.add(id);
        runJudge(id, pluginManagerRef)
            .catch(err => logger.error(`submission ${id} crashed`, err as Error))
            .finally(() => {
                activeIds.delete(id);
                pump();
            });
    }
}

// ============================================================
// 主流程
// ============================================================

export async function runJudge(submissionId: number, pluginManager: any): Promise<void> {
    const sub = await queryOne<any>("SELECT * FROM submissions WHERE id = ?", [submissionId]);
    if (!sub) return;
    // 防止重复评测已经出结果的提交
    if (sub.status && !UNFINISHED_STATUS.includes(sub.status)) return;

    sub.caseResults = [];
    sub.errorInfo = null;

    const problem = await queryOne<{ id: number; timeLimit: number | null }>(
        "SELECT id, timeLimit FROM problems WHERE id = ?", [sub.problemId]
    );
    if (!problem) {
        sub.status = STATUS_TEXT.SE;
        sub.errorInfo = '题目不存在（可能已被删除）';
        await persist(sub);
        return;
    }

    const timeLimitMs = clampTimeLimit(problem.timeLimit);
    const backend = getBackend();

    sub.status = 'Running';
    await persist(sub);

    try {
        pluginManager?.emit?.('beforeJudge', sub);

        const lang = String(sub.language || '');
        if (!backend.languages.includes(lang)) {
            throw new JudgeError('CE', `当前评测后端不支持该语言：${lang || '(空)'}（支持：${backend.languages.join(', ')}）`);
        }

        const probPath = path.join(config.PROB_DIR, String(problem.id));
        if (!fs.existsSync(probPath)) {
            throw new JudgeError('SE', '测试数据不存在，请联系管理员');
        }

        const cases = loadCases(probPath);
        let verdict: string | null = null;

        for (const testCase of cases) {
            const input = fs.readFileSync(testCase.inPath, 'utf-8');
            const expected = fs.readFileSync(testCase.outPath, 'utf-8');

            const outcome = await backend.execute({
                language: lang,
                code: String(sub.code ?? ''),
                input,
                timeLimitMs,
                maxOutputBytes: config.MAX_OUTPUT_BYTES,
                submissionId: sub.id,
            });

            if (outcome.status === 'OK') {
                const passed = compareOutput(outcome.stdout, expected);
                sub.caseResults.push({
                    name: testCase.name,
                    status: passed ? 'AC' : 'WA',
                    time: Math.round(outcome.timeMs ?? 0),
                });
                if (!passed) verdict = verdict ?? 'Wrong Answer';
            } else {
                const kind: JudgeErrorKind = outcome.status;
                sub.caseResults.push({ name: testCase.name, status: kind });
                sub.errorInfo = `测试点 ${testCase.name}: ${sanitizeMessage(outcome.message)}`;
                verdict = STATUS_TEXT[kind];
            }

            // 每跑完一个测试点就落库，进程中途崩溃也不会丢结果
            await persist(sub);

            // WA 继续跑完，方便用户看到哪些点错了；限流/运行错误直接终止
            if (verdict && verdict !== 'Wrong Answer') break;
        }

        sub.status = verdict ?? 'Accepted';

        pluginManager?.emit?.('afterJudge', sub);
        await persist(sub);

        logger.info(`submission ${sub.id} -> ${sub.status} (${sub.caseResults.length} case(s))`);
    } catch (err) {
        const kind = err instanceof JudgeError ? err.kind : 'SE';
        sub.status = STATUS_TEXT[kind];
        sub.errorInfo = sanitizeMessage((err as Error)?.message || String(err));
        await persist(sub);
        logger.error(`submission ${sub.id} -> ${sub.status}: ${sub.errorInfo}`);
    }
}

async function persist(sub: any): Promise<void> {
    await execute(
        "UPDATE submissions SET status = ?, errorInfo = ?, caseResults = ? WHERE id = ?",
        [sub.status, sub.errorInfo || null, JSON.stringify(sub.caseResults || []), sub.id]
    );
}

// ============================================================
// 工具
// ============================================================

const APP_ROOT = path.resolve(__dirname, '..');

/** 去掉错误信息里可能泄露服务器绝对路径的部分 */
function sanitizeMessage(message: string): string {
    let text = String(message);

    // 单次评测的临时目录 data/judge_tmp/<uuid>/ → 直接抹掉，只留下 main.py 这类文件名
    const tmpDirPattern = new RegExp(
        escapeRegExp(config.JUDGE_DIR) + '[\\\\/][^\\\\/\\s"\']+[\\\\/]?',
        'g'
    );
    text = text.replace(tmpDirPattern, '');

    for (const dir of [config.PROB_DIR, config.DATA_DIR, config.UPLOAD_DIR, APP_ROOT]) {
        text = text.split(dir + path.sep).join('');
        text = text.split(dir).join('<path>');
    }
    return text.split('\n').slice(0, 20).join('\n').trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 清理上次进程崩溃残留的评测临时目录 */
function cleanupStaleTmpDirs(): void {
    try {
        fs.ensureDirSync(config.JUDGE_DIR);
        const entries = fs.readdirSync(config.JUDGE_DIR);
        const now = Date.now();
        for (const entry of entries) {
            const full = path.join(config.JUDGE_DIR, entry);
            try {
                const stat = fs.statSync(full);
                if (now - stat.mtimeMs > 60 * 60 * 1000) fs.removeSync(full);
            } catch (_) { /* ignore */ }
        }
    } catch (err) {
        logger.error('Failed to clean stale judge directories', err as Error);
    }
}
