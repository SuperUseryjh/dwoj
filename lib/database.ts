import { fork, ChildProcess } from 'child_process';
import path from 'path';
import logger from './logger';
import { DatabaseInstance } from '../types';

const USE_SEPARATE_DB_PROCESS = process.env.USE_SEPARATE_DB_PROCESS !== 'false';

let dbProcess: ChildProcess | null = null;
let messageId = 0;
const pendingCallbacks = new Map<number, any>();

const dbProxy: any = {
    run: (query: string, params: any[], callback?: (this: any, err: Error | null) => void) => {
        if (!dbProcess) {
            logger.error('Database process not connected');
            if (callback) callback.call(null, new Error('Database process not connected'));
            return;
        }
        
        const id = messageId++;
        pendingCallbacks.set(id, callback);
        
        dbProcess.send({ type: 'run', query, params, id });
    },
    
    get: (query: string, params: any[], callback?: (err: Error | null, row?: any) => void) => {
        if (!dbProcess) {
            logger.error('Database process not connected');
            if (callback) callback(new Error('Database process not connected'), undefined);
            return;
        }
        
        const id = messageId++;
        pendingCallbacks.set(id, callback);
        
        dbProcess.send({ type: 'get', query, params, id });
    },
    
    all: (query: string, params: any[], callback?: (err: Error | null, rows: any[]) => void) => {
        if (!dbProcess) {
            logger.error('Database process not connected');
            if (callback) callback(new Error('Database process not connected'), []);
            return;
        }
        
        const id = messageId++;
        pendingCallbacks.set(id, callback);
        
        dbProcess.send({ type: 'all', query, params, id });
    },
    
    each: (query: string, params: any[], rowCallback?: (row: any, index: number) => void, completeCallback?: (err: Error | null, count: number) => void) => {
        if (!dbProcess) {
            logger.error('Database process not connected');
            if (completeCallback) completeCallback(new Error('Database process not connected'), 0);
            return;
        }
        
        const id = messageId++;
        const callback = (err: Error | null, rows?: any[]) => {
            if (err) {
                if (completeCallback) completeCallback(err, 0);
                return;
            }
            if (rows && Array.isArray(rows)) {
                rows.forEach((row, index) => {
                    if (rowCallback) rowCallback(row, index);
                });
                if (completeCallback) completeCallback(null, rows.length);
            }
        };
        pendingCallbacks.set(id, callback);
        
        dbProcess.send({ type: 'all', query, params, id });
    },
    
    serialize: (callback: () => void) => {
        callback();
    },
    
    close: (callback?: (err: Error | null) => void) => {
        if (!dbProcess) {
            if (callback) callback(new Error('Database process not connected'));
            return;
        }
        
        const id = messageId++;
        pendingCallbacks.set(id, callback);
        
        dbProcess.send({ type: 'close', id });
    }
};

