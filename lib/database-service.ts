import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs-extra';
import logger from './logger';

const dbPath = path.join(__dirname, '..', 'data', 'dwoj.db');

fs.ensureDirSync(path.dirname(dbPath));

let db: sqlite3.Database | null = null;

const initDatabase = (): Promise<sqlite3.Database> => {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                logger.error('Could not connect to database', err);
                reject(err);
            } else {
                logger.info('Connected to SQLite database.');
                resolve(db as sqlite3.Database);
            }
        });
    });
};

const initDb = (): void => {
    if (!db) return;
    
    db.serialize(() => {
        db!.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'default',
            bio TEXT,
            tags TEXT,
            isBanned INTEGER DEFAULT 0
        )`, [], (err) => {
            if (err) logger.error('Error creating users table', err);
            else logger.info('Users table checked/created.');
        });

        db!.run(`CREATE TABLE IF NOT EXISTS problems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            authorId INTEGER,
            timeLimit INTEGER
        )`, [], (err) => {
            if (err) logger.error('Error creating problems table', err);
            else logger.info('Problems table checked/created.');
        });

        db!.run(`CREATE TABLE IF NOT EXISTS submissions (
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

        db!.run(`CREATE TABLE IF NOT EXISTS discussNodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            desc TEXT
        )`, [], (err) => {
            if (err) logger.error('Error creating discussNodes table', err);
            else logger.info('DiscussNodes table checked/created.');
        });

        db!.run(`CREATE TABLE IF NOT EXISTS threads (
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

        db!.run(`CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )`, [], (err) => {
            if (err) logger.error('Error creating roles table', err);
            else logger.info('Roles table checked/created.');
        });

        db!.run(`CREATE TABLE IF NOT EXISTS plugin_configs (
            filename TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            token TEXT UNIQUE NOT NULL,
            permissions TEXT
        )`, [], (err) => {
            if (err) logger.error('Error creating plugin_configs table', err);
            else logger.info('Plugin configs table checked/created.');
        });

        db!.get("SELECT COUNT(*) AS count FROM users", [], (err, row: any) => {
            if (err) {
                logger.error('Error checking users count', err);
            } else if (row && row.count === 0) {
                db!.run(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`, 
                    ['root', 'root', 'root', 'System Administrator', JSON.stringify(['Admin']), 0], (err) => {
                    if (err) logger.error('Error inserting initial root user', err);
                    else logger.info('Initial root user inserted.');
                });
            }
        });

        db!.get("SELECT COUNT(*) AS count FROM discussNodes", [], (err, row: any) => {
            if (err) {
                logger.error('Error checking discussNodes count', err);
            } else if (row && row.count === 0) {
                db!.run(`INSERT INTO discussNodes (name, desc) VALUES (?, ?)`, 
                    ["闲聊灌水", "随便聊聊"], (err) => {
                    if (err) logger.error('Error inserting initial discuss node', err);
                    else logger.info('Initial discuss node inserted.');
                });
            }
        });

        db!.get("SELECT COUNT(*) AS count FROM roles", [], (err, row: any) => {
            if (err) {
                logger.error('Error checking roles count', err);
            } else if (row && row.count === 0) {
                db!.run(`INSERT INTO roles (name) VALUES ('default'), ('super_user'), ('root')`, [], (err) => {
                    if (err) logger.error('Error inserting initial roles', err);
                    else logger.info('Initial roles inserted.');
                });
            }
        });
    });
};

interface DBMessage {
    type: string;
    query?: string;
    params?: any[];
    id?: number;
    result?: any;
    error?: string;
}

if (process.send) {
    logger.info('Starting database as a separate process...');
    
    initDatabase()
        .then(() => {
            initDb();
            process.send({ type: 'READY' });
            logger.info('Database service is ready.');
        })
        .catch((err) => {
            logger.error('Failed to initialize database', err);
            process.send({ type: 'ERROR', error: err.message });
            process.exit(1);
        });

    process.on('message', (message: DBMessage) => {
        const { type, query, params, id } = message;
        
        if (!db) {
            process.send({ type: 'ERROR', id, error: 'Database not initialized' });
            return;
        }
        
        try {
            switch (type) {
                case 'run':
                    db.run(query!, params!, function(err) {
                        if (err) {
                            process.send({ type: 'ERROR', id, error: err.message });
                        } else {
                            process.send({ 
                                type: 'RESULT', 
                                id, 
                                result: { lastID: this.lastID, changes: this.changes } 
                            });
                        }
                    });
                    break;
                    
                case 'get':
                    db.get(query!, params!, (err, row) => {
                        if (err) {
                            process.send({ type: 'ERROR', id, error: err.message });
                        } else {
                            process.send({ type: 'RESULT', id, result: row });
                        }
                    });
                    break;
                    
                case 'all':
                    db.all(query!, params!, (err, rows) => {
                        if (err) {
                            process.send({ type: 'ERROR', id, error: err.message });
                        } else {
                            process.send({ type: 'RESULT', id, result: rows });
                        }
                    });
                    break;
                    
                case 'close':
                    db.close((err) => {
                        if (err) {
                            process.send({ type: 'ERROR', id, error: err.message });
                        } else {
                            process.send({ type: 'CLOSED', id });
                            process.exit(0);
                        }
                    });
                    break;
                    
                default:
                    process.send({ type: 'ERROR', id, error: `Unknown message type: ${type}` });
            }
        } catch (error: any) {
            process.send({ type: 'ERROR', id, error: error.message });
        }
    });

    process.on('disconnect', () => {
        logger.info('Database service disconnecting...');
        if (db) {
            db.close((err) => {
                if (err) {
                    logger.error('Error closing database', err);
                } else {
                    logger.info('Database connection closed.');
                }
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
} else {
    logger.warn('Database service started without IPC. Running in standalone mode.');
    initDatabase()
        .then(() => {
            initDb();
            logger.info('Database service is ready (standalone mode).');
        })
        .catch((err) => {
            logger.error('Failed to initialize database', err);
            process.exit(1);
        });
}

export { db, initDb };
