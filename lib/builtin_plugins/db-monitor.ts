import { createLogger } from '../logger';
import { wrapDbFunction } from '../database';
import type { PluginDefinition } from '../plugin/types';

const logger = createLogger('dbmon');

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
        wrapDbFunction(name, (original) => async (...args: any[]): Promise<any> => {
            const start = performance.now();
            try {
                // 数据库访问已全部异步化，必须 await 才能拿到真实耗时
                const result = await original(...args);
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
                    logger.warn(`Slow ${name}: ${String(args[0])} (${Math.round(elapsed)}ms)`);
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
    logger.info('Database functions wrapped for performance monitoring');
}

const dbMonitor: PluginDefinition = {
    name: 'db-monitor',
    description: 'Database read/write performance monitor',
    version: '1.0.0',
    permissions: [],
    system: true,

    setup() {
        wrapDatabase();
    },

    routes(router) {
        router.get('/admin/db-monitor', (_req, res) => {
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
    },
};

export default dbMonitor;
