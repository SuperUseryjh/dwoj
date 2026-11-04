import { startChild, reportReady } from '../ipc/node';
import { createLogger } from '../logger';
import { closeDb, driver, initDb } from '../database';
import type { SqlDriver, SqlParams } from './driver';

const logger = createLogger('db');

/**
 * 数据库进程：整个系统里唯一持有数据库连接的地方。
 *
 * 启动时完成建表 / 迁移 / 默认数据，然后响应 http / judge 进程发来的
 * query / execute / 事务请求。SQL 文本不做任何解析，原样执行。
 */

interface TxContext {
    tx: SqlDriver;
    finish: (err?: Error) => void;
}

const transactions = new Map<string, TxContext>();
let txSeq = 0;

function requireTx(txId: string): TxContext {
    const ctx = transactions.get(txId);
    if (!ctx) throw new Error(`事务不存在或已结束：${txId}`);
    return ctx;
}

async function serve(method: string, params: any): Promise<any> {
    switch (method) {
        case 'ping':
            return { kind: driver.kind };

        case 'query':
            return await driver.query(params.sql, (params.params || []) as SqlParams);

        case 'execute':
            return await driver.execute(params.sql, (params.params || []) as SqlParams);

        case 'columns':
            return await driver.tableColumns(params.table);

        case 'tx.begin': {
            const txId = `tx${++txSeq}`;
            let ready!: () => void;
            const started = new Promise<void>(resolve => { ready = resolve; });
            let finish!: (err?: Error) => void;
            const done = new Promise<void>((resolve, reject) => {
                finish = (err?: Error) => (err ? reject(err) : resolve());
            });

            void driver.transaction(async tx => {
                transactions.set(txId, { tx, finish });
                ready();
                try {
                    await done;
                } finally {
                    transactions.delete(txId);
                }
            }).catch(err => {
                logger.error(`transaction ${txId} failed`, err as Error);
                transactions.delete(txId);
            });

            await started;
            logger.info(`transaction ${txId} started`);
            return { txId };
        }

        case 'tx.call': {
            const { tx } = requireTx(params.txId);
            if (params.method === 'query') return await tx.query(params.sql, (params.params || []) as SqlParams);
            if (params.method === 'execute') return await tx.execute(params.sql, (params.params || []) as SqlParams);
            if (params.method === 'columns') return await tx.tableColumns(params.table);
            throw new Error(`事务内不支持的方法：${params.method}`);
        }

        case 'tx.commit': {
            const ctx = requireTx(params.txId);
            transactions.delete(params.txId);
            ctx.finish();
            return true;
        }

        case 'tx.rollback': {
            const ctx = transactions.get(params.txId);
            if (!ctx) return true;
            transactions.delete(params.txId);
            ctx.finish(new Error('rollback'));
            return true;
        }

        case 'close':
            await closeDb();
            return true;

        default:
            throw new Error(`db 进程不支持的方法：${method}`);
    }
}

async function main(): Promise<void> {
    // 先接管通道，broker 才能在初始化期间做健康检查
    startChild({
        handler: serve,
        onShutdown: async () => {
            await closeDb().catch(() => { /* ignore */ });
        },
    });

    await initDb();

    reportReady({ kind: driver.kind, pid: process.pid });
    logger.info(`service ready (${driver.kind})`);
}

main().catch(err => {
    logger.error('service failed to start', err as Error);
    process.exit(1);
});
