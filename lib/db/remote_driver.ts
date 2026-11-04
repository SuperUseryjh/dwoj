import type { DriverKind, ExecuteResult, SqlDriver, SqlParams } from './driver';
import { call } from '../ipc/node';

/**
 * 远程数据库驱动：SQL 语句本身在 db 进程里执行，本进程只做收发。
 *
 * 有了它，http / judge 进程里的 `query/queryOne/execute/transaction`
 * 用法完全不变（`lib/database.ts` 会自动选中这个驱动）。
 */
export class RemoteSqlDriver implements SqlDriver {
    readonly kind: DriverKind;

    constructor() {
        const dialect = String(process.env.DWOJ_DB_DIALECT || 'sqlite').toLowerCase();
        this.kind = (dialect === 'mysql' || dialect === 'postgres' ? dialect : 'sqlite') as DriverKind;
    }

    /** db 进程已经初始化完毕，这里只需要确认通道可用 */
    async init(): Promise<void> {
        await call('db', 'ping', {}, 15000);
    }

    async query<T = any>(sql: string, params: SqlParams = []): Promise<T[]> {
        return await call<T[]>('db', 'query', { sql, params }, 60000);
    }

    async execute(sql: string, params: SqlParams = []): Promise<ExecuteResult> {
        return await call<ExecuteResult>('db', 'execute', { sql, params }, 60000);
    }

    async tableColumns(table: string): Promise<string[]> {
        return await call<string[]>('db', 'columns', { table }, 15000);
    }

    async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
        const { txId } = await call<{ txId: string }>('db', 'tx.begin', {}, 15000);

        const tx: SqlDriver = {
            kind: this.kind,
            init: async () => { /* 事务里不需要 */ },
            query: <R = any>(sql: string, params: SqlParams = []) =>
                call<R[]>('db', 'tx.call', { txId, method: 'query', sql, params }, 60000),
            execute: (sql: string, params: SqlParams = []) =>
                call<ExecuteResult>('db', 'tx.call', { txId, method: 'execute', sql, params }, 60000),
            tableColumns: (table: string) =>
                call<string[]>('db', 'tx.call', { txId, method: 'columns', table }, 15000),
            transaction: async () => {
                throw new Error('不支持嵌套事务');
            },
            close: async () => { /* 由外层提交/回滚 */ },
        };

        try {
            const result = await fn(tx);
            await call('db', 'tx.commit', { txId }, 30000);
            return result;
        } catch (err) {
            await call('db', 'tx.rollback', { txId }, 10000).catch(() => { /* ignore */ });
            throw err;
        }
    }

    async close(): Promise<void> {
        await call('db', 'close', {}, 5000).catch(() => { /* 关机时忽略 */ });
    }
}
