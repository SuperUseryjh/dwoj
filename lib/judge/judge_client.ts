import * as config from '../../config';
import { createLogger } from '../logger';
import { call } from '../ipc/node';
import { resolveSandboxMode } from './backend';

const logger = createLogger('judge');

export { STATUS_TEXT } from './backend';
export type { JudgeErrorKind } from './backend';

/**
 * HTTP 进程侧的评测入口：不做任何评测，只把活儿交给 judge 进程。
 *
 * 单进程模式（DWOJ_SINGLE_PROCESS=1）下没有 IPC，直接调用本进程里的实现。
 */

/** 是否运行在独立的 http / judge 进程里 */
function isSplit(): boolean {
    const role = process.env.DWOJ_PROCESS_ROLE;
    return role === 'http' || role === 'judge';
}

function localJudge(): typeof import('../../controllers/judge') | null {
    if (isSplit()) return null;
    // 延迟 require：避免 http 进程里把评测后端/沙箱一起加载进来
    return require('../../controllers/judge');
}

/** 当前后端支持的语言（纯配置推导，不实例化后端） */
export function getSupportedLanguages(): string[] {
    if (!isSplit()) return localJudge()!.getSupportedLanguages();
    return resolveSandboxMode() === 'v86' ? config.V86_LANGUAGES : config.LANGUAGES;
}

/** 交给 judge 进程排队；失败只记日志（提交会保持 Pending，重启时自动重排） */
export function enqueueJudge(submissionId: number): void {
    if (!isSplit()) {
        localJudge()!.enqueueJudge(submissionId);
        return;
    }
    void call('judge', 'enqueue', { id: submissionId }, 10000).catch(err => {
        logger.error(`failed to hand submission ${submissionId} to judge process`, err as Error);
    });
}

/** 该提交是否正在评测/排队（rejudge 防重复用） */
export async function isJudging(submissionId: number): Promise<boolean> {
    if (!isSplit()) return localJudge()!.isJudging(submissionId);
    try {
        return await call<boolean>('judge', 'isJudging', { id: submissionId }, 5000);
    } catch (_) {
        return false;
    }
}

/** 评测进程是否存活（健康检查用） */
export async function judgeAlive(): Promise<boolean> {
    if (!isSplit()) return true;
    try {
        await call('judge', 'ping', {}, 3000);
        return true;
    } catch (_) {
        return false;
    }
}
