"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.initDb = void 0;
const sqlite3_1 = __importDefault(require("sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const logger_1 = __importDefault(require("./logger"));
const dbPath = path_1.default.join(__dirname, '..', 'data', 'dwoj.db');
fs_extra_1.default.ensureDirSync(path_1.default.dirname(dbPath));
const db = new sqlite3_1.default.Database(dbPath, (err) => {
    if (err) {
        logger_1.default.error('Could not connect to database', err);
    }
    else {
        logger_1.default.info('Connected to SQLite database.');
    }
});
exports.db = db;
const initDb = () => {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'root',
            bio TEXT,
            tags TEXT,
            isBanned INTEGER DEFAULT 0
        )`, (err) => {
            if (err)
                logger_1.default.error('Error creating users table', err);
            else
                logger_1.default.info('Users table checked/created.');
        });
        db.run(`CREATE TABLE IF NOT EXISTS problems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            authorId INTEGER,
            timeLimit INTEGER
        )`, (err) => {
            if (err)
                logger_1.default.error('Error creating problems table', err);
            else
                logger_1.default.info('Problems table checked/created.');
        });
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
        )`, (err) => {
            if (err)
                logger_1.default.error('Error creating submissions table', err);
            else
                logger_1.default.info('Submissions table checked/created.');
        });
        db.run(`CREATE TABLE IF NOT EXISTS discussNodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            desc TEXT
        )`, (err) => {
            if (err)
                logger_1.default.error('Error creating discussNodes table', err);
            else
                logger_1.default.info('DiscussNodes table checked/created.');
        });
        db.run(`CREATE TABLE IF NOT EXISTS threads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nodeId INTEGER,
            title TEXT NOT NULL,
            content TEXT,
            author TEXT,
            time TEXT,
            replies TEXT
        )`, (err) => {
            if (err)
                logger_1.default.error('Error creating threads table', err);
            else
                logger_1.default.info('Threads table checked/created.');
        });
        db.run(`CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )`, (err) => {
            if (err)
                logger_1.default.error('Error creating roles table', err);
            else
                logger_1.default.info('Roles table checked/created.');
        });
        db.run(`CREATE TABLE IF NOT EXISTS plugin_configs (
            filename TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            token TEXT UNIQUE NOT NULL,
            permissions TEXT
        )`, (err) => {
            if (err)
                logger_1.default.error('Error creating plugin_configs table', err);
            else
                logger_1.default.info('Plugin configs table checked/created.');
        });
        db.get("SELECT COUNT(*) AS count FROM users", (err, row) => {
            if (err) {
                logger_1.default.error('Error checking users count', err);
            }
            else if (row.count === 0) {
                db.run(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`, ['root', 'root', 'root', 'System Administrator', JSON.stringify(['Admin']), 0], (err) => {
                    if (err)
                        logger_1.default.error('Error inserting initial root user', err);
                    else
                        logger_1.default.info('Initial root user inserted.');
                });
            }
        });
        db.get("SELECT COUNT(*) AS count FROM discussNodes", (err, row) => {
            if (err) {
                logger_1.default.error('Error checking discussNodes count', err);
            }
            else if (row.count === 0) {
                db.run(`INSERT INTO discussNodes (name, desc) VALUES (?, ?)`, ["闲聊灌水", "随便聊聊"], (err) => {
                    if (err)
                        logger_1.default.error('Error inserting initial discuss node', err);
                    else
                        logger_1.default.info('Initial discuss node inserted.');
                });
            }
        });
        db.get("SELECT COUNT(*) AS count FROM roles", (err, row) => {
            if (err) {
                logger_1.default.error('Error checking roles count', err);
            }
            else if (row.count === 0) {
                db.run("INSERT INTO roles (name) VALUES ('default'), ('super_user'), ('root')", (err) => {
                    if (err)
                        logger_1.default.error('Error inserting initial roles', err);
                    else
                        logger_1.default.info('Initial roles inserted.');
                });
            }
        });
    });
};
exports.initDb = initDb;
exports.default = db;
//# sourceMappingURL=database.js.map