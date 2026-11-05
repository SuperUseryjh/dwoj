# dwoj-lite 优化计划（1 核 / 128 MB）

> 分支：`dwoj-lite`（fork 自 `9e75da4`）
> 目标：在 **1 vCPU / 128 MB** 的机器上稳定运行，功能以"够用"为准，允许裁剪非核心特性。
> 验收基线：空闲 RSS < 35 MB，判题峰值 ≤ 80 MB，不出现 OOM kill。

---

## 0. 现状与实测基线

| 场景 | 工作集 RSS（Windows / Bun 1.3.14，仅作相对参考） |
|---|---|
| 空 `Bun.serve` 最小服务 | ~69 MB |
| 本分支整站（idle，含 db-monitor 内置插件） | ~76 MB |
| main 分支多进程架构（http/db/judge 等 5 进程） | ~170 MB+ |

Linux 下 Bun 空载通常 25–40 MB，但**当前代码没有任何内存护栏**，以下路径在 128 MB 机器上是硬伤：

1. `controllers/judge.ts` 每个测试点 `spawn` 一个新进程；无内存限制、无输出上限；且 `runJudge()` **从未被调用**（见 §4，属于必须修的功能缺陷）。
2. `/status` 用 `SELECT *` 拉全表（含每行代码）+ 页面每 5 秒整页刷新。
3. EJS 每请求重新读文件并编译（`_viewCache` 声明了但没用）。
4. 静态资源每请求 `existsSync` + `statSync` 两次同步 syscall，无 `ETag`/`Cache-Control`。
5. 请求体无上限；`adm-zip` 把整个 zip 读进内存。
6. 启动即联网自更新（`axios` + `tar` 顶层加载，下载后覆盖自身代码）。
7. SQLite 未调参（WAL 无限膨胀、page cache 默认值）。
8. 日志每次启动新文件、同时写 stdout 与文件，无轮转。
9. `data/sandbox/` 160 MB 未被 git 跟踪，本分支无任何代码引用，纯占盘。

---

## 1. 决策总表

### 1.1 砍掉

| # | 砍什么 | 影响文件 | 收益 | 兼容处理 |
|---|---|---|---|---|
| C1 | **自动更新器**（`Updater` + `axios` + `tar`） | `lib/updater.ts`、`app.ts`、`config/index.ts`、`package.json` | 启动省 6–10 MB，去掉启动期 CPU/IO 风暴与"覆盖自身代码"风险 | 改为部署时 `git pull` / 镜像重发；README 说明 |
| C2 | **CLI**（`dwoj-cli.ts` 全部命令与 `bin` 入口） | `dwoj-cli.ts`、`package.json#bin`、CI `build` job、README | 少一个前端入口与依赖 | 用 systemd 常驻（`deploy/dwoj.service`）替代 `dwoj start` 后台化 |
| C3 | **`jsonwebtoken` 依赖** → 自签 HMAC-SHA256 cookie | `routes/auth.ts`、`middleware/global.ts` | 省 2–3 MB；每请求少一次三方库调用 | **已登录用户 cookie 一次性失效**（需重新登录） |
| C4 | **`fs-extra` 依赖** → 20 行原生 `fs` 工具 | 全项目 | 省 1–2 MB、启动 I/O 减少 | 语义等价（`ensureDir/emptyDir/move/remove/copy`） |
| C5 | **`markdown-it` 依赖** → 60 行极简渲染（段落/粗体/行内代码/链接/换行） | `middleware/global.ts` | 省 2–4 MB + 单核 CPU | 讨论区/题目描述排版略降级 |
| C6 | **`roles` 表 + `/admin/addRole` + 用户 tags 编辑**（三级角色固定为 `ROLE_LV`） | `lib/database.ts`、`routes/admin.ts`、`views/admin.ejs` | 少 1 表 2 处查询 | 旧表/旧列保留不动（不 `ALTER`、不 `DROP`），仅不再创建/编辑 |
| C7 | **`/status` 全量列表 + 5s 整页自动刷新** → 只取展示列 + 分页 50 + 手动刷新 | `routes/problem.ts`、`views/status.ejs` | **单核最大收益**：不再把全表 `code` 读进内存 | 加 `?page=`，刷新按钮；首屏语义不变 |
| C8 | **`data/sandbox/`（160 MB）、历史 `log/`、`plugin.md` 部署清理** | `.gitignore`、CI 打包脚本 | 纯占盘 | — |
| C9 | **内置插件 `db-monitor` 默认启用**（它给每次 DB 调用套计时 Proxy） | `lib/plugin_system.ts`、`lib/builtin_plugins/db-monitor.ts` | 每请求去掉一层包装 | 文件保留，仅 `ENABLED_BUILTIN_PLUGINS` 显式开启时加载 |

