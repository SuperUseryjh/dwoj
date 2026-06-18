import logger from '../logger';
import { wrapDbFunction } from '../database';

interface FuncStats {
    count: number;
    totalTime: number;
    slowQueries: { sql: string; time: number; timestamp: string }[];
}

const stats: Record<string, FuncStats> = {
    query: { count: 0, totalTime: 0, slowQueries: [] },
    queryOne: { count: 0, totalTime: 0, slowQueries: [] },
    execute: { count: 0, totalTime: 0, slowQueries: [] },
};

const SLOW_THRESHOLD_MS = 100;

let wrapped = false;

function wrapDatabase(): void {
    if (wrapped) return;
    const funcs = ['query', 'queryOne', 'execute'] as const;
    for (const name of funcs) {
        wrapDbFunction(name, (original) => (...args: any[]): any => {
            const start = performance.now();
            try {
                const result = original(...args);
                const elapsed = performance.now() - start;
                const s = stats[name];
                s.count++;
                s.totalTime += elapsed;
                if (elapsed > SLOW_THRESHOLD_MS) {
                    s.slowQueries.push({
                        sql: String(args[0]),
                        time: Math.round(elapsed * 100) / 100,
                        timestamp: new Date().toISOString(),
                    });
                    if (s.slowQueries.length > 50) s.slowQueries.shift();
                    logger.warn(`[DB-Monitor] Slow ${name}: ${String(args[0])} (${Math.round(elapsed)}ms)`);
                }
                return result;
            } catch (err) {
                const elapsed = performance.now() - start;
                stats[name].count++;
                stats[name].totalTime += elapsed;
                throw err;
            }
        });
    }
    wrapped = true;
    logger.info('[DB-Monitor] Database functions wrapped for performance monitoring');
}

function resetStats(): void {
    for (const key of Object.keys(stats)) {
        stats[key] = { count: 0, totalTime: 0, slowQueries: [] };
    }
}

export const manifest = {
    name: 'db-monitor',
    description: 'Database read/write performance monitor',
    version: '1.0.0',
    permissions: ['read_db'],
    builtin: true,
};

export function onLoad(): void {
    wrapDatabase();
}

export function onRoute(_oj: any, _db: any, _getPluginExports: any, app: any): void {
    app.get('/admin/db-monitor', (_req: any, res: any) => {
        const summary: Record<string, any> = {};
        for (const [key, s] of Object.entries(stats)) {
            summary[key] = {
                count: s.count,
                totalTime: Math.round(s.totalTime * 100) / 100,
                avgTime: s.count > 0 ? Math.round((s.totalTime / s.count) * 100) / 100 : 0,
                slowQueries: s.slowQueries.slice(-10),
            };
        }
        res.json(summary);
    });
}

export function onDisable(): void {
    resetStats();
    logger.info('[DB-Monitor] Performance monitoring stopped');
}

export { stats };