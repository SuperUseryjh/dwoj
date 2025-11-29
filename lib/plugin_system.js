const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');
const { db } = require('./database'); // 引入 db 模块

class PluginSystem {
    constructor(pluginDir, dbRef, appRef) {
        this.pluginDir = pluginDir;
        this.plugins = {}; 
        this.db = dbRef; // 这里的 dbRef 实际上是 database.js 导出的 db 对象
        this.app = appRef; 
        
        fs.ensureDirSync(pluginDir);
    }

    async loadAll() {
        const files = fs.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
        this.plugins = {}; 

        for (const file of files) {
            const fullPath = path.join(this.pluginDir, file);
            try {
                delete require.cache[require.resolve(fullPath)];
                const plugin = require(fullPath);
                
                // 从数据库加载插件配置
                const config = await new Promise((resolve, reject) => {
                    db.get("SELECT enabled FROM plugin_configs WHERE filename = ?", [file], (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    });
                });
                const isEnabled = config ? (config.enabled === 1) : false; // SQLite 存储 0/1

                this.plugins[file] = {
                    ...plugin,
                    filename: file,
                    enabled: isEnabled
                };

                // 如果插件启用且有 onRoute 钩子，立即执行它
                if (isEnabled && typeof plugin.onRoute === 'function') {
                    logger.info(`[Plugin] Hot-registering routes for ${file}`);
                    plugin.onRoute(this.app, this.db); // 传入 app 和 db
                }

            } catch (e) {
                logger.error(`[Plugin] Failed to load ${file}:`, e);
            }
        }
    }

    emit(hookName, ...args) {
        let results = [];
        Object.values(this.plugins).forEach(p => {
            if (p.enabled && typeof p[hookName] === 'function') {
                try {
                    const res = p[hookName](...args, this.db); 
                    if (res) results.push(res);
                } catch (e) {
                    logger.error(`[Plugin Error] [${p.name || p.filename}] [${hookName}]:`, e);
                }
            }
        });
        return results;
    }

    getList() {
        const list = [];
        const files = fs.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
        files.forEach(f => {
            const loaded = this.plugins[f];
            if (loaded) {
                list.push({ filename: f, name: loaded.name, desc: loaded.description, version: loaded.version, enabled: loaded.enabled });
            } else {
                list.push({ filename: f, name: "Unknown/Error", enabled: false });
            }
        });
        return list;
    }

    async toggle(filename, enabled) {
        const enabledValue = enabled ? 1 : 0; // SQLite 存储 0/1
        await new Promise((resolve, reject) => {
            db.run("INSERT OR REPLACE INTO plugin_configs (filename, enabled) VALUES (?, ?)", [filename, enabledValue], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        await this.loadAll(); // 重新加载以刷新内存状态和路由
    }

    async delete(filename) {
        const p = path.join(this.pluginDir, filename);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (e) {
                logger.error(`Error deleting plugin file ${p}`, e);
            }
        }
        await new Promise((resolve, reject) => {
            db.run("DELETE FROM plugin_configs WHERE filename = ?", [filename], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        await this.loadAll();
    }
}

module.exports = PluginSystem;