### 1.2 保留但简化

| # | 项 | 简化方式 |
|---|---|---|
| K1 | **插件系统（必须保留）** | 保留 `.js` 插件加载、`manifest`、`onRoute`/`onLoad`/`injectHeader` 等钩子、`/admin/plugins` 管理页、启停/删除/上传；**去掉权限 Proxy 与 token 鉴权**（直接传 `oj`/`db`），插件启停状态从 `plugin_configs` 表迁到 `plugins/config.json`，`emit` 仅在存在启用插件时遍历，启动时预计算静态注入内容；上传限 256 KB |
| K2 | 判题 | 保留 Python / Node(bun) 两种语言，**修好调用链 + 单飞队列 + 资源限制**（详见 §4） |
| K3 | 测试点 zip 上传 | 保留 `adm-zip`，改惰性 `import()` + 20 MB 上限 + 413 |
| K4 | EJS | 模板只读一次，`ejs.compile(..., {cache:true})` 缓存到 `_viewCache` |
| K5 | 静态资源 | 启动时建索引 + `ETag`/`Last-Modified` + `Cache-Control: max-age=86400` + 304 |
| K6 | 讨论区 | 功能保留，markdown 降级（C5） |
| K7 | SQLite | 保留，降级配置 + 大字段外置（详见 §3） |
| K8 | 日志 | 按大小轮转 5×5 MB，生产只写文件（`DWOJ_LOG_CONSOLE=1` 才回显） |
| K9 | 配置 | 新增 `DWOJ_LOWMEM=1` 开关驱动默认值（判题并发 1、每页 50、静态强缓存、console 关闭）；不设置时行为尽量贴近现状 |

### 1.3 明确不做

- 不采用 main 分支的多进程 IPC 架构（≈170 MB，128 MB 机器上不可行）。
- 不接入 v86 沙箱（常驻 60–100 MB）。
- 不做 gzip 压缩（1 核上 CPU 换不来收益）、不引入 Redis / 外部 DB。

---

## 2. 依赖收敛

| 现在 | dwoj-lite |
|---|---|
| `adm-zip, axios, ejs, fs-extra, jsonwebtoken, markdown-it, tar` | **`ejs, adm-zip`** |

`bun.lock` 同步瘦身；`devDependencies` 保留 `@types/*`、`typescript`、`@types/bun`（删除对应已移除库的 `@types`）。

运行时：`bun --smol app.ts`（低内存 GC 模式），`package.json` 增加 `start:lowmem` 并作为线上启动方式。

`Bun.serve` 增加：`maxRequestBodySize: 8 * 1024 * 1024`、`development: false`、`idleTimeout: 30`。

---

## 3. 存储层：SQLite 是否替换？

### 结论：**保留 `bun:sqlite`，做"瘦身 + 大字段外置"，同时把访问层抽成可替换接口。**

理由（按 1c128M 场景评估）：

| 方案 | 内存 | 1 核 CPU | 风险 | 结论 |
|---|---|---|---|---|
| `bun:sqlite`（现状，调参后） | page cache 可控到 **256 KB–1 MB**，WAL `mmap_size=0` | 优（C++ 内嵌、prepared statement） | 低 | **采用** |
| 全量 JSON 单文件（lowdb 式） | 整个库进堆：1 万条提交含代码 ≈ 20–50 MB | 每次写重写整文件 | 崩溃易丢数据 | 否决 |
| JSONL 追加 + 元数据索引 | 索引 ∝ 记录数（10 万条 ≈ 20 MB） | 冷数据需扫盘 | 中 | 仅作可选后端 |
| 目录式（一提交一文件） | 低 | 列表页需扫描目录 | 高 | 否决 |

换掉 SQLite 实际只省下内嵌库的二进制占用（约 1–2 MB），却会把内存曲线从"常数"变成"随数据增长"，与 128 MB 目标相悖。

