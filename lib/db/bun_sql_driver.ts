import { SQL } from 'bun';
import { createLogger } from '../logger';
import type { DriverKind, ExecuteResult, SqlDriver, SqlParams } from './driver';

const logger = createLogger('db');

/**
 * 基于 Bun 内置 SQL 客户端的驱动实现。
 *
 * Bun.SQL 用同一套 API 连接 sqlite / mysql / postgres，因此我们不需要引入
 * mysql2、pg 之类的第三方依赖。三种数据库的差异集中在两处：
 *   1. 占位符：sqlite / mysql 用 `?`，postgres 用 `$1..$n`；
 *   2. 自增主键与受影响行数的查询方式。
 * 这两点都由本文件按 dialect 分支处理，业务代码只写 `?`。
 */

interface Dialect {
    /** 把 `?` 占位符转换成目标数据库的写法 */
    translatePlaceholders(sql: string): string;
    /** 读取自增主键的 SQL（在事务中执行，紧跟在写操作之后） */
    lastInsertIdSql: string | null;
    /** 读取受影响行数的 SQL */
    changesSql: string | null;
    /** 建表时主键自增的写法 */
    autoIncrement: string;
}

/**
 * 把 SQL 里的 `?` 依次替换为 `$1`、`$2`……
 * 需要跳过字符串字面量和注释，避免误替换。
 */
