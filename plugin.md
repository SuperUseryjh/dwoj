# 插件系统文档（dwoj-lite）

## 1. 简介

dwoj-lite 的插件系统只保留最小必要能力：从 `plugins/` 加载 `.js` 插件、提供生命周期钩子、插件间通信与管理界面。**权限代理、token 与审计日志已移除**——插件等同于可信代码，直接拿到 `oj` 与 `db`。

## 2. 核心概念

### 2.1 PluginSystem

- 加载 `plugins/*.js` 与内置插件
- 启停状态持久化到 `plugins/config.json`
- 管理已启用插件并分发钩子
- 维护 `pluginExports` 支持插件间通信

### 2.2 注入对象

- `oj`: `{ app, db, config, logger }`
- `db`: 数据库访问接口
  - `db.query(sql, params)` → 数组
  - `db.queryOne(sql, params)` → 单条或 `undefined`
  - `db.execute(sql, params)` → `{ lastInsertRowid, changes }`
  - `db.transaction(fn)`

### 2.3 启停状态

启用/禁用直接写入 `plugins/config.json`：

```json
{
  "my_plugin.js": { "enabled": true },
  "builtin:db-monitor": { "enabled": false }
}
```

## 3. 插件结构

```javascript
module.exports = {
    manifest: {
        name: "示例插件",          // 展示名，同时作为插件间通信的 key
        description: "示例描述",
        version: "1.0.0"
    },
    // 钩子...
    exports: {
        getSomeData: () => ({ message: "hello from plugin" })
    }
};
```

`manifest.permissions` 字段仍可保留，但不再参与权限校验。

## 4. 钩子

钩子统一签名为 `(oj, db, getPluginExports, ...args)`：

| 钩子 | 触发时机 | 额外参数 |
|---|---|---|
| `onLoad` | 插件启用并加载时 | 无 |
| `onRoute` | 启用时热注册路由 | `app` |
| `beforeJudge` | 判题开始前 | `submission` |
| `afterJudge` | 判题结束后 | `submission` |
| `injectHeader` | 每次渲染页面 | `req`，返回字符串注入 `<head>` |
| `injectFooter` | 每次渲染页面 | `req`，返回字符串注入 `</body>` 前 |

未启用插件或未实现某钩子时不会产生任何调用开销。

### 示例

```javascript
module.exports = {
    manifest: { name: 'hello', description: 'demo', version: '1.0.0' },

    onRoute(oj, db, getPluginExports, app) {
        oj.app.get('/hello-plugin', (req, res) => {
            const users = db.query('SELECT id, username FROM users LIMIT 5');
            res.json({ users });
        });
    },

    beforeJudge(oj, db, getPluginExports, submission) {
        oj.logger.info(`判题开始 #${submission.id}`);
    },

    injectFooter(_oj, _db, _getExports, _req) {
        return '<div class="text-center text-muted">Powered by plugin</div>';
    },

    exports: {
        getSomeData: () => ({ message: 'hello from plugin' }),
    },
};
```

通过 `getPluginExports('hello')` 可访问其他已启用插件的 `exports`。

## 5. 管理界面

管理面板 → 插件管理：

- **上传**：仅接受 `.js`，上限 256 KB
- **启用/禁用**：立即重载，状态写入 `config.json`
- **删除**：删除插件文件与对应配置项（内置插件不可删除）

> 警告：插件代码拥有完整服务端权限，请只上传可信来源的插件。

## 6. 内置插件

`db-monitor` 提供数据库慢查询计时，默认关闭。启用方式：

```bash
ENABLED_BUILTIN_PLUGINS=db-monitor bun run start:lowmem
```

或在管理界面启用 `builtin:db-monitor`。启用后访问 `/admin/db-monitor` 查看统计。
