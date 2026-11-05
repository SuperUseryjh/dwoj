import fs from 'fs-extra';
import path from 'path';
import * as config from '../config';
import { createLogger } from './logger';
import type { DriverKind, ExecuteResult, SqlDriver, SqlParams } from './db/driver';
import { BunSqlDriver } from './db/bun_sql_driver';
import { RemoteSqlDriver } from './db/remote_driver';

const logger = createLogger('db');

// ============================================================
// 数据类型（与表结构对应，供各路由 / 控制器复用）
// ============================================================

export interface User {
    id: number;
    username: string;
    password: string;
    role: string;
    bio: string | null;
    tags: string | null;
    isBanned: number;
}

export interface Problem {
    id: number;
    title: string;
    description: string | null;
    authorId: number | null;
    timeLimit: number | null;
}

export interface Submission {
    id: number;
    problemId: number | null;
    userId: number | null;
    username: string | null;
    language: string | null;
    code: string | null;
    status: string | null;
    time: string | null;
    caseResults: string | null;
    /** 公开错误信息（所有能查看该提交的人可见） */
    errorInfo?: string | null;
    /** 管理员诊断信息（用户 stderr 等，仅 super_user / root 可见） */
    errorDetail?: string | null;
}

export interface DiscussNode {
    id: number;
    name: string;
    desc: string | null;
}

export interface Thread {
    id: number;
    nodeId: number | null;
    title: string;
    content: string | null;
    author: string | null;
    time: string | null;
    replies: string | null;
}

export interface Role {
    id: number;
    name: string;
}

export interface PluginConfig {
    filename: string;
    enabled: number;
    token: string;
    permissions: string | null;
}

// ============================================================
// 驱动实例
// ============================================================

/** 解析要使用的数据库类型；非法值直接报错，避免带着错误配置启动 */
export function resolveDriverKind(): DriverKind {
    const raw = String(config.DB_DRIVER || 'sqlite').toLowerCase();
    if (raw === 'sqlite' || raw === 'mysql' || raw === 'postgres') return raw;
    throw new Error(`不支持的 DB_DRIVER：${raw}（可选 sqlite / mysql / postgres）`);
}

/**
 * SQLite 的连接串。
 * 沿用 DWOJ_DB_NAME（测试通过它指定独立的库文件），并保证目录存在。
 */
function sqliteUrl(): string {
    const dbName = process.env.DWOJ_DB_NAME || 'dwoj.db';
    const dbPath = path.resolve(__dirname, '..', 'data', dbName);
    fs.ensureDirSync(path.dirname(dbPath));
    return `sqlite://${dbPath}`;
}

/**
 * 是否运行在 http / judge 进程里。
 * 这两种进程不直接连数据库，而是把 SQL 转发给 db 进程执行。
 */
function usesRemoteDriver(): boolean {
    const role = process.env.DWOJ_PROCESS_ROLE;
    return role === 'http' || role === 'judge';
}

function createDriver(): SqlDriver {
    if (usesRemoteDriver()) return new RemoteSqlDriver();

    const kind = resolveDriverKind();
    if (kind === 'sqlite') {
        return new BunSqlDriver({ kind, url: sqliteUrl() });
    }
    if (!config.DB_URL) {
        throw new Error(`DB_DRIVER=${kind} 时必须通过 DB_URL 提供连接串`);
    }
    return new BunSqlDriver({ kind, url: config.DB_URL, maxConnections: config.DB_POOL_MAX });
}

const driver: SqlDriver = createDriver();

/** 当前使用的数据库类型 */
export function dialect(): DriverKind {
    return driver.kind;
}

/**
 * 把 `INSERT ... VALUES (...)` 改写成跨数据库的 upsert。
 *
 * - sqlite / postgres: `ON CONFLICT(cols) DO UPDATE SET ...`
 * - mysql:             `ON DUPLICATE KEY UPDATE ...`（依赖唯一索引，不能指定列）
 *
 * 业务代码只写普通的 INSERT，由这里负责方言差异。
 */