export const initDb = (): void => {
    dbProxy.serialize(() => {
        dbProxy.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'root',
            bio TEXT,
            tags TEXT,
            isBanned INTEGER DEFAULT 0
        )`, [], (err) => {
            if (err) logger.error('Error creating users table', err);
            else logger.info('Users table checked/created.');
        });

        dbProxy.run(`CREATE TABLE IF NOT EXISTS problems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            authorId INTEGER,
            timeLimit INTEGER
        )`, [], (err) => {
            if (err) logger.error('Error creating problems table', err);
            else logger.info('Problems table checked/created.');
        });

        dbProxy.run(`CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            problemId INTEGER,
            userId INTEGER,
            username TEXT,
            language TEXT,
            code TEXT,
            status TEXT,
            time TEXT,
            caseResults TEXT
        )`, [], (err) => {
            if (err) logger.error('Error creating submissions table', err);
            else logger.info('Submissions table checked/created.');
        });

        dbProxy.run(`CREATE TABLE IF NOT EXISTS discussNodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            desc TEXT
        )`, [], (err) => {
            if (err) logger.error('Error creating discussNodes table', err);
            else logger.info('DiscussNodes table checked/created.');
        });

        dbProxy.run(`CREATE TABLE IF NOT EXISTS threads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nodeId INTEGER,
            title TEXT NOT NULL,
            content TEXT,
            author TEXT,
            time TEXT,
            replies TEXT
        )`, [], (err) => {
            if (err) logger.error('Error creating threads table', err);
            else logger.info('Threads table checked/created.');
        });

        dbProxy.run(`CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )`, [], (err) => {
            if (err) logger.error('Error creating roles table', err);
            else logger.info('Roles table checked/created.');
        });

        dbProxy.run(`CREATE TABLE IF NOT EXISTS plugin_configs (
            filename TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            token TEXT UNIQUE NOT NULL,
            permissions TEXT
        )`, [], (err) => {
            if (err) logger.error('Error creating plugin_configs table', err);
            else logger.info('Plugin configs table checked/created.');
        });

        dbProxy.get("SELECT COUNT(*) AS count FROM users", [], (err: Error | null, row: any) => {
            if (err) {
                logger.error('Error checking users count', err);
            } else if (row && row.count === 0) {
                dbProxy.run(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`,
                    ['root', 'root', 'root', 'System Administrator', JSON.stringify(['Admin']), 0], (err) => {
                        if (err) logger.error('Error inserting initial root user', err);
                        else logger.info('Initial root user inserted.');
                    });
            }
        });

        dbProxy.get("SELECT COUNT(*) AS count FROM discussNodes", [], (err: Error | null, row: any) => {
            if (err) {
                logger.error('Error checking discussNodes count', err);
            } else if (row && row.count === 0) {
                dbProxy.run(`INSERT INTO discussNodes (name, desc) VALUES (?, ?)`,
                    ["闲聊灌水", "随便聊聊"], (err) => {
                        if (err) logger.error('Error inserting initial discuss node', err);
                        else logger.info('Initial discuss node inserted.');
                    });
            }
        });

        dbProxy.get("SELECT COUNT(*) AS count FROM roles", [], (err: Error | null, row: any) => {
            if (err) {
                logger.error('Error checking roles count', err);
            } else if (row && row.count === 0) {
                dbProxy.run("INSERT INTO roles (name) VALUES ('default'), ('super_user'), ('root')", [], (err) => {
                    if (err) logger.error('Error inserting initial roles', err);
                    else logger.info('Initial roles inserted.');
                });
            }
        });
    });
};

export const connectDatabase = (): Promise<void> => {
    return new Promise((resolve, reject) => {
        if (!USE_SEPARATE_DB_PROCESS) {
            logger.info('Using embedded database (not separate process)');
            const sqlite3 = require('sqlite3').verbose();
            const dbPath = path.join(__dirname, '..', 'data', 'dwoj.db');
            
            const embeddedDb = new sqlite3.Database(dbPath, (err: Error | null) => {
                if (err) {
                    logger.error('Could not connect to database', err);
                    reject(err);
                } else {
                    logger.info('Connected to SQLite database.');
                    Object.assign(dbProxy, embeddedDb);
                    resolve();
                }
            });
            return;
        }
        
        const dbServicePath = path.join(__dirname, 'database-service.js');
        
        dbProcess = fork(dbServicePath, [], {
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        });
        
        dbProcess.stdout.on('data', (data) => {
            logger.info(`[DB-Service] ${data.toString().trim()}`);
        });
        
        dbProcess.stderr.on('data', (data) => {
            logger.error(`[DB-Service] ${data.toString().trim()}`);
        });
        
        dbProcess.on('message', (message: any) => {
            const msg = message as any;
            const { type, id, result, error } = msg;
            
            if (type === 'READY') {
                logger.info('Database service is ready.');
                resolve();
                return;
            }
            
            if (type === 'ERROR') {
                logger.error(`Database error (ID: ${id}): ${error}`);
                const callback = pendingCallbacks.get(id);
                if (callback) {
                    callback(new Error(error));
                    pendingCallbacks.delete(id);
                }
                return;
            }
            
            if (type === 'RESULT' || type === 'CLOSED') {
                const callback = pendingCallbacks.get(id);
                if (callback) {
                    if (type === 'RESULT') {
                        if (result && (result.lastID !== undefined || result.changes !== undefined)) {
                            callback.call(result, null);
                        } else {
                            callback(null, result);
                        }
                    } else {
                        callback(null);
                    }
                    pendingCallbacks.delete(id);
                }
                return;
            }
        });
        
        dbProcess.on('exit', (code) => {
            logger.warn(`Database process exited with code ${code}`);
            dbProcess = null;
        });
        
        dbProcess.on('error', (err) => {
            logger.error('Database process error', err);
            reject(err);
        });
        
        setTimeout(() => {
            reject(new Error('Database service connection timeout'));
        }, 10000);
    });
};

export { dbProxy as db };
export default dbProxy;
