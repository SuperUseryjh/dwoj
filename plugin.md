# 插件系统文档

本文档描述 DWOJ 当前插件系统的真实实现：

- 插件加载与钩子执行：`lib/plugin_system.ts`、`lib/plugin/plugin_service.ts`
- http / judge 访问插件的桥梁：`lib/plugin/host.ts`
- 插件路由反向代理：`lib/http/http_service.ts`

插件文件使用 **ES Module** 格式编写（历史 CommonJS 插件仍可加载）。

## 目录

1. [设计概览](#1-设计概览)
2. [插件文件结构（ES Module）](#2-插件文件结构es-module)
3. [生命周期与钩子](#3-生命周期与钩子)
4. [oj / db 对象](#4-oj--db-对象)
5. [权限模型](#5-权限模型)
6. [配置持久化与插件状态](#6-配置持久化与插件状态)
7. [插件间通信](#7-插件间通信)
8. [插件 HTTP 路由与热更新](#8-插件-http-路由与热更新)
9. [日志](#9-日志)
10. [与旧版文档的差异](#10-与旧版文档的差异)
11. [管理界面与运维](#11-管理界面与运维)
12. [完整示例插件](#12-完整示例插件)
13. [限制与注意事项](#13-限制与注意事项)

---

## 1. 设计概览

### 1.1 独立的 plugin 进程

插件运行在独立的 **plugin 进程** 中，http / judge 进程不再加载任何插件代码。默认多进程架构：

```text
                 ┌──────────────── broker (app.ts) ─────────────────┐
                 │  拉起/重启子进程 · 按 {to} 转发消息 · 优雅关闭   │
                 └───┬──────────────┬──────────────┬───────────────┘
                     │              │              │
              ┌──────▼─────┐  ┌─────▼──────┐  ┌────▼──────┐  ┌────▼──────┐
              │     db     │  │   plugin   │  │   http    │  │   judge   │
              │ 唯一数据库 │  │ 加载插件   │  │ 路由/页面 │  │ 评测队列  │
              │            │  │ 钩子 + 路由│  │ 反代插件  │  │ 沙箱      │
              └────────────┘  └─────┬──────┘  └────▲──────┘  └───────────┘
                                    │ 私有 HTTP 端口│
                                    └───────────────┘
```

启动顺序固定为 **db → plugin → http / judge**：

- db 先建表/迁移；
- plugin 进程随后加载插件（需要读 `plugin_configs`）；
- http / judge 最后启动，此时插件钩子与插件路由都已就绪。

各进程职责：

| 进程 | 与插件相关的工作 |
|------|------------------|
| plugin | 唯一加载插件代码的进程；执行所有钩子；对内提供插件路由服务器 |
| http | 每个请求调用 plugin 进程的 `injectHeader` / `injectFooter`；未命中核心路由时反向代理到插件路由服务器 |
| judge | 每次评测前/后通过 IPC 调用 plugin 进程的 `beforeJudge` / `afterJudge` |
| db | 插件通过 `db` 对象发起的 SQL 由 plugin 进程经 IPC 转到这里执行 |

这样做的好处：

- 插件代码崩溃、死循环、内存泄漏只会带走 plugin 进程，broker 会按退避策略重启它，http / judge 不受影响；
- 插件状态在全局只有一份，管理界面启用/禁用后，http 的页面注入与 judge 的判题钩子**同时生效**；
- 插件路由可以随插件重载即时更新（见第 8 节）。

### 1.2 两个核心类

- **`PluginSystem`（插件管理器）**
  - 扫描 `plugins/` 下的 `.js` 文件并动态 `import()`；
  - 从 `plugin_configs` 读取启用状态、令牌和已授予权限；
  - 首次见到插件时生成令牌并入库（默认**禁用**）；
  - 加载内置插件（`lib/builtin_plugins/`，当前为 `db-monitor`）；
  - 维护 `pluginExports` 供插件互相调用；
  - `emit()` 向所有**已启用**插件广播钩子。

- **`Plugin`（单个插件实例的包装器）**
  - 保存元数据与令牌；
  - 为 `oj` / `db` 创建**权限代理**；
  - 为插件创建专属 logger；
  - 执行钩子并注入 `getPluginExports`。

单进程模式（`DWOJ_SINGLE_PROCESS=1`）下没有 plugin 子进程，插件直接加载进主进程，插件路由直接注册在主应用上，不存在反向代理。

---

## 2. 插件文件结构（ES Module）

外部插件放在 `plugins/` 目录（`config.PLUGINS_DIR`），文件名以 `.js` 结尾，使用 ESM 命名导出：

```javascript
export const manifest = {
    name: 'my-plugin',
    description: '示例插件',
    version: '1.0.0',
    permissions: ['read_db', 'write_db']
};

export function onLoad(oj, db, getPluginExports) { /* ... */ }

export function onRoute(oj, db, getPluginExports, app) { /* ... */ }

export function injectFooter(oj, db, getPluginExports, req) {
    return '<div>...</div>';
}

export function beforeJudge(oj, db, getPluginExports, submission) { /* ... */ }
export function afterJudge(oj, db, getPluginExports, submission) { /* ... */ }

export const pluginExports = {
    hello: () => 'hello'
};
```

说明：

- 加载方式是 `await import(fileUrl + '?t=...')`，重载时会带上新的时间戳，**不会命中模块缓存**，因此修改插件文件后重新加载即可生效。
- 也支持 `export default { manifest, onLoad, ... }` 写法的默认导出对象。
- 历史 **CommonJS** 插件（`module.exports = { manifest, ... }`）仍可加载，但新插件请使用 ESM。
- 只扫描 `.js` 文件；不支持 `.ts`、目录形式的插件。
- 插件代码与宿主同权限运行在 plugin 进程中，**不是安全沙箱**。

### 2.1 manifest 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 插件显示名；同时作为插件间通信的键和日志模块名的来源 |
| `description` | string | 管理界面展示的描述 |
| `version` | string | 版本号，默认 `1.0.0` |
| `permissions` | string[] | 请求的权限；**仅在首次加载时自动授予**，之后以数据库记录为准 |

### 2.2 导出集合

`export const pluginExports = { ... }` 会随插件启用注册到 `PluginSystem.pluginExports`，键是 `manifest.name`（缺省时是文件名）。兼容旧写法 `export const exports = { ... }`，两者取其一即可。

只有**已启用**的插件才会被注册。

---

## 3. 生命周期与钩子

所有钩子的前三个参数固定为 `(oj, db, getPluginExports)`，后续参数按钩子不同：

| 钩子 | 触发时机 | 完整参数 | 返回值 |
|------|----------|----------|--------|
| `onLoad` | 插件加载且处于启用状态时 | `(oj, db, getPluginExports)` | 忽略 |
| `onRoute` | `onLoad` 之后、加载阶段执行 | `(oj, db, getPluginExports, app)` | 忽略 |
| `injectHeader` | 每个 HTTP 请求 | `(oj, db, getPluginExports, req)` | HTML 字符串 |
| `injectFooter` | 每个 HTTP 请求 | `(oj, db, getPluginExports, req)` | HTML 字符串 |
| `beforeJudge` | 评测开始前 | `(oj, db, getPluginExports, submission)` | 可修改 `submission` |
| `afterJudge` | 评测结束、结果落库前 | `(oj, db, getPluginExports, submission)` | 可修改 `submission` |

补充说明：

- **`onRoute` 的 `app` 就是 `oj.app`**，它是 plugin 进程内部的 `App` 实例。注册的路由由 http 进程反向代理对外提供（第 8 节），不需要修改核心代码。
- **`injectHeader` / `injectFooter`** 在 http 进程每次请求时通过 IPC 调用。传入的 `req` 是请求快照，包含：
  - `method`、`path`、`url`、`query`、`cookies`、`params`
  - `headers`（`Headers` 对象）
  - `user`（已登录用户，含 `id` / `username` / `role`）
  
  不包含请求体、`res`、`app`。返回值按插件拼接后写入 `res.locals.pluginHeader` / `pluginFooter`，最终由 `views/partials/header.ejs`、`footer.ejs` 输出到所有页面。多个插件的片段以换行分隔；返回非字符串或空串会被忽略。
- **`beforeJudge` / `afterJudge`** 在 judge 进程触发，提交对象经 IPC 传给 plugin 进程。插件对 `submission` 的修改会经 IPC 返回，并在 `afterJudge` 之后写回数据库——修改 `status`、`errorInfo`、`caseResults` 等字段会**真正生效**，请谨慎。
- `emit()` 会遍历所有已启用插件；**单个插件抛错只会记录日志**，不会中断其它插件或主流程。
- 当前实现**不会**调用 `onDisable`。禁用插件会导致 plugin 进程重建 App 与 `PluginSystem`，所有插件模块实例和内存状态都会被丢弃。清理逻辑请放在 `onLoad` 中，并保证可重复执行。

### 3.1 权限错误的表现

- `onLoad` / `onRoute` 中触发权限错误：该插件加载失败，日志打印 `Failed to load <file>`，插件不会出现在可用列表里。
- `emit()` 触发的钩子中触发权限错误：日志打印 `hook <name> failed in <plugin>`，本次调用被跳过。

---

## 4. oj / db 对象

### 4.1 oj

| 属性 | 说明 | 是否需要权限 |
|------|------|--------------|
| `oj.app` | plugin 进程内的 HTTP 应用实例，用于注册路由、挂中间件 | 否 |
| `oj.config` | 应用配置对象（端口、目录、版本等） | 否 |
| `oj.logger` | 插件专属 logger（模块名由插件名推导，见第 9 节） | 否 |
| 其它属性 | 目前没有其它属性；未来新增属性需要 `oj_access` | 是 |

`oj.db` 虽然存在，但访问它需要 `oj_access`。**推荐直接使用钩子的第二个参数 `db`**。

### 4.2 db

数据库访问**全部异步**，由 `lib/database.ts` 提供三个方法：

| 方法 | 签名 | 说明 |
|------|------|------|
| `db.query` | `(sql, params?) => Promise<Row[]>` | 查询多行 |
| `db.queryOne` | `(sql, params?) => Promise<Row \| undefined>` | 查询单行 |
| `db.execute` | `(sql, params?) => Promise<{ lastInsertRowid, changes }>` | 执行写入 |

- 占位符统一用 `?`，MySQL / PostgreSQL 的方言差异由驱动层处理。
- plugin 进程没有数据库连接，`db` 调用经 IPC 转到 db 进程执行，**必须 `await` 并处理异常**。
- 不存在 `db.get` / `db.all` / `db.each` / `db.run` 这类回调式 API。

```javascript
const rows = await db.query('SELECT id, username FROM users LIMIT 5');
const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [id]);
const { lastInsertRowid } = await db.execute(
    'INSERT INTO my_plugin_logs (message) VALUES (?)',
    ['hello']
);
```

---

## 5. 权限模型

权限是 `manifest.permissions` 中的字符串数组，通过代理对象在**每次访问时**检查。

### 5.1 数据库权限

`db` 代理按方法名判断读写：

- 方法名以 `get` / `all` / `each` 开头 → 读取，需要 `read_db`；
- 其它方法 → 写入，需要 `write_db`。

当前 `db` 只暴露 `query` / `queryOne` / `execute`，三者都不以 `get` / `all` / `each` 开头，**实际都要求 `write_db`**。`read_db` 仅为兼容历史方法名保留。需要访问数据库的插件建议同时声明：

```javascript
export const manifest = {
    // ...
    permissions: ['read_db', 'write_db']
};
```

### 5.2 oj 权限

- `app`、`config`、`logger` **始终可访问**；
- 访问其它属性需要 `oj_access`。

### 5.3 拒绝时的行为

```text
Unauthorized action: write_db
Unauthorized action: oj_access
```

同时日志会打印一条 `plugin attempted unauthorized action: <权限名>` 的 WARN。

### 5.4 安全边界

权限代理只约束通过 `oj` / `db` 的访问。插件与宿主同权限运行，可以直接 `import('fs')` 读写文件、发起网络请求、修改全局对象。**安装插件等于信任其作者**。

plugin 进程带来了故障隔离（崩溃不会带走 http / judge），但**不构成恶意代码隔离**。

---

## 6. 配置持久化与插件状态

外部插件状态保存在数据库表 `plugin_configs`（启动时自动建表）：

| 列 | 说明 |
|----|------|
| `filename` | 插件文件名，主键，如 `my-plugin.js` |
| `enabled` | `1` 启用 / `0` 禁用 |
| `token` | 插件令牌，`crypto.randomBytes(16)` 生成的 32 位十六进制字符串，全局唯一 |
| `permissions` | 已授予权限的 JSON 数组字符串 |

首次加载某个插件时：

1. 无记录 → 生成令牌，`enabled = 0`（**默认禁用**），`permissions = manifest.permissions`（自动授予）；
2. 写入数据库。

之后每次加载**以数据库为准**：修改 `manifest.permissions` 不会自动更新已授予权限。需要重新同步时，删除该插件的 `plugin_configs` 记录（或删除插件后重装），下次加载会按新 manifest 重新授予。

### 内置插件

内置插件位于 `lib/builtin_plugins/`（当前只有 `db-monitor`）：

- 显示名为 `builtin:db-monitor`，令牌固定为 `builtin:db-monitor`；
- 权限始终取 manifest；
- 是否启用由环境变量 `ENABLED_BUILTIN_PLUGINS`（逗号分隔，默认 `db-monitor`）决定；
- 管理界面可以在运行时切换，但**该切换只存在于 plugin 进程内存中**：重启或 plugin 进程崩溃重建后会按环境变量重新计算；
- 内置插件**不能删除**。

### plugin 进程崩溃后的恢复

broker 会自动重启 plugin 进程：

- 外部插件的启用状态从 `plugin_configs` 恢复；
- 内置插件的启停回到 `ENABLED_BUILTIN_PLUGINS` 的默认值；
- 插件路由服务器会换一个新的随机端口，http 进程在下次代理失败时会自动重新获取端口；
- 重启期间页面注入为空、判题钩子被跳过，但不会拖垮 http / judge。

### 加载失败的文件

加载失败的 `.js` 仍会出现在 `getList()` 中，名称显示为 `Unknown/Error`、状态禁用，便于管理员发现；修复后重新加载即可。

---

## 7. 插件间通信

插件都在同一个 plugin 进程中，通过 `pluginExports` + `getPluginExports(name)` 通信：

```javascript
// math-utils.js
export const manifest = { name: 'math-utils' };
export const pluginExports = {
    add: (a, b) => a + b
};

// consumer.js
export const manifest = { name: 'consumer' };
export function onLoad(oj, db, getPluginExports) {
    const utils = getPluginExports('math-utils');
    if (utils && typeof utils.add === 'function') {
        oj.logger.info(`1 + 2 = ${utils.add(1, 2)}`);
    }
}
```

- 键是 `manifest.name`；找不到时返回 `undefined`，务必先判断。
- 只有**已启用**插件会被注册。
- 加载顺序按文件名排序，**不要假设依赖的插件先加载完毕**。必要时在后续钩子（如 `injectHeader`、`beforeJudge`）里再按需获取。

---

## 8. 插件 HTTP 路由与热更新

### 8.1 请求链路

plugin 进程启动时会在 `127.0.0.1` 上监听一个**随机端口**的内部 HTTP 服务器：

- 只监听回环地址，外部无法直接访问；
- 请求必须携带 plugin 进程启动时生成的随机令牌（`x-dwoj-internal-token`），否则返回 403；
- 服务器用当前的插件 `App` 处理请求，`onRoute` 注册的路由都在这里。

http 进程的请求顺序：

1. 核心中间件与核心路由（`routes/`）；
2. 若核心路由没有返回响应，把请求反向代理到 plugin 路由服务器；
3. 插件路由也没有命中时返回 404。

因此：

- **核心路由优先**：插件不能覆盖 `/problem`、`/admin` 等已有路径；
- 插件可以自由注册 `/my-plugin/...` 等新路径；
- 插件路由能拿到 `req.user`（http 进程会把已登录身份转发过来）；
- 插件路由的**访问权限由系统自动校验**（见 8.2），不需要手写登录判断；
- 插件路由拿不到核心的 `res.locals`（如 `ROLE_LV`、`renderMarkdown`）；使用 `res.render` 时请自行准备数据。

### 8.2 路由鉴权

插件通过 `app.get/post/put/delete` 注册路由时，系统会自动套上统一的鉴权规则：

| 路由 | 访问要求 |
|------|----------|
| `/admin` 与 `/admin/*` | **强制** `super_user`，插件的任何声明都无法降低 |
| 其它路由，未声明权限 | 默认**已登录**（`default`） |
| 其它路由，显式声明 | 按声明的角色或 `public` |

声明方式是在路径后、处理函数前传入一个选项对象：

```javascript
export function onRoute(oj, db, getPluginExports, app) {
    // 默认：登录即可访问
    app.get('/my-plugin/list', (req, res) => res.json({ user: req.user.username }));

    // 显式要求管理员
    app.get('/my-plugin/manage', { permission: 'super_user' }, (req, res) => {
        res.send('manage');
    });

    // 显式公开（匿名可访问）
    app.get('/my-plugin/ping', { permission: 'public' }, (req, res) => {
        res.json({ ok: true });
    });

    // 也可以写在多个处理函数之前
    app.get('/my-plugin/root', { permission: 'root' }, middleware, handler);
}
```

- 可选值：`public`、`default`、`super_user`、`root`；其它值会在插件加载时直接报错。
- 未登录返回 `401`（`请先登录`）；已登录但角色不足返回 `403`（`权限不足`）。
- **权限只随本次注册生效**：插件不能为没有注册的路径声明权限。若同方法 + 同路径模板已被核心路由或其它插件注册，注册会抛错，该插件本次加载失败并被标记为禁用，因此也无法改写别人的访问策略。
- 通过 `app.use(router)` 挂载的子路由会自动归属当前插件并走默认“已登录”策略（请先向 Router 注册路由，再挂载）；子路由暂不支持逐条声明 `permission`。
- 插件不能调用 `app.defineRoute` / `app.setRouteGuard` / `app.setNotFoundHandler`，也不能访问 `app._router` / `app._settings`；`app.set('routeGuard', ...)` 会被拒绝。
- 单进程模式下守卫排在登录中间件之后执行，同样能拿到 `req.user`。

### 8.3 热更新

**可以热更新。** 启用/禁用/上传/删除插件时，plugin 进程会：

1. 重新创建一个全新的 `App`（相当于清空路由表）；
2. 重新创建 `PluginSystem` 并 `loadAll()`（重新执行所有启用插件的 `onLoad` / `onRoute`）；
3. 原子地替换当前使用的 `App` 引用。

插件路由服务器始终通过 `current.app.handle(request)` 分发请求，因此替换后**新路由立即生效，旧路由同时失效**，不需要重启任何进程，也不会出现重复注册。

覆盖范围：

| 变化 | 是否即时生效 |
|------|--------------|
| 插件新增/修改/删除 HTTP 路由 | 是 |
| 插件页面注入（header/footer） | 是 |
| `beforeJudge` / `afterJudge` 钩子 | 是（judge 每次都走 IPC） |
| 修改插件 manifest 权限 | 否（以数据库已授予权限为准，见第 6 节） |
| 修改 `.js` 文件但不触发管理操作 | 否（需上传或调用重新加载） |

### 8.4 代理的边界

- 支持的方法：所有 HTTP 方法；
- 请求体：`application/json`、`application/x-www-form-urlencoded`、`multipart/form-data`（含文件）会被重建后转发；其它 `Content-Type` 按空 body 转发；
- 响应：状态码、响应头、`Set-Cookie` 与响应体都会回传，但响应体会先完整读入内存（不支持流式/SSE/WebSocket）；
- 每个页面请求都会额外产生一次 `inject` IPC 调用，插件应在注入钩子里避免慢查询。

---

## 9. 日志

插件不需要自己注册 logger。`Plugin` 包装器会用插件名创建一个专属 logger，通过 `oj.logger` 暴露：

- 模块名来源：优先 `manifest.name`，否则用文件名；去掉 `builtin:` 前缀后规整为**小写、只保留字母数字/下划线、最多 6 个字符**；推导不出时回退为 `plugin`。
  - `db-monitor` → `[dbmon]`
  - `my-plugin` → `[myplu]`
  - 无 `manifest.name` 的 `hello-plugin.js` → `[hello]`
- 访问 `oj.logger` 不需要权限。
- 输出格式：`[等级][模块] 时间 信息`

```javascript
export const manifest = { name: 'hello-plugin' };

export function onLoad(oj) {
    oj.logger.info('plugin initialized');
    oj.logger.warn('something looks off');
    oj.logger.error('failed to do X', new Error('boom'));
}
```

```text
[INFO][hello]  2026-11-25T10:24:50.316Z plugin initialized
[WARN][hello]  2026-11-25T10:24:50.317Z something looks off
[ERRO][hello]  2026-11-25T10:24:50.318Z failed to do X (boom)
```

日志写入统一的 `log/app_<时间戳>.log`。plugin 进程的日志经 IPC 交给 broker 打印：INFO 走 stdout，WARN / ERRO 走 stderr。

---

## 10. 与旧版文档的差异

| 旧文档 | 当前实现 |
|--------|----------|
| 插件使用 `module.exports = { ... }` | 推荐 `export const manifest` / `export function onLoad ...`（CommonJS 仍兼容） |
| `db.all` / `db.get` / `db.each` / `db.run`（回调式） | `await db.query` / `await db.queryOne` / `await db.execute`（Promise） |
| 钩子 `onProblemSubmit` | 不存在，不会触发 |
| 钩子 `onUserRegister` | 不存在，不会触发 |
| `beforeJudge(oj, db, getPluginExports, submissionId)` | 参数改为完整提交对象 `submission` |
| `afterJudge(oj, db, getPluginExports, submissionId, result)` | 参数改为完整提交对象 `submission` |
| 插件在 http / judge 进程里各自加载 | 只在独立 plugin 进程中加载一份 |
| 启用/禁用后需重启才能让路由或 judge 钩子生效 | 即时生效（路由可热更新） |
| 插件路由注册在主应用上 | 注册在 plugin 进程的内部路由服务器，由 http 反代 |
| 插件路由需要自己校验登录/角色 | 系统自动鉴权：`/admin/*` 强制管理员，其余默认已登录 |
| 权限检查由 `permissionToCheck` 灵活定义 | 内部实现细节，插件侧按第 5 节声明权限即可 |

---

## 11. 管理界面与运维

入口：登录 `super_user` 或 `root` → 管理面板 → 插件管理（`/admin/plugins`）。

| 功能 | 路由 | 说明 |
|------|------|------|
| 列表 | `GET /admin/plugins` | 展示文件名、名称/版本、描述、启用状态；内置插件带「内置」标记 |
| 上传 | `POST /admin/plugins/upload` | 仅接受 `.js`；同名文件覆盖；上传后触发 plugin 进程重新加载 |
| 启用/禁用 | `POST /admin/plugins/toggle` | 更新状态并重建插件；路由与钩子即时生效 |
| 删除 | `POST /admin/plugins/delete` | 删除文件与 `plugin_configs` 记录；内置插件不可删除 |

说明：

- 这些操作在 http 进程发起，通过 IPC 交给 plugin 进程执行，因此**不再需要重启服务**。
- 每次重建都会重新执行所有已启用插件的 `onLoad` / `onRoute`，插件初始化逻辑必须幂等。
- `ENABLED_BUILTIN_PLUGINS` 只影响内置插件，逗号分隔；设为空字符串可禁用全部内置插件。
- 如果 plugin 进程启动失败，broker 会不断重启它；管理页面的列表请求会返回错误，具体原因见日志。

---

## 12. 完整示例插件

```javascript
// plugins/visit-counter.js
// 统计访问次数并在页面底部显示；提交评测时记录日志。

export const manifest = {
    name: 'visit-counter',
    description: '页面访问计数与评测日志示例',
    version: '1.0.0',
    permissions: ['read_db', 'write_db']
};

export async function onLoad(oj, db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS visit_counter (
            id INTEGER PRIMARY KEY,
            count INTEGER NOT NULL
        )
    `);
    const row = await db.queryOne('SELECT count FROM visit_counter WHERE id = 1');
    if (!row) {
        await db.execute('INSERT INTO visit_counter (id, count) VALUES (1, 0)');
    }
    oj.logger.info('visit-counter ready');
}

export function onRoute(oj, db, getPluginExports, app) {
    // 默认：登录即可访问
    app.get('/plugin/visits', async (req, res) => {
        const row = await db.queryOne('SELECT count FROM visit_counter WHERE id = 1');
        res.json({ visits: row ? row.count : 0 });
    });

    // 显式要求管理员（也可写成 { permission: 'public' } 允许匿名）
    app.get('/plugin/visits/admin', { permission: 'super_user' }, async (req, res) => {
        const row = await db.queryOne('SELECT count FROM visit_counter WHERE id = 1');
        res.json({ visits: row ? row.count : 0, operator: req.user.username });
    });
}

export async function injectFooter(oj, db, getPluginExports, req) {
    try {
        await db.execute('UPDATE visit_counter SET count = count + 1 WHERE id = 1');
    } catch (err) {
        oj.logger.error('failed to bump counter', err);
    }
    return '<div class="text-center text-muted small py-2">由 visit-counter 插件渲染</div>';
}

export function beforeJudge(oj, db, getPluginExports, submission) {
    oj.logger.info(`judging submission ${submission.id} (problem ${submission.problemId})`);
}

export function afterJudge(oj, db, getPluginExports, submission) {
    oj.logger.info(`submission ${submission.id} -> ${submission.status}`);
}

export const pluginExports = {
    formatCount: (count) => `${count} 次访问`
};
```

安装：把文件放到 `plugins/`（或通过管理后台上传），在插件管理页启用即可：

- `/plugin/visits` 立即可以访问（http 反代到 plugin 进程）；
- 页面底部立即出现注入内容；
- 评测日志立即开始输出。

---

## 13. 限制与注意事项

1. **只扫描 CommonJS 或 ESM 的 `.js` 文件**，不支持 `.ts`、目录插件。
2. **插件路由不能覆盖核心路由**：只有核心路由未命中时才会反代到插件。
3. **插件路由的鉴权由系统自动完成**：`/admin/*` 强制管理员，其余默认已登录；不能通过同名路径改写核心或其它插件路由的权限。
4. **不支持流式响应与 WebSocket / SSE**：插件响应会整体读入内存后返回。
5. **页面注入钩子每个请求都会经 IPC 执行**：不要在里面做慢查询或网络请求。
6. **`afterJudge` 对 `submission` 的修改会落库**，误改 `status` 等字段会影响评测结果。
7. **启用/禁用会重建插件**：所有插件的 `onLoad` 会重新执行，内存状态丢失；初始化必须幂等。
8. **内置插件的管理界面开关只存在内存中**：plugin 进程重建或重启后回到 `ENABLED_BUILTIN_PLUGINS`。
9. **修改 manifest 权限不会自动生效**：以 `plugin_configs.permissions` 为准。
10. **plugin 进程不是安全沙箱**：插件与宿主同权限，安装插件等于信任作者；令牌只用于内部路由鉴权，不要在页面或日志中泄露。