export function upsertSql(
    table: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
): string {
    const placeholders = columns.map(() => '?').join(', ');
    const insert = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

    if (driver.kind === 'mysql') {
        const updates = updateColumns.map(c => `${c} = VALUES(${c})`).join(', ');
        return `${insert} ON DUPLICATE KEY UPDATE ${updates}`;
    }

    const updates = updateColumns.map(c => `${c} = excluded.${c}`).join(', ');
    return `${insert} ON CONFLICT(${conflictColumns.join(', ')}) DO UPDATE SET ${updates}`;
}

// ============================================================
// 建表 / 迁移
// ============================================================

/** 自增主键的方言写法 */
function autoPk(): string {
    switch (driver.kind) {
        case 'mysql': return 'INT AUTO_INCREMENT PRIMARY KEY';
        case 'postgres': return 'SERIAL PRIMARY KEY';
        default: return 'INTEGER PRIMARY KEY AUTOINCREMENT';
    }
}

/**
 * 初始化数据库：建表、补列、写入默认数据。
 * 服务启动时 await 一次；重复执行是安全的（幂等）。
 */
export async function initDb(): Promise<void> {
    // 远程驱动模式下建表/迁移由 db 进程负责，这里不需要重复执行
    if (driver instanceof RemoteSqlDriver) return;

    await driver.init();

    const pk = autoPk();

    await driver.execute(`CREATE TABLE IF NOT EXISTS users (
        id ${pk},
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'default',
        bio TEXT,
        tags TEXT,
        isBanned INTEGER DEFAULT 0
    )`);

    await driver.execute(`CREATE TABLE IF NOT EXISTS problems (
        id ${pk},
        title TEXT NOT NULL,
        description TEXT,
        authorId INTEGER,
        timeLimit INTEGER
    )`);

    await driver.execute(`CREATE TABLE IF NOT EXISTS submissions (
        id ${pk},
        problemId INTEGER,
        userId INTEGER,
        username TEXT,
        language TEXT,
        code TEXT,
        status TEXT,
        time TEXT,
        caseResults TEXT
    )`);

    await driver.execute(`CREATE TABLE IF NOT EXISTS discussNodes (
        id ${pk},
        name TEXT NOT NULL,
        desc TEXT
    )`);

    await driver.execute(`CREATE TABLE IF NOT EXISTS threads (
        id ${pk},
        nodeId INTEGER,
        title TEXT NOT NULL,
        content TEXT,
        author TEXT,
        time TEXT,
        replies TEXT
    )`);

    await driver.execute(`CREATE TABLE IF NOT EXISTS roles (
        id ${pk},
        name TEXT UNIQUE NOT NULL
    )`);

    await driver.execute(`CREATE TABLE IF NOT EXISTS plugin_configs (
        filename TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        token TEXT UNIQUE NOT NULL,
        permissions TEXT
    )`);

    // ---- 幂等迁移：旧库补上 submissions.errorInfo ----
    const submissionColumns = await driver.tableColumns('submissions');
    if (!submissionColumns.includes('errorInfo')) {
        await driver.execute('ALTER TABLE submissions ADD COLUMN errorInfo TEXT');
        logger.info('Migration applied: submissions.errorInfo column added.');
    }
    // ---- 幂等迁移：管理员诊断字段（issue #5：用户 stderr 不再公开回显） ----
    if (!submissionColumns.includes('errorDetail')) {
        await driver.execute('ALTER TABLE submissions ADD COLUMN errorDetail TEXT');
        logger.info('Migration applied: submissions.errorDetail column added.');
    }

    // 索引：方言语法一致，直接建
    await driver.execute('CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status)').catch(() => {
        // MySQL 不支持 CREATE INDEX IF NOT EXISTS，忽略重复创建错误即可
    });
    await driver.execute('CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problemId)').catch(() => {});

    // ---- 默认数据 ----
    const userCount = await driver.query<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    if (!userCount[0] || Number(userCount[0].count) === 0) {
        await driver.execute(
            'INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)',
            ['root', 'root', 'root', 'System Administrator', JSON.stringify(['Admin']), 0],
        );
        logger.info('Initial root user inserted.');
    }

    const nodeCount = await driver.query<{ count: number }>('SELECT COUNT(*) AS count FROM discussNodes');
    if (!nodeCount[0] || Number(nodeCount[0].count) === 0) {
        await driver.execute('INSERT INTO discussNodes (name, desc) VALUES (?, ?)', ['闲聊灌水', '随便聊聊']);
        logger.info('Initial discuss node inserted.');
    }

    const roleCount = await driver.query<{ count: number }>('SELECT COUNT(*) AS count FROM roles');
    if (!roleCount[0] || Number(roleCount[0].count) === 0) {
        for (const name of ['default', 'super_user', 'root']) {
            await driver.execute('INSERT INTO roles (name) VALUES (?)', [name]);
        }
        logger.info('Initial roles inserted.');
    }

    logger.info(`Database tables checked/created (${driver.kind}).`);
}

