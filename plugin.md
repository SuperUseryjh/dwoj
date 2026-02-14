# 插件系统文档

## 1. 简介

DWOJ 的插件系统经过重构，旨在提供一个更安全、更模块化、更易于扩展的框架。新的插件系统引入了权限管理、受控的 API 访问、**插件配置持久化**和**插件间通信**功能，确保插件只能执行其被授权的操作，从而增强了系统的稳定性和安全性。

## 2. 核心概念

### 2.1. PluginSystem (插件管理器)

`PluginSystem` 是插件管理的核心。它负责：
*   加载插件目录中的所有插件。
*   为每个插件生成唯一的权限令牌。
*   管理插件的启用/禁用状态，并**将这些状态持久化到数据库中**。
*   在应用程序生命周期的特定点（钩子）触发插件功能。
*   提供插件列表和管理接口。
*   **管理所有已启用插件的导出功能 (`pluginExports`)，以支持插件间的通信。**

### 2.2. Plugin (插件包装器)

`Plugin` 是一个内部包装类，用于封装实际的插件模块。它为每个加载的插件实例提供了一个受控的环境，主要职责包括：
*   存储插件的元数据（名称、描述、版本、权限）。
*   为 `oj` 和 `db` 对象创建权限感知的代理。
*   在插件尝试执行操作时，通过代理强制执行权限检查。
*   安全地执行插件定义的钩子函数，并**提供 `getPluginExports` 函数以实现插件间通信**。

### 2.3. OJ 对象 (核心操作对象)

`oj` 对象是一个聚合了 OJ 核心功能的接口。它被传递给插件，允许插件与应用程序的各个方面进行交互。通过 `oj` 代理，插件对这些功能的访问受到其声明权限的限制。

当前 `oj` 对象包含以下核心组件：
*   `oj.app`: Express 应用程序实例，用于注册路由等。
*   `oj.db`: 数据库连接实例，用于执行数据库操作。
*   `oj.config`: 应用程序的配置对象。
*   `oj.logger`: 应用程序的日志记录器。

### 2.4. DB 对象 (数据库操作对象)

`db` 对象是 SQLite 数据库连接的实例。插件可以通过 `db` 代理执行数据库查询和更新。对 `db` 的所有操作都将经过权限检查，以确保插件具有 `read_db` 或 `write_db` 权限。**权限检查现在可以更精细地控制，例如区分 `read_db` 和 `write_db`。**

### 2.5. 权限令牌 (Token)

每个插件在首次加载时都会获得一个唯一的十六进制字符串作为权限令牌。此令牌用于标识插件，并在内部用于权限管理。**插件的令牌现在会持久化到数据库中。**

### 2.6. 权限 (Permissions)

权限是插件声明其所需能力的字符串数组。在插件尝试执行敏感操作时，`Plugin` 包装器会检查其是否拥有相应的权限。如果插件没有所需的权限，操作将被拒绝并抛出错误。**权限检查现在支持更灵活的定义和检查，例如通过 `permissionToCheck` 参数。**

## 3. 插件结构

一个插件是一个 Node.js 模块（`.js` 文件），它导出一个包含 `manifest` 对象和各种钩子函数对象。

### 3.1. `manifest` 对象

`manifest` 对象是插件的元数据，必须包含以下属性：

*   `name` (String, 必需): 插件的名称。
*   `description` (String, 必需): 插件的简短描述。
*   `version` (String, 必需): 插件的版本号 (遵循 SemVer 规范，例如 "1.0.0")。
*   `permissions` (Array<String>, 必需): 插件请求的权限列表。

**示例 `manifest`：**

```javascript
module.exports = {
    manifest: {
        name: "我的第一个插件",
        description: "一个简单的示例插件，用于演示新插件系统。",
        version: "1.0.0",
        permissions: ["read_db", "write_db", "oj_access"]
    },
    // ... 钩子函数
};
```