export function questionToDollar(sql: string): string {
    let out = '';
    let index = 0;
    let i = 0;

    while (i < sql.length) {
        const ch = sql[i];

        // 单引号字符串：'' 是转义的单引号
        if (ch === "'") {
            out += ch;
            i++;
            while (i < sql.length) {
                out += sql[i];
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }

        // 双引号标识符
        if (ch === '"') {
            out += ch;
            i++;
            while (i < sql.length) {
                out += sql[i];
                if (sql[i] === '"') { i++; break; }
                i++;
            }
            continue;
        }

        // 行注释
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') { out += sql[i]; i++; }
            continue;
        }

        // 块注释
        if (ch === '/' && sql[i + 1] === '*') {
            out += '/*';
            i += 2;
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++; }
            if (i < sql.length) { out += '*/'; i += 2; }
            continue;
        }

        if (ch === '?') {
            index++;
            out += `$${index}`;
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

const DIALECTS: Record<DriverKind, Dialect> = {
    sqlite: {
        translatePlaceholders: sql => sql,
        lastInsertIdSql: 'SELECT last_insert_rowid() AS id',
        changesSql: 'SELECT changes() AS c',
        autoIncrement: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    },
    mysql: {
        translatePlaceholders: sql => sql,
        lastInsertIdSql: 'SELECT LAST_INSERT_ID() AS id',
        changesSql: 'SELECT ROW_COUNT() AS c',
        autoIncrement: 'INT AUTO_INCREMENT PRIMARY KEY',
    },
    postgres: {
        translatePlaceholders: questionToDollar,
        // postgres 没有「上次插入 id」的概念，lastval() 依赖当前会话的序列
        lastInsertIdSql: 'SELECT lastval() AS id',
        // 受影响行数需要 GET DIAGNOSTICS，普通查询拿不到，只能尽力而为
        changesSql: null,
        autoIncrement: 'SERIAL PRIMARY KEY',
    },
};

export function dialectFor(kind: DriverKind): Dialect {
    return DIALECTS[kind];
}

export interface BunSqlDriverOptions {
    kind: DriverKind;
    /** Bun.SQL 连接串，例如 mysql://user:pass@host:3306/db */
    url: string;
    /** 连接池上限，未指定则用 Bun 默认值 */
    maxConnections?: number;
}

export class BunSqlDriver implements SqlDriver {
    readonly kind: DriverKind;
    private readonly dialect: Dialect;
    private readonly sql: SQL;

    constructor(options: BunSqlDriverOptions) {
        this.kind = options.kind;
        this.dialect = dialectFor(options.kind);
        this.sql = new SQL({
            url: options.url,
            max: options.maxConnections,
            // 外部数据库首次连接失败时直接报错，避免带着坏配置启动
            connectionTimeout: 10000,
        } as any);
    }

    /** 供建表 / 迁移使用的底层客户端 */
    get client(): SQL {
        return this.sql;
    }

    async init(): Promise<void> {
        // 触发一次真实连接，让配置错误在启动阶段就暴露，而不是等第一个请求
        await this.sql.unsafe('SELECT 1');
        logger.info(`connected via Bun.SQL (${this.kind})`);
    }

    async query<T = any>(sql: string, params: SqlParams = []): Promise<T[]> {
        const text = this.dialect.translatePlaceholders(sql);
        const rows = await this.sql.unsafe(text, params as any[]);
        return rows as T[];
    }

    async execute(sql: string, params: SqlParams = []): Promise<ExecuteResult> {
        const text = this.dialect.translatePlaceholders(sql);

        // 自增 id 与受影响行数都是「连接级」的会话状态，
        // 必须在同一条连接上、紧跟写操作读取，所以整体放进事务。
        return await this.sql.begin(async (tx: any) => {
            await tx.unsafe(text, params as any[]);

            let lastInsertRowid = 0;
            if (this.dialect.lastInsertIdSql) {
                try {
                    const rows = await tx.unsafe(this.dialect.lastInsertIdSql);
                    lastInsertRowid = Number(rows?.[0]?.id ?? 0) || 0;
                } catch {
                    lastInsertRowid = 0;
                }
            }

            let changes = 0;
            if (this.dialect.changesSql) {
                try {
                    const rows = await tx.unsafe(this.dialect.changesSql);
                    changes = Number(rows?.[0]?.c ?? 0) || 0;
                } catch {
                    changes = 0;
                }
            } else {
                // postgres：没有通用办法拿到受影响行数，退回 0
                changes = 0;
            }

            return { lastInsertRowid, changes };
        });
    }

    async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
        return await this.sql.begin(async (tx: any) => {
            const wrapped: SqlDriver = {
                kind: this.kind,
                init: async () => {},
                query: async <R = any>(sql: string, params: SqlParams = []): Promise<R[]> => {
                    const rows = await tx.unsafe(this.dialect.translatePlaceholders(sql), params as any[]);
                    return rows as R[];
                },
                execute: async (sql: string, params: SqlParams = []): Promise<ExecuteResult> => {
                    await tx.unsafe(this.dialect.translatePlaceholders(sql), params as any[]);
                    let lastInsertRowid = 0;
                    if (this.dialect.lastInsertIdSql) {
                        try {
                            const rows = await tx.unsafe(this.dialect.lastInsertIdSql);
                            lastInsertRowid = Number(rows?.[0]?.id ?? 0) || 0;
                        } catch { /* 保持 0 */ }
                    }
                    let changes = 0;
                    if (this.dialect.changesSql) {
                        try {
                            const rows = await tx.unsafe(this.dialect.changesSql);
                            changes = Number(rows?.[0]?.c ?? 0) || 0;
                        } catch { /* 保持 0 */ }
                    }
                    return { lastInsertRowid, changes };
                },
                tableColumns: async (table: string): Promise<string[]> => {
                    try {
                        if (this.kind === 'sqlite') {
                            const rows = await tx.unsafe(`PRAGMA table_info(${table})`) as any[];
                            return (rows || []).map((r: any) => String(r.name));
                        }
                        const rows = await tx.unsafe(
                            `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ${this.kind === 'postgres' ? '$1' : '?'}`,
                            [table],
                        ) as any[];
                        return (rows || []).map((r: any) => String(r.name ?? r.column_name));
                    } catch {
                        return [];
                    }
                },
                transaction: async <R>(inner: (t: SqlDriver) => Promise<R>): Promise<R> => inner(wrapped),
                close: async () => {},
            };
            return await fn(wrapped);
        });
    }

    /**
     * 列出某张表的列名。
     *
     * 三种数据库查询列信息的方式完全不同：
     *  - sqlite:   PRAGMA table_info(t)
     *  - mysql:    information_schema.columns
     *  - postgres: information_schema.columns
     * 表不存在时返回空数组（调用方据此判断是否需要建表）。
     */
    async tableColumns(table: string): Promise<string[]> {
        try {
            if (this.kind === 'sqlite') {
                const rows = await this.sql.unsafe(`PRAGMA table_info(${table})`) as any[];
                return (rows || []).map(r => String(r.name));
            }
            const sql = `SELECT column_name AS name FROM information_schema.columns
                         WHERE table_name = ${this.kind === 'postgres' ? '$1' : '?'}`;
            const rows = await this.sql.unsafe(sql, [table]) as any[];
            return (rows || []).map(r => String(r.name ?? r.column_name));
        } catch {
            return [];
        }
    }

    async close(): Promise<void> {
        await this.sql.close();
    }
}