### 具体动作

1. `lib/database.ts` 抽出稳定接口 `query / queryOne / execute / transaction`，内部保持 `bun:sqlite` 实现（现有 3 个函数签名不变，插件 API 不受影响）。
2. 降级 pragma（`DWOJ_LOWMEM=1`）：
   ```sql
   PRAGMA journal_mode = DELETE;      -- 不用 WAL，避免 -wal/-shm 双文件与 checkpoint
   PRAGMA synchronous = OFF;          -- 允许崩溃丢最后若干写（"能跑就行"）
   PRAGMA cache_size = -256;          -- 256 KB page cache
   PRAGMA mmap_size = 0;              -- 不计入 cgroup
   PRAGMA temp_store = FILE;
   PRAGMA locking_mode = NORMAL;
   ```
3. **大字段外置**：`submissions.code`、`problems.description`、`threads.content`、`threads.replies` 超过 4 KB 时写入 `data/blobs/<表>/<id>.txt` / `.json`，DB 内只存引用（`@blob:<path>`）；读取层在 `query/queryOne` 后统一解引用，业务代码无感。收益：DB 文件与 page cache 恒定，列表查询永不触碰大字段。
4. 新增 `CREATE INDEX IF NOT EXISTS`：`submissions(problemId,id)`、`threads(nodeId,id)`。
5. **迁移**：启动时 `PRAGMA table_info(submissions)` 检查，缺 `errorInfo` 则 `ALTER TABLE submissions ADD COLUMN errorInfo TEXT`（现行 judge 会 `UPDATE ... errorInfo = ?`，但表里没有该列 → 一旦启用判题必抛错）。
6. 可选后端（P4，非默认）：`lib/store/jsonl.ts`，实现同一接口；`DWOJ_STORE=jsonl` 时启用。仅当实测 SQLite 在目标机出现问题时使用，不投入额外工期。

---

## 4. 判题修复（功能缺陷，必做）

### 4.1 现存问题

| # | 问题 | 位置 |
|---|---|---|
| J1 | **`runJudge()` 没有任何调用点**：`/submit` 只写 `Pending` 就跳转，状态永远不动 | `routes/problem.ts:submit` |
| J2 | `UPDATE submissions SET ... errorInfo = ?`，但表里**没有 `errorInfo` 列** → 判题一跑就抛错 | `controllers/judge.ts:75`、`lib/database.ts:93` |
| J3 | 每个测试点 `spawn` 一次解释器（bun/python 各 20–30 MB），无并发控制 | `controllers/judge.ts:executeCode` |
| J4 | 无内存/输出上限，`console.log` 死循环可吃光内存 | 同上 |
| J5 | `child.kill()` 只杀直接子进程，孙进程存活 | 同上 |
| J6 | 缺少 `.out` 的测试点被 `continue` 跳过，却仍与 `inputs.length` 比较 → 误判 Accepted | `controllers/judge.ts:52` |
| J7 | 每个测试点 `readFileSync` 全量输入/输出，大测试点导致内存峰值 | 同上 |
| J8 | 整场无总时限；单点 2s 超时后即 `reject` 结束整场，无逐点结果 | 同上 |
| J9 | 临时文件写入 `uploads/`，异常路径可能残留 | 同上 |

### 4.2 目标设计

```
routes/problem.ts  POST /submit
        │  入库(status=Pending) → queue.push(id) → 302 /status
        ▼
lib/judge/queue.ts        单飞 FIFO，concurrency = 1，长度上限 50（超出直接拒绝提交）
        │  启动时 recover()：把 Pending / 遗留 Running 重新入队
        ▼
lib/judge/runner.ts       runJudge(id)（保留 controllers/judge.ts 作为薄封装，导出名不变）
        │
        ├─ 发现测试点：problems_data/<pid>/*.in，配同名 .out；无配对 → 该点跳过并计为 Data Error
        ├─ data/judge_tmp/<uuid>/ 临时目录（结束必删）
        └─ 每个测试点：spawn 1 个进程
              sh -c 'ulimit -v 262144 -t 5 -f 8192; exec <runtime> <file>'
              python3 -I -S（python） / bun --smol（node）
              stdin = Bun.file(inPath)（流式，不读进内存）
              stdout 累计 > 1 MB → kill → 该点 OLE
              退出码 ≠ 0 → 该点 RE，errorInfo = stderr（截断 2 KB）
              detached 进程组 + process.kill(-pid) 保证孙进程一起死
```

