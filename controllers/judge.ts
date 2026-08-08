import fs from 'fs-extra';
import path from 'path';

import * as config from '../config';
import { JudgeSettings, execute, queryOne } from '../lib/database';
import logger from '../lib/logger';

let activeJudges = 0;
const pendingJudges: (() => void)[] = [];

async function acquireJudgeSlot(limit: number): Promise<() => void> {
    if (activeJudges >= limit) {
        await new Promise<void>(resolve => pendingJudges.push(resolve));
    }
    activeJudges++;
    return () => {
        activeJudges--;
        pendingJudges.shift()?.();
    };
}

interface JudgeResponse {
    status: string;
    output?: string;
    error?: string;
}

async function executeCpp(code: string, input: string, timeLimitMs: number, settings: JudgeSettings): Promise<JudgeResponse> {
    try {
        const response = await fetch(`${config.JUDGE_URL.replace(/\/$/, '')}/judge`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${settings.judgeToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ code, input, timeLimitMs }),
            signal: AbortSignal.timeout(Math.max(timeLimitMs + 5000, 10000)),
        });
        if (!response.ok) {
            return { status: 'System Error', error: `Judge returned HTTP ${response.status}` };
        }
        return await response.json() as JudgeResponse;
    } catch (err) {
        return { status: 'System Error', error: `Judge is unavailable: ${(err as Error).message}` };
    }
}

export async function runJudge(submissionId: number, pluginManager: any): Promise<void> {
    try {
        const sub = queryOne<any>('SELECT * FROM submissions WHERE id = ?', [submissionId]);
        if (!sub) return;

        if (sub.language !== 'cpp') {
            execute('UPDATE submissions SET status = ?, errorInfo = ? WHERE id = ?',
                ['System Error', 'Only C++ submissions are supported.', sub.id]);
            return;
        }

        const problem = queryOne<{ timeLimit: number | null }>('SELECT timeLimit FROM problems WHERE id = ?', [sub.problemId]);
        const settings = queryOne<JudgeSettings>('SELECT judgeToken, maxConcurrency FROM judge_settings WHERE id = 1');
        if (!problem || !settings?.judgeToken) {
            execute('UPDATE submissions SET status = ?, errorInfo = ? WHERE id = ?',
                ['System Error', 'Judge configuration is incomplete.', sub.id]);
            return;
        }

        const probPath = path.join(config.PROB_DIR, String(sub.problemId));
        if (!fs.existsSync(probPath)) {
            execute('UPDATE submissions SET status = ? WHERE id = ?', ['Data Error', sub.id]);
            return;
        }

        const inputs = fs.readdirSync(probPath).filter(file => file.endsWith('.in')).sort();
        if (inputs.length === 0) {
            execute('UPDATE submissions SET status = ? WHERE id = ?', ['Data Error', sub.id]);
            return;
        }

        pluginManager?.emit('beforeJudge', sub);
        const releaseSlot = await acquireJudgeSlot(settings.maxConcurrency);
        sub.status = 'Running';
        sub.caseResults = [];
        sub.errorInfo = null;

        try {
            let passed = 0;
            for (const inputFile of inputs) {
                const name = path.basename(inputFile, '.in');
                const outputPath = path.join(probPath, `${name}.out`);
                if (!fs.existsSync(outputPath)) continue;

                const result = await executeCpp(
                    sub.code,
                    fs.readFileSync(path.join(probPath, inputFile), 'utf8'),
                    problem.timeLimit || 1000,
                    settings,
                );
                if (result.status !== 'OK') {
                    sub.status = result.status;
                    sub.errorInfo = result.error || null;
                    sub.caseResults.push({ name, status: result.status });
                    break;
                }

                const expected = fs.readFileSync(outputPath, 'utf8').trim();
                if ((result.output || '').trim() === expected) {
                    passed++;
                    sub.caseResults.push({ name, status: 'AC' });
                } else {
                    sub.caseResults.push({ name, status: 'WA' });
                }
            }

            if (sub.status === 'Running') {
                sub.status = passed === inputs.length ? 'Accepted' : 'Wrong Answer';
            }
        } catch (err) {
            sub.status = 'System Error';
            sub.errorInfo = (err as Error).message;
        } finally {
            releaseSlot();
        }

        pluginManager?.emit('afterJudge', sub);
        execute('UPDATE submissions SET status = ?, errorInfo = ?, caseResults = ? WHERE id = ?',
            [sub.status, sub.errorInfo, JSON.stringify(sub.caseResults), sub.id]);
    } catch (err) {
        logger.error(`Error in runJudge for submission ${submissionId}`, err as Error);
    }
}
