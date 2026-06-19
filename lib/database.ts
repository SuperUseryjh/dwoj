import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs-extra';
import { createLogger } from './logger';
const logger = createLogger('Database');

const dbName: string = process.env.DWOJ_DB_NAME || 'dwoj.db';
const dbPath: string = path.join(__dirname, '..', 'data', dbName);

fs.ensureDirSync(path.dirname(dbPath));

const db: Database = new Database(dbPath, { create: true });

db.run('PRAGMA journal_mode = WAL;');

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
        caseResults TEXT
    )`);

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

    db.run(`CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS plugin_configs (
        filename TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        token TEXT UNIQUE NOT NULL,
        permissions TEXT
    )`);

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

    const roleCount = db.query("SELECT COUNT(*) AS count FROM roles").get() as { count: number } | undefined;
    if (!roleCount || roleCount.count === 0) {
        db.run(`INSERT INTO roles (name) VALUES ('default'), ('super_user'), ('root')`);
        logger.info('Initial roles inserted.');
    }

    logger.info('Database tables checked/created.');
};

// 内部可替换的实现（允许插件劫持）
let _queryImpl = <T = any>(sql: string, params: any[] = []): T[] => {
    return db.query(sql).all(...params) as T[];
};

let _queryOneImpl = <T = any>(sql: string, params: any[] = []): T | undefined => {
    return db.query(sql).get(...params) as T | undefined;
};

let _executeImpl = (sql: string, params: any[] = []): { lastInsertRowid: number; changes: number } => {
    const result = db.run(sql, params);
    return {
        lastInsertRowid: Number(result.lastInsertRowid),
        changes: result.changes
    };
};

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