判定与状态（保持现有 UI 语义）：

- 每点结果 `{ name, status: AC|WA|RE|TLE|OLE, timeMs }` 写入 `caseResults`（截断 500 条）。
- 全 AC → `Accepted`；含 WA → `Wrong Answer`；含 RE/TLE/OLE → `Runtime Error`（`errorInfo` 记录首个失败原因）。
- 单点时限 2 s（保持原值），整场上限 10 s；整场结束一次性写库，避免逐点写盘。
- 队列 `finally` 释放，`drain()` 处理下一个。

### 4.3 验收用例（`tests/judge.test.ts`，无 python3 时 `test.skip`）

| 用例 | 期望 |
|---|---|
| AC 提交（回显输入） | `Accepted`，全部 case `AC` |
| WA 提交 | `Wrong Answer` |
| 死循环 | `Runtime Error`，`errorInfo` 含 TLE，进程组已回收，耗时 ≤ 3 s |
| 10 MB 输出 | `Runtime Error`（OLE），RSS 峰值 < 80 MB |
| 缺 `.out` 的题 | `Data Error`，不误判 AC |
| 服务重启后 | `Pending`/`Running` 自动恢复执行 |

---

## 5. HTTP / 渲染热路径

1. **模板缓存**（K4）：`renderView` 走 `_viewCache`，首次 `fs.readFileSync` + `ejs.compile({cache:true, filename})`。
2. **路由预编译**：现在每请求重建 `allMiddleware` 并递归 `push`，改为启动时摊平成 `[{prefix, regex, handler}]` + 404 快路径；`App.static` 走索引而非 `existsSync/statSync`。
3. **请求体限额**：`Bun.serve({ maxRequestBodySize })` 之外，再在 `_handleRequest` 前置检查 `Content-Length`（urlencoded 256 KB / multipart 8 MB），超限 413。
4. **鉴权**（C3）：`token = base64(payload).hmacSHA256`，payload 含 `{id, username, role, exp}`；`middleware/global.ts` 校验签名后直接用 token 内的用户信息，`isBanned` 走 5 s TTL 的 32 条 LRU 复查 → 每请求 0 次 DB 查询（现状每请求 1 次）。
5. **`/status`**（C7）：`SELECT id, problemId, username, language, status, time ... ORDER BY id DESC LIMIT ? OFFSET ?`；`COUNT(*)` 单独轻查询；页面分页 + 手动刷新。
6. **日志**（K8）：按大小轮转；`logger.info` 不再双写 stdout。
7. **Updater 移除后**：`app.ts` 启动只做目录校验 + DB 迁移 + 队列恢复，不联网。

---

## 6. 插件系统（保留 + 瘦身）

保留对外契约，删除高开销的部分：

```
保留：PluginSystem.loadAll/getList/toggle/delete/emit/getPluginExports
      plugins/*.js 动态加载（require + manifest）
      钩子：onLoad / onRoute / beforeJudge / afterJudge / injectHeader / injectFooter
      管理页：/admin/plugins（列表 / 启用 / 删除 / 上传，上传 ≤ 256 KB）
删除：_createPermissionProxy（权限校验）、plugin_configs 表、token 鉴权与审计日志
改造：启停状态存 plugins/config.json（不再每次 loadAll 查库）
      injectHeader/Footer 仅在存在启用插件时计算；无插件时零开销
      内置插件 db-monitor 移出默认注册表，按需用 ENABLED_BUILTIN_PLUGINS 开启
```

`tests/plugin_system.test.ts` 相应调整：去掉权限代理用例，其余（加载、钩子、启停、删除、错误容忍）保留。

---

## 7. 部署与运维

```
deploy/
├── dwoj.service        # systemd: MemoryHigh=80M, MemoryMax=96M, Restart=always, OOMScoreAdjust=200
├── lowmem.env          # DWOJ_LOWMEM=1 / DWOJ_LOG_CONSOLE=0 / PORT
└── run.sh              # 无 systemd 时的 nohup 兜底（替代原 CLI start）
scripts/
├── mem_watch.sh        # 每 30s 采 /proc/<pid>/status VmRSS，>100MB 记录并告警
└── loadtest.ts         # Bun 并发压测（首页/题目/状态/提交）
```