### 3.2. 钩子函数 (Hooks)

钩子函数是插件在应用程序生命周期特定点执行的代码。它们通常接收 `oj` 和 `db` 代理对象作为前两个参数，**以及一个 `getPluginExports` 函数用于插件间通信**，以及其他特定于钩子的参数。

**通用钩子示例：**

*   `onRoute(oj, db, getPluginExports, app)`: 在 Express 路由加载时触发，允许插件注册自己的路由。**此钩子在插件加载时（如果插件已启用）立即执行，实现路由的热注册。**
*   `onProblemSubmit(oj, db, getPluginExports, submission)`: 在用户提交问题时触发。
*   `onUserRegister(oj, db, getPluginExports, user)`: 在新用户注册时触发。
*   `onBeforeJudge(oj, db, getPluginExports, submissionId)`: 在判题开始前触发。
*   `onAfterJudge(oj, db, getPluginExports, submissionId, result)`: 在判题结束前触发。

**示例钩子：**

```javascript
module.exports = {
    manifest: { /* ... */ },
    onRoute: (oj, db, getPluginExports, app) => {
        // 注册一个新路由
        oj.app.get('/my-plugin-route', (req, res) => {
            res.send('Hello from my plugin route!');
        });
    },
    onProblemSubmit: async (oj, db, getPluginExports, submission) => {
        oj.logger.info(`插件收到提交：问题ID ${submission.problemId}，用户ID ${submission.userId}`);
        // 假设插件有 'write_db' 权限，可以记录到自定义表
        // await new Promise((resolve, reject) => {
        //     db.run("INSERT INTO plugin_logs (message) VALUES (?)", [`Submission by ${submission.userId}`], (err) => {
        //         if (err) reject(err); else resolve();
        //     });
        // });

        // 示例：通过 getPluginExports 访问其他插件的功能
        const anotherPlugin = getPluginExports('另一个插件的名称');
        if (anotherPlugin && typeof anotherPlugin.someFunction === 'function') {
            anotherPlugin.someFunction(submission);
        }
    }
};
```

## 4. 可用权限

插件必须在其 `manifest` 中声明所需的权限。以下是当前支持的权限及其控制范围：

*   `read_db`: 允许插件执行数据库读取操作（例如 `db.get`, `db.all`, `db.each`）。
*   `write_db`: 允许插件执行数据库写入操作（例如 `db.run`, `db.insert`, `db.update`, `db.delete`）。
*   `oj_access`: 允许插件访问 `oj` 对象除 `app`、`config`、`logger` 之外的其他属性和方法。目前，`app`、`config` 和 `logger` 默认可访问，但更精细的 `oj` 权限可以在未来添加。

**重要提示：** 权限检查是通过代理对象实现的，它会根据方法名称进行启发式判断（例如，`db.get` 被认为是读取操作，`db.run` 被认为是写入操作）。**权限检查现在支持通过 `permissionToCheck` 参数进行更灵活的定义和验证。**

## 5. 访问 OJ 和 DB

插件通过 `oj` 和 `db` 代理对象与核心系统和数据库进行交互。这些代理会在每次调用时检查插件的权限。

**示例：**

```javascript
// 假设插件已声明 "read_db" 和 "write_db" 权限

// 读取数据库 (需要 'read_db' 权限)
db.all("SELECT * FROM users", [], (err, rows) => {
    if (err) {
        oj.logger.error("查询用户失败:", err);
        return;
    }
    oj.logger.info("所有用户:", rows);
});

// 写入数据库 (需要 'write_db' 权限)
db.run("INSERT INTO custom_data (value) VALUES (?)", ["some_value"], (err) => {
    if (err) {
        oj.logger.error("插入数据失败:", err);
        return;
    }
    oj.logger.info("数据插入成功。");
});

// 访问 Express app (默认允许)
oj.app.post('/api/plugin-data', (req, res) => {
    res.json({ message: 'Data received by plugin API' });
});

// 访问配置 (默认允许)
oj.logger.info("应用程序端口:", oj.config.PORT);
```

