import { Database } from 'bun:sqlite';
import path from 'path';
import * as config from '../config';
import { externalizeParams, resolveRowBlob } from './blobs';
import { ensureDirSync } from './fs-utils';
import logger from './logger';

const dbName: string = process.env.DWOJ_DB_NAME || 'dwoj.db';
const dbPath: string = path.join(__dirname, '..', 'data', dbName);

ensureDirSync(path.dirname(dbPath));

const db: Database = new Database(dbPath, { create: true });

if (config.LOWMEM) {
    // 1 核 / 128 MB 降级配置：不用 WAL，page cache 256 KB，允许崩溃丢最后若干写
    db.run('PRAGMA journal_mode = DELETE;');
    db.run('PRAGMA synchronous = OFF;');
    db.run('PRAGMA cache_size = -256;');
    db.run('PRAGMA mmap_size = 0;');
    db.run('PRAGMA temp_store = FILE;');
    db.run('PRAGMA locking_mode = NORMAL;');
} else {
    db.run('PRAGMA journal_mode = WAL;');
}

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
    errorInfo?: string | null;
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

export const initDb = (): void => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'default',
        bio TEXT,
        tags TEXT,
        isBanned INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS problems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        authorId INTEGER,
        timeLimit INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        problemId INTEGER,
        userId INTEGER,
        username TEXT,
        language TEXT,
        code TEXT,
        status TEXT,
        time TEXT,
        caseResults TEXT,
        errorInfo TEXT
    )`);

    // 旧库迁移：补 errorInfo 列（判题写库依赖该列）
    const submissionCols = db.query("PRAGMA table_info(submissions)").all() as Array<{ name: string }>;
    if (!submissionCols.some(c => c.name === 'errorInfo')) {
        db.run("ALTER TABLE submissions ADD COLUMN errorInfo TEXT");
        logger.info('Migrated submissions table: added errorInfo column.');
    }

    db.run(`CREATE TABLE IF NOT EXISTS discussNodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        desc TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId INTEGER,
        title TEXT NOT NULL,
        content TEXT,
        author TEXT,
        time TEXT,
        replies TEXT
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problemId, id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_threads_node ON threads(nodeId, id)`);

    const userCount = db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number } | undefined;
    if (!userCount || userCount.count === 0) {
        db.run(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`,
            ['root', 'root', 'root', 'System Administrator', JSON.stringify(['Admin']), 0]);
        logger.info('Initial root user inserted.');
    }

    const nodeCount = db.query("SELECT COUNT(*) AS count FROM discussNodes").get() as { count: number } | undefined;
    if (!nodeCount || nodeCount.count === 0) {
        db.run(`INSERT INTO discussNodes (name, desc) VALUES (?, ?)`, ["闲聊灌水", "随便聊聊"]);
        logger.info('Initial discuss node inserted.');
    }

    logger.info('Database tables checked/created.');
};

// 内部可替换的实现（允许插件劫持）
// 读取后统一解引用 blob；写入前把超长字符串外置为 blob 引用
let _queryImpl = <T = any>(sql: string, params: any[] = []): T[] => {
    const rows = db.query(sql).all(...params) as any[];
    return rows.map(row => resolveRowBlob(row)) as T[];
};

let _queryOneImpl = <T = any>(sql: string, params: any[] = []): T | undefined => {
    const row = db.query(sql).get(...params) as any;
    if (row === null || row === undefined) return row as T | undefined;
    return resolveRowBlob(row) as T;
};

let _executeImpl = (sql: string, params: any[] = []): { lastInsertRowid: number; changes: number } => {
    const result = db.run(sql, externalizeParams(params));
    return {
        lastInsertRowid: Number(result.lastInsertRowid),
        changes: result.changes
    };
};

/** 事务：内部全部使用同步接口 */
export const transaction = <T>(fn: () => T): T => db.transaction(fn)();

export const query = <T = any>(sql: string, params: any[] = []): T[] => _queryImpl(sql, params);

export const queryOne = <T = any>(sql: string, params: any[] = []): T | undefined => _queryOneImpl(sql, params);

export const execute = (sql: string, params: any[] = []): { lastInsertRowid: number; changes: number } => _executeImpl(sql, params);

/** 插件专用的函数劫持 API — 替代直接修改 exports（readonly） */
export function wrapDbFunction(
    name: 'query' | 'queryOne' | 'execute',
    wrapper: (original: (...args: any[]) => any) => (...args: any[]) => any,
): void {
    switch (name) {
        case 'query': { const orig = _queryImpl; _queryImpl = wrapper(orig) as typeof _queryImpl; break; }
        case 'queryOne': { const orig = _queryOneImpl; _queryOneImpl = wrapper(orig) as typeof _queryOneImpl; break; }
        case 'execute': { const orig = _executeImpl; _executeImpl = wrapper(orig) as typeof _executeImpl; break; }
    }
}

export { db };