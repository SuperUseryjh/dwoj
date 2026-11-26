# 插件系统文档

本文档描述 DWOJ 重构后的插件 API。旧版 `manifest + 命名导出 + pluginExports` 写法、CommonJS 插件与 `read_db / write_db / oj_access` 权限**已不再支持**，迁移请见第 12 节。

相关实现：

- `lib/plugin/manager.ts`：加载、生命周期、钩子、管理操作
- `lib/plugin/loader.ts`：ESM 加载与定义校验
- `lib/plugin/permissions.ts`：数据库权限
- `lib/plugin/routes.ts`：插件路由与鉴权
- `lib/plugin/service.ts`：plugin 子进程与内部路由服务器
- `lib/plugin/host.ts`：http / judge 侧的插件宿主客户端

## 目录

1. [架构概览](#1-架构概览)
2. [插件文件格式](#2-插件文件格式)
3. [插件定义字段](#3-插件定义字段)
4. [生命周期与状态](#4-生命周期与状态)
5. [PluginContext](#5-plugincontext)
6. [权限模型](#6-权限模型)
7. [插件路由与鉴权](#7-插件路由与鉴权)
8. [钩子](#8-钩子)
9. [插件间通信](#9-插件间通信)
10. [日志](#10-日志)
11. [管理界面与运维](#11-管理界面与运维)
12. [从旧版迁移](#12-从旧版迁移)
13. [完整示例](#13-完整示例)
14. [限制与注意事项](#14-限制与注意事项)

---

## 1. 架构概览

插件运行在独立的 **plugin 子进程** 中，http / judge 进程不加载任何插件代码。

```text
        ┌──────────────── broker (app.ts) ────────────────┐
        │ 拉起子进程 · 按 {to} 转发 NDJSON · 崩溃重启      │
        └──┬──────────────┬──────────────┬───────────────┘
           │              │              │
    ┌──────▼─────┐  ┌─────▼──────┐  ┌────▼──────┐  ┌────▼──────┐
    │     db     │  │   plugin   │  │   http    │  │   judge   │
    │ 唯一数据库 │  │ 加载插件   │  │ 路由/页面 │  │ 评测队列  │
    └────────────┘  │ 钩子 + 路由│  │ 反代插件  │  └───────────┘
                    └─────┬──────┘  └────▲──────┘
                          │ 私有 HTTP 端口│
                          └───────────────┘
```

- 启动顺序：db → plugin → http / judge。
- plugin 进程加载插件、执行 `setup` 与全部钩子，并在 `127.0.0.1` 的随机端口上承载插件路由。
- http 进程未命中核心路由时，把请求反向代理到 plugin 进程；核心路由始终优先。
- judge 进程通过 IPC 调用 `beforeJudge` / `afterJudge`。
- 启用/禁用/上传/删除插件会重建 plugin 进程内的 `App + PluginManager`，路由与钩子即时生效，无需重启。

单进程模式（`DWOJ_SINGLE_PROCESS=1`）下没有 plugin 子进程，`PluginManager` 直接在主进程内工作，插件路由挂在主应用上（仍排在核心路由之后）。

---

## 2. 插件文件格式

插件放在 `plugins/` 目录，文件名以 `.js` 结尾，**只支持 ES Module**，必须默认导出一个定义对象：

```javascript
export default {
    name: 'hello-plugin',
    version: '1.0.0',
    description: '最小示例',
    permissions: ['db:read'],

    async setup(ctx) { /* 启动时执行一次 */ },

    routes(router, ctx) {
        router.get('/hello/ping', (req, res) => res.json({ ok: true }));
    },

    hooks: {
        injectFooter(req, ctx) {
            return '<div class="small text-muted">hello-plugin</div>';
        }
    },

    api: {
        greet: () => 'hello'
    }
};
```

- 不支持 `.ts`、目录插件、`module.exports`；检测到 CommonJS 会直接报错并提示迁移。
- 定义对象只允许 `name / version / description / permissions / setup / routes / hooks / api`，拼错或新增未知顶层字段会直接加载失败。
- 重载使用带时间戳的动态 `import()`，会绕过模块缓存。
- 插件代码与宿主同权限运行，不是安全沙箱。

---

## 3. 插件定义字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string，必需 | 插件名；同时作为 `ctx.plugins` 的键与日志模块名来源 |
| `version` | string | 默认 `1.0.0` |
| `description` | string | 管理界面展示 |
| `permissions` | `('db:read' \| 'db:write')[]` | 数据库权限；首次加载自动授予 |
| `setup` | `(ctx) => void \| Promise<void>` | 启用时执行一次；失败则插件进入 `error` |
| `routes` | `(router, ctx) => void \| Promise<void>` | 注册插件 HTTP 路由 |
| `hooks` | 对象 | 见第 8 节 |
| `api` | 对象 | 暴露给其它插件的功能 |

同一加载批次内插件名不能重复；重复时后加载的插件进入 `error`。

---

## 4. 生命周期与状态

每次加载（启动、启用/禁用、上传、删除、手动重载）执行：

1. 扫描外部 `.js` 文件并校验定义；
2. 追加内置插件；
3. 读取/创建 `plugin_configs` 记录（token、启用状态、权限）；
4. 为所有已启用插件注册 `api`（保证 `setup` 里可以互相访问）；
5. 依次 `await setup(ctx)`；
6. 依次 `await routes(router, ctx)`，成功后再把该插件的路由挂到应用上。

插件有三种状态：

| 状态 | 含义 |
|------|------|
| `enabled` | 加载成功，参与钩子与 `api` |
| `disabled` | 未启用 |
| `error` | 导入、校验、`setup` 或 `routes` 失败；不参与钩子/`api`，错误信息在管理界面可见 |

- 单个钩子抛错只记录日志，不会让插件变成 `error`，也不会影响其它插件。
- 失败的插件仍可通过管理界面禁用/再次启用重试。
- 当前没有 `onDisable` 钩子；禁用会直接卸载模块实例。

---

## 5. PluginContext

`setup`、`routes` 与所有钩子都会拿到 `ctx`：

| 属性 | 说明 |
|------|------|
| `ctx.name` | 插件名 |
| `ctx.logger` | 专属 logger（模块名 ≤6 字符） |
| `ctx.config` | 应用配置对象（只读使用） |
| `ctx.db` | 权限受控的数据库访问接口 |
| `ctx.plugins.get(name)` | 获取其它已启用插件的 `api`，不存在时返回 `undefined` |

数据库接口全部为异步：

```javascript
const rows = await ctx.db.query('SELECT id, username FROM users LIMIT 5');
const user = await ctx.db.queryOne('SELECT * FROM users WHERE id = ?', [id]);
const { lastInsertRowid } = await ctx.db.execute(
    'INSERT INTO plugin_logs (message) VALUES (?)',
    ['hello']
);
```

占位符统一使用 `?`，SQLite / MySQL / PostgreSQL 的差异由数据库层处理。

---

## 6. 权限模型

| 权限 | 允许的操作 |
|------|------------|
| `db:read` | `ctx.db.query`、`ctx.db.queryOne` |
| `db:write` | `ctx.db.execute` |

- `ctx.config`、`ctx.logger`、`ctx.plugins` 不需要权限。
- 未授权调用抛出 `Plugin permission denied: db:write`（或 `db:read`），并记录 WARN。
- 首次加载时把定义里的权限写入 `plugin_configs.permissions`；之后以数据库为准，修改定义不会自动扩权。
- 旧数据中的 `read_db` / `write_db` 会自动映射为 `db:read` / `db:write`，`oj_access` 会被丢弃。

---

## 7. 插件路由与鉴权

### 7.1 注册路由

```javascript
export default {
    name: 'my-plugin',
    routes(router, ctx) {
        // 未声明 auth：登录即可访问
        router.get('/my-plugin/list', (req, res) => {
            res.json({ user: req.user?.username ?? null });
        });

        // 显式要求管理员
        router.get('/my-plugin/manage', { auth: 'super_user' }, (req, res) => {
            res.send('manage');
        });

        // 显式公开（匿名可访问）
        router.get('/my-plugin/ping', { auth: 'public' }, (req, res) => {
            res.json({ ok: true });
        });
    }
};
```

`router` 支持 `get / post / put / delete`，可传多个处理函数（按顺序执行），处理函数签名与核心路由一致：`(req, res, next)`。路由路径必须以 `/` 开头；`ctx` 通过闭包使用。

### 7.2 鉴权规则

| 路由 | 要求 |
|------|------|
| `/admin` 与 `/admin/*` | **强制** `super_user`，声明无法降低 |
| 其它插件路由，未声明 `auth` | 默认已登录（`default`） |
| 其它插件路由，显式声明 | `public` / `default` / `super_user` / `root` |

- 未登录返回 `401 请先登录`；角色不足返回 `403 权限不足`。
- 鉴权在插件进程内、执行处理函数之前完成；http 进程会把已登录身份转发过来，因此 `req.user` 可用。
- 插件路由拿不到核心的 `res.locals`（如 `ROLE_LV`、`renderMarkdown`），使用 `res.render` 时请自行准备数据。
- 插件只能为自己注册的路径声明权限：同方法且路径模板会匹配同一请求（例如 `/x/:id` 与 `/x/foo`、`/x/:name`）时，与核心路由或其它插件冲突都会注册失败，插件进入 `error`。
- 插件只能通过 `PluginRouter` 注册路由，无法访问 `App` 内部结构。

### 7.3 热更新

每次插件状态变化都会重建路由表并原子替换，新增/修改/删除的路由立即生效，旧路由同时失效，不会重复注册。修改 `.js` 文件后需要触发一次上传/重载。

---

## 8. 钩子

`hooks` 对象支持四个钩子，全部支持 `async`，系统会按插件加载顺序依次 `await`：

| 钩子 | 签名 | 说明 |
|------|------|------|
| `injectHeader` | `(req, ctx) => string \| void` | 每个页面 `<head>` 后注入 HTML |
| `injectFooter` | `(req, ctx) => string \| void` | 每个页面底部注入 HTML |
| `beforeJudge` | `(submission, ctx) => void` | 评测开始前 |
| `afterJudge` | `(submission, ctx) => void` | 评测结束、结果落库前 |

- `req` 是请求快照：`method / path / url / query / cookies / params / headers(Headers) / user`，不包含请求体与 `res`。
- 多个插件的注入片段按加载顺序用换行拼接。
- `beforeJudge` / `afterJudge` 中可以直接修改 `submission`，修改结果会回传并写入数据库（`afterJudge` 之后落库）。
- 钩子抛错只记录日志，不影响其它插件或主流程。
- 没有 `onProblemSubmit` / `onUserRegister` / `onDisable`。

---

## 9. 插件间通信

通过 `api` + `ctx.plugins.get(name)`：

```javascript
// provider.js
export default {
    name: 'provider',
    api: {
        add: (a, b) => a + b
    }
};

// consumer.js
export default {
    name: 'consumer',
    setup(ctx) {
        const provider = ctx.plugins.get('provider');
        if (provider) ctx.logger.info(`1 + 2 = ${provider.add(1, 2)}`);
    }
};
```

- 所有启用插件的 `api` 会在任何 `setup` 之前注册，因此不依赖文件加载顺序。
- 只有 `enabled` 状态（非 `error`）的插件可见。
- 插件名重复时，后加载者进入 `error`。

---

## 10. 日志

插件无需注册 logger，直接使用 `ctx.logger`：

```javascript
export default {
    name: 'hello-plugin',
    setup(ctx) {
        ctx.logger.info('ready');
        ctx.logger.warn('something looks off');
        ctx.logger.error('failed', new Error('boom'));
    }
};
```

- 模块名：优先插件名，规整为小写、只保留字母数字/下划线、最多 6 个字符；推导不出时回退为 `plugin`。
  - `db-monitor` → `[dbmon]`
  - `my-plugin` → `[myplu]`
- 格式：`[等级][模块] 时间 信息`，写入 `log/app_<时间戳>.log`。
- plugin 进程的日志经 broker 统一打印：INFO 走 stdout，WARN / ERRO 走 stderr。

---

## 11. 管理界面与运维

入口：登录 `super_user` / `root` → 管理面板 → 插件管理（`/admin/plugins`）。

| 功能 | 说明 |
|------|------|
| 列表 | 显示文件名、名称/版本、描述、状态（运行中 / 已禁用 / 错误）；错误插件展示错误信息 |
| 上传 | 仅接受 `.js`；同名覆盖；上传后立即重载 |
| 启用/禁用 | 更新数据库状态并重建插件；路由与钩子即时生效 |
| 删除 | 删除文件与 `plugin_configs` 记录；内置插件不可删除 |

- 插件状态保存在 `plugin_configs(filename, enabled, token, permissions)`。
- 内置插件（`lib/builtin_plugins/`，当前为 `db-monitor`）由 `ENABLED_BUILTIN_PLUGINS`（逗号分隔）控制；管理界面的启停只存在于 plugin 进程内存中，重启/崩溃重建后回到环境变量默认值。
- plugin 进程崩溃后由 broker 自动重启，外部插件状态从数据库恢复，内置插件回到环境变量默认值，路由服务器更换新端口后 http 进程会自动重新获取。
- 每次重载都会重新执行所有启用插件的 `setup` / `routes`，初始化逻辑必须幂等。

---

## 12. 从旧版迁移

| 旧写法 | 新写法 |
|--------|--------|
| `export const manifest = {...}` | `export default { name, version, description, permissions }` |
| `export function onLoad(oj, db, g)` | `async setup(ctx)` |
| `export function onRoute(oj, db, g, app)` | `routes(router, ctx)`，使用 `router.get(...)` |
| `app.get(path, { permission }, h)` | `router.get(path, { auth }, h)` |
| `export function injectHeader(oj, db, g, req)` | `hooks.injectHeader(req, ctx)` |
| `export function injectFooter(...)` | `hooks.injectFooter(req, ctx)` |
| `export function beforeJudge(oj, db, g, sub)` | `hooks.beforeJudge(sub, ctx)` |
| `export function afterJudge(oj, db, g, sub)` | `hooks.afterJudge(sub, ctx)` |
| `export const pluginExports = {...}` | `api: {...}` |
| `getPluginExports(name)` | `ctx.plugins.get(name)` |
| `oj.logger` / `oj.config` | `ctx.logger` / `ctx.config` |
| `oj.db` / 参数 `db` | `ctx.db` |
| `read_db` / `write_db` | `db:read` / `db:write` |
| `oj_access` | 删除（`ctx` 只暴露安全 API） |
| `module.exports = {...}` | `export default {...}`（CJS 不再支持） |
| `onDisable` | 删除（从未被调用） |

旧插件在加载时会得到明确的错误信息（例如“不再支持 CommonJS 插件”），并在管理界面显示为 `error`。

---

## 13. 完整示例

```javascript
// plugins/visit-counter.js
export default {
    name: 'visit-counter',
    version: '1.0.0',
    description: '页面访问计数示例',
    permissions: ['db:read', 'db:write'],

    async setup(ctx) {
        await ctx.db.execute(`
            CREATE TABLE IF NOT EXISTS visit_counter (
                id INTEGER PRIMARY KEY,
                count INTEGER NOT NULL
            )
        `);
        const row = await ctx.db.queryOne('SELECT count FROM visit_counter WHERE id = 1');
        if (!row) {
            await ctx.db.execute('INSERT INTO visit_counter (id, count) VALUES (1, 0)');
        }
        ctx.logger.info('visit-counter ready');
    },

    routes(router, ctx) {
        router.get('/plugin/visits', async (req, res) => {
            const row = await ctx.db.queryOne('SELECT count FROM visit_counter WHERE id = 1');
            res.json({ visits: row ? row.count : 0 });
        });

        router.get('/plugin/visits/manage', { auth: 'super_user' }, async (req, res) => {
            const row = await ctx.db.queryOne('SELECT count FROM visit_counter WHERE id = 1');
            res.json({ visits: row ? row.count : 0, operator: req.user.username });
        });

        router.get('/plugin/visits/ping', { auth: 'public' }, (req, res) => {
            res.json({ ok: true });
        });
    },

    hooks: {
        async injectFooter(req, ctx) {
            try {
                await ctx.db.execute('UPDATE visit_counter SET count = count + 1 WHERE id = 1');
            } catch (err) {
                ctx.logger.error('failed to bump counter', err);
            }
            return '<div class="text-center text-muted small py-2">由 visit-counter 渲染</div>';
        },
        beforeJudge(submission, ctx) {
            ctx.logger.info(`judging #${submission.id}`);
        },
        afterJudge(submission, ctx) {
            ctx.logger.info(`#${submission.id} -> ${submission.status}`);
        }
    },

    api: {
        formatCount: (count) => `${count} 次访问`
    }
};
```

---

## 14. 限制与注意事项

1. **仅支持 ESM 的 `.js` 文件**；CommonJS、TypeScript、目录插件均不支持。
2. **插件路由不能覆盖核心路由**；与核心或其它插件同方法、且模板会匹配同一请求（含参数模板重叠）时注册失败。
3. **插件路由不提供核心 `res.locals`**；鉴权由系统自动完成，但渲染数据需自行准备。
4. **不支持流式响应、SSE、WebSocket**：插件响应会整体读入内存后返回。
5. **注入钩子每个请求都会经 IPC 执行**：不要在里面做慢查询或网络请求。
6. **`afterJudge` 修改 `submission` 会落库**，误改 `status` 等字段会影响评测结果。
7. **每次重载重新执行 `setup` / `routes`**：初始化逻辑必须幂等，禁用会丢失插件内存状态。
8. **修改 `permissions` 不会自动扩权**：以 `plugin_configs.permissions` 为准。
9. **plugin 进程不是安全沙箱**：插件与宿主同权限，安装插件等于信任作者。
