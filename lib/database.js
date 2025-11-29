const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');

const dbPath = path.join(__dirname, '..', 'data', 'dwoj.db');

// 确保数据目录存在
fs.ensureDirSync(path.dirname(dbPath));

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        logger.error('Could not connect to database', err);
    } else {
        logger.info('Connected to SQLite database.');
    }
});

const initDb = () => {
    db.serialize(() => {
        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'default',
            bio TEXT,
            tags TEXT,
            isBanned INTEGER DEFAULT 0
        )`, (err) => {
            if (err) logger.error('Error creating users table', err);
            else logger.info('Users table checked/created.');
        });

        // Problems Table
        db.run(`CREATE TABLE IF NOT EXISTS problems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            authorId INTEGER,
            timeLimit INTEGER
        )`, (err) => {
            if (err) logger.error('Error creating problems table', err);
            else logger.info('Problems table checked/created.');
        });

        // Submissions Table
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
            if (err) logger.error('Error creating submissions table', err);
            else logger.info('Submissions table checked/created.');
        });

        // DiscussNodes Table
        db.run(`CREATE TABLE IF NOT EXISTS discussNodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            desc TEXT
        )`, (err) => {
            if (err) logger.error('Error creating discussNodes table', err);
            else logger.info('DiscussNodes table checked/created.');
        });

        // Threads Table
        db.run(`CREATE TABLE IF NOT EXISTS threads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nodeId INTEGER,
            title TEXT NOT NULL,
            content TEXT,
            author TEXT,
            time TEXT,
            replies TEXT
        )`, (err) => {
            if (err) logger.error('Error creating threads table', err);
            else logger.info('Threads table checked/created.');
        });

        // Roles Table (for dynamic roles, if needed, otherwise hardcoded)
        db.run(`CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )`, (err) => {
            if (err) logger.error('Error creating roles table', err);
            else logger.info('Roles table checked/created.');
        });

        // Plugin Configs Table
        db.run(`CREATE TABLE IF NOT EXISTS plugin_configs (
            filename TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0
        )`, (err) => {
            if (err) logger.error('Error creating plugin_configs table', err);
            else logger.info('Plugin configs table checked/created.');
        });

        // 插入初始数据 (如果表为空)
        db.get("SELECT COUNT(*) AS count FROM users", (err, row) => {
            if (err) {
                logger.error('Error checking users count', err);
            } else if (row.count === 0) {
                db.run(`INSERT INTO users (username, password, role, bio, tags, isBanned) VALUES (?, ?, ?, ?, ?, ?)`, 
                    ['root', 'root', 'root', 'System Administrator', JSON.stringify(['Admin']), 0], (err) => {
                    if (err) logger.error('Error inserting initial root user', err);
                    else logger.info('Initial root user inserted.');
                });
            }
        });

        db.get("SELECT COUNT(*) AS count FROM discussNodes", (err, row) => {
            if (err) {
                logger.error('Error checking discussNodes count', err);
            } else if (row.count === 0) {
                db.run(`INSERT INTO discussNodes (name, desc) VALUES (?, ?)`, 
                    ["闲聊灌水", "随便聊聊"], (err) => {
                    if (err) logger.error('Error inserting initial discuss node', err);
                    else logger.info('Initial discuss node inserted.');
                });
            }
        });

        db.get("SELECT COUNT(*) AS count FROM roles", (err, row) => {
            if (err) {
                logger.error('Error checking roles count', err);
            } else if (row.count === 0) {
                db.run(`INSERT INTO roles (name) VALUES ('default'), ('super_user'), ('root')`, (err) => {
                    if (err) logger.error('Error inserting initial roles', err);
                    else logger.info('Initial roles inserted.');
                });
            }
        });
    });
};

module.exports = { db, initDb };