// ============================================================
// 对外查询 API（全部异步）
// ============================================================

type QueryFn = <T = any>(sql: string, params?: SqlParams) => Promise<T[]>;
type QueryOneFn = <T = any>(sql: string, params?: SqlParams) => Promise<T | undefined>;
type ExecuteFn = (sql: string, params?: SqlParams) => Promise<ExecuteResult>;

/** 内部实现，插件可通过 wrapDbFunction 劫持 */
let _queryImpl: QueryFn = async <T = any>(sql: string, params: SqlParams = []): Promise<T[]> => {
    return await driver.query<T>(sql, params);
};

let _queryOneImpl: QueryOneFn = async <T = any>(sql: string, params: SqlParams = []): Promise<T | undefined> => {
    const rows = await driver.query<T>(sql, params);
    return rows[0];
};

let _executeImpl: ExecuteFn = async (sql: string, params: SqlParams = []): Promise<ExecuteResult> => {
    return await driver.execute(sql, params);
};

/** 查询多行 */
export const query: QueryFn = (sql, params = []) => _queryImpl(sql, params);

/** 查询单行（没有结果时返回 undefined） */
export const queryOne: QueryOneFn = (sql, params = []) => _queryOneImpl(sql, params);

/** 执行写操作，返回自增主键与受影响行数 */
export const execute: ExecuteFn = (sql, params = []) => _executeImpl(sql, params);

/** 在事务中执行一组操作；回调抛错时自动回滚 */
export async function transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    return await driver.transaction(fn);
}

/**
 * 插件专用的函数劫持 API。
 *
 * 包装函数会拿到「原始实现」和调用参数，需要自行 await 并返回结果。
 * 注意：由于所有查询都是异步的，包装器必须是 async 函数。
 */
export function wrapDbFunction(
    name: 'query' | 'queryOne' | 'execute',
    wrapper: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>,
): void {
    switch (name) {
        case 'query': { _queryImpl = wrapper(_queryImpl) as QueryFn; break; }
        case 'queryOne': { _queryOneImpl = wrapper(_queryOneImpl) as QueryOneFn; break; }
        case 'execute': { _executeImpl = wrapper(_executeImpl) as ExecuteFn; break; }
    }
}

/**
 * 聚合对象，保持旧的 `require('./lib/database').db` 用法可用。
 * 插件系统会把它包进权限代理后交给插件，因此这里只暴露三个查询函数。
 */
export const db = { query, queryOne, execute };

/** 关闭数据库连接（测试 / 优雅退出时使用） */
export async function closeDb(): Promise<void> {
    await driver.close();
}

export { driver };
