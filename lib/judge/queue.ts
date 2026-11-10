import * as config from '../../config';
import { query } from '../database';
import logger from '../logger';
import { runJudge } from './runner';

/** 单飞 FIFO 队列：并发恒为 1，长度上限 JUDGE_QUEUE_LIMIT */
class JudgeQueue {
    private queue: number[] = [];
    private running = false;
    private pluginManager: any = null;

    setPluginManager(pluginManager: any): void {
        this.pluginManager = pluginManager;
    }

    /** 当前积压数量（不含正在执行的任务） */
    get pending(): number {
        return this.queue.length;
    }

    get isFull(): boolean {
        return this.queue.length >= config.JUDGE_QUEUE_LIMIT;
    }

    /** 入队；队列已满返回 false（由调用方友好拒绝） */
    push(submissionId: number): boolean {
        if (this.isFull) return false;
        this.queue.push(submissionId);
        void this.drain();
        return true;
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length > 0) {
                const id = this.queue.shift()!;
                try {
                    await runJudge(id, this.pluginManager);
                } catch (err) {
                    logger.error(`[JudgeQueue] Submission ${id} failed`, err as Error);
                }
            }
        } finally {
            this.running = false;
        }
    }

    /** 启动时恢复：把 Pending / 遗留 Running 重新入队 */
    recover(): void {
        try {
            const rows = query<{ id: number }>(
                "SELECT id FROM submissions WHERE status IN ('Pending', 'Running') ORDER BY id ASC");
            for (const row of rows) {
                if (!this.push(row.id)) {
                    logger.warn(`[JudgeQueue] Queue full, submission ${row.id} left for manual retry`);
                    break;
                }
            }
            if (rows.length > 0) logger.info(`[JudgeQueue] Recovered ${rows.length} unfinished submission(s)`);
        } catch (err) {
            logger.error('[JudgeQueue] Recovery failed', err as Error);
        }
    }
}

export const judgeQueue = new JudgeQueue();