- `data/`、`log/`、`uploads/`、`problems_data/`、`plugins/` 继续 `.gitignore`。
- 部署包排除 `data/sandbox/`、`tests/`、`docs/`、`*.md`（除 README）。
- README 增加「1 核 128 MB 部署」章节 + 「功能裁剪对照表」+ 「v86 不支持」说明。
- 版本号：`package.json` → `3.1.0-lite`；`config.CURRENT_VERSION` 同步（Updater 已删，仅用于显示/兼容）。

---

## 8. 实施顺序

| 阶段 | 内容 | 预估 | 验证 |
|---|---|---|---|
| **P0 壳** | `--smol`、`Bun.serve` 参数、systemd/env 脚本、日志轮转、删 `data/sandbox` | 1 h | 空闲 RSS 采样 |
| **P1 判题修复** | J1–J9 全部 + 队列 + 启动恢复 + `errorInfo` 迁移 + `tests/judge.test.ts` | 5 h | §4.3 用例全过 |
| **P2 依赖减法** | C1 updater、C2 CLI、C3 自签 cookie、C4 自实现 fs、C5 极简 markdown、C6 roles/tags | 5 h | `bun test` + `tsc --noEmit` |
| **P3 插件瘦身** | §6（去 Proxy/去 token/去表/JSON 配置/去 db-monitor 默认启用） | 3 h | 插件加载+启停+钩子用例 |
| **P4 存储与热路径** | §3（pragma/迁移/大字段外置/索引）+ §5（模板缓存、路由预编译、/status 分页、静态 ETag） | 5 h | 20 并发 + 1 万条提交压测 |
| **P5 验收与文档** | `scripts/*`、README、功能对照表、验收表实测 | 2 h | 全表通过 |

合计 **约 21 h**，每阶段一个独立 commit，可单独回退。
优先级建议：**P0 → P1（修 bug）→ P2 → P4 → P3 → P5**（插件瘦身不影响稳定性，可最后做）。

---

## 9. 验收标准

| 场景 | 通过条件 |
|---|---|
| 空闲 10 分钟 | RSS < 35 MB，无单调增长 |
| `/status`（1 万条提交）+ 20 并发混合请求 | 首屏 < 200 ms，RSS < 55 MB |
| 提交死循环 / 10 MB 输出 / 30 MB zip | 分别 RE(TLE) / RE(OLE) / 413，RSS < 80 MB，服务不重启 |
| 连续 30 分钟混合流量（`MemoryMax=96M`） | 无 `oom-kill` 记录 |
| 队列积压 | 并发恒为 1，积压 > 50 时新提交被友好拒绝 |
| 旧数据 | 旧 `dwoj.db` 直接可用；只增列/索引，不删表删列 |
| CI | `bun test` 与 `bun run tsc --noEmit` 全绿 |

---

## 10. 风险与回退

| 风险 | 缓解 |
|---|---|
| 自签 cookie 导致全员重新登录 | 上线公告；如需平滑可临时接受旧 JWT 格式一个版本 |
| 去掉权限 Proxy 后插件可直连 DB | 插件本身受管理端控制，README 明确「插件 = 可信代码」 |
| `synchronous=OFF` 极端情况丢最后几次写 | 仅 `DWOJ_LOWMEM=1` 启用；数据库每日 `VACUUM INTO` 备份 |
| 大字段外置引入读写不一致 | 写入通过统一 blob 层；启动时校验引用存在性，缺失回退为空 |
| `ulimit` 在非 Linux 环境不可用 | Windows/macOS 走降级分支（仅本地开发，不做强限制） |
| `--smol` 使 GC 更频繁，1 核 CPU 略升 | 压测确认 `/status` 首屏仍 < 200 ms，必要时仅对 idle 生效 |

---

## 11. 与 main 分支的关系

main 已走多进程 IPC + v86 沙箱路线（内存 170 MB+），本分支**不合并 main 的架构改动**，只选择性回填判题相关修复（若 main 的 `lib/judge/*` 有更完整的判定逻辑，可参考其 `compare.ts` 思路，但实现保持单进程）。