如果插件尝试执行未经授权的操作，例如在没有 `write_db` 权限的情况下调用 `db.run`，代理将抛出 `Unauthorized action: db_write` 错误。

## 6. 插件管理 (管理员界面)

管理员可以通过管理界面管理插件：
*   **启用/禁用插件:** 管理员可以切换插件的运行状态。**插件的启用/禁用状态现在会持久化到数据库中。**
*   **查看插件信息:** 查看插件的名称、描述、版本、令牌和已授予的权限。
*   **删除插件:** 从文件系统和数据库中删除插件。

**注意：** 权限的授予和撤销目前在代码中是自动的（新插件请求的权限默认被授予）。未来可能会引入一个管理员界面，允许管理员手动审查和批准插件的权限请求。

## 7. 示例插件

以下是一个完整的示例插件，演示了如何使用新的插件系统：

```javascript
// plugins/my_example_plugin.js
const crypto = require('crypto'); // 示例中可能需要

module.exports = {
    manifest: {
        name: "示例插件",
        description: "一个演示新插件系统功能的插件。",
        version: "1.0.0",
        permissions: ["read_db", "write_db", "oj_access"] // 请求读写数据库和OJ核心访问权限
    },

    // 在 Express 路由加载时触发
    onRoute: (oj, db, getPluginExports, app) => {
        oj.logger.info("[示例插件] 注册路由 /example-plugin");
        oj.app.get('/example-plugin', async (req, res) => {
            try {
                // 尝试从数据库读取数据 (需要 'read_db' 权限)
                const users = await new Promise((resolve, reject) => {
                    db.all("SELECT id, username FROM users LIMIT 5", [], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    });
                });

                // 尝试向数据库写入数据 (需要 'write_db' 权限)
                const randomValue = crypto.randomBytes(4).toString('hex');
                await new Promise((resolve, reject) => {
                    db.run("INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        [1, 1, 'example_plugin', 'javascript', `console.log('${randomValue}');`, 'PluginGenerated', Date.now().toString(), '[]'],
                        (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                });

                // 示例：通过 getPluginExports 访问其他插件的功能
                const anotherPlugin = getPluginExports('另一个插件的名称'); // 假设存在一个名为 '另一个插件的名称' 的插件
                let additionalData = {};
                if (anotherPlugin && typeof anotherPlugin.getSomeData === 'function') {
                    additionalData = anotherPlugin.getSomeData();
                }

                res.send(`
                    <h1>Hello from Example Plugin!</h1>
                    <p>当前时间: ${new Date().toLocaleString()}</p>
                    <p>前5个用户: ${JSON.stringify(users)}</p>
                    <p>已向 submissions 表插入一条记录，值为: ${randomValue}</p>
                    <p>OJ 配置端口: ${oj.config.PORT}</p>
                    <p>来自其他插件的数据: ${JSON.stringify(additionalData)}</p>
                `);
            } catch (error) {
                oj.logger.error("[示例插件] 路由处理错误:", error);
                res.status(500).send(`插件内部错误: ${error.message}`);
            }
        });
    },

    // 在用户提交问题时触发
    onProblemSubmit: (oj, db, getPluginExports, submission) => {
        oj.logger.info(`[示例插件] 收到问题提交: 问题ID=${submission.problemId}, 用户ID=${submission.userId}`);
        // 可以在这里添加自定义逻辑，例如记录到另一个日志文件或触发其他操作
    },

    // 在新用户注册时触发
    onUserRegister: (oj, db, getPluginExports, user) => {
        oj.logger.info(`[示例插件] 新用户注册: 用户名=${user.username}, ID=${user.id}`);
    },

    // 插件可以导出的功能或数据
    exports: {
        getSomeData: () => {
            return { message: "Hello from another plugin!" };
        }
    }
};
```