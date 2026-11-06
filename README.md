# DWOJ

DWOJ 是一个基于 **Bun + TypeScript** 开发的轻量级在线评测系统。它具备完整的题目管理、代码评测、讨论区、权限控制功能，并内置了强大的**插件系统**，支持高度的自定义扩展。

## 目录
1. [安装与部署](#1-安装与部署)
2. [使用教程](#2-使用教程)
3. [插件开发指南](#3-插件编写教程)

---

## 1. 安装与部署

### 环境要求
- **Bun**: v1.0 或更高版本（[安装指南](https://bun.sh/docs/installation)）
- **Python**: Python 3.x（用于评测 Python 代码）
- **操作系统**: Windows / Linux / macOS 均可

### 目录结构
在开始前，请确保你的项目包含以下文件和文件夹：
```text
dwoj/
├── data/               (自动生成: 数据库、评测临时目录 data/judge_tmp、沙箱资源 data/sandbox)
├── problems_data/      (自动生成: 存放题目测试点)
├── uploads/            (自动生成: 临时文件目录)
├── plugins/            (自动生成: 插件目录)
├── public/             (静态资源)
├── views/              (EJS 页面模板)
│   └── partials/
├── tests/              (单元测试)
├── lib/
│   ├── ipc/            (进程编排 broker + 子进程 IPC 节点)
│   ├── db/             (数据库驱动: Bun.SQL / 远程 IPC 驱动 / db 进程)
│   ├── http/           (HTTP 进程入口)
│   ├── judge/          (评测后端: v86 沙箱 / 本机进程 / 队列)
│   ├── bun-http.ts     (HTTP 服务器框架)
│   ├── database.ts     (数据库操作入口，按进程角色选本地/远程驱动)
│   ├── logger.ts       (日志模块，多进程共用同一个日志文件)
│   ├── plugin_system.ts (插件系统)
│   └── updater.ts      (自动更新)
├── middleware/
│   ├── auth.ts         (认证中间件)
│   └── global.ts       (全局中间件)
├── routes/             (路由模块)
├── app.ts              (主程序入口)
├── tsconfig.json       (TypeScript 配置)
└── package.json        (依赖配置)
```

### 安装步骤

1. **安装依赖**
   在项目根目录下打开终端，运行：
   ```bash
   bun install
   ```

2. **启动服务器**
   ```bash
   bun app.ts
   ```
   如果看到 DWOJ 的 ASCII 横幅（包含版本号、监听地址、评测后端与日志文件名），
   并在最后打出 `DWOJ 4.0.0 running in multi-process mode on port 3000`，说明启动成功
   （日志里还会依次出现 `db ready` / `http ready` / `judge ready`）。

   *开发模式（文件修改后自动重启）：*
   ```bash
   bun --watch app.ts
   ```

3. **访问系统**
   打开浏览器访问：`http://localhost:3000`

4. **初始化管理员账号**
   系统首次启动会自动创建超级管理员账号：
   - **用户名**: `root`
   - **密码**: `root`
   - *请登录后尽快修改密码。*

### 进程模型（多进程架构）

`bun app.ts` 启动的是 **broker**，它本身只做 IPC 连接器，不监听端口、不连数据库：

```text
            ┌───────────────── broker (app.ts) ─────────────────┐
            │  拉起/重启子进程 · 按 {to} 转发消息 · 优雅关闭    │
            └───┬──────────────────┬───────────────────┬────────┘
                │ NDJSON           │ NDJSON            │ NDJSON
        ┌───────▼───────┐  ┌───────▼───────┐  ┌────────▼────────┐
        │      db       │  │     http      │  │      judge      │
        │ 唯一持有数据库 │  │ Bun.serve/EJS │  │ 队列 + 沙箱后端  │
        └───────────────┘  └───────────────┘  └─────────────────┘
```

| 进程 | 职责 | 关键文件 |
|------|------|----------|
| broker | 进程编排、消息路由、崩溃重启、更新检查 | `app.ts`、`lib/ipc/broker.ts` |
| db | 唯一持有数据库连接（SQLite / MySQL / PG），建表迁移、响应 SQL | `lib/db/db_service.ts` |
| http | `Bun.serve` + 路由 + EJS + 静态文件 + 插件注入 | `lib/http/http_service.ts` |
| judge | 评测队列 + v86 沙箱 / 本机后端，回调插件钩子 | `lib/judge/judge_service.ts` |

- 子进程之间**不直接通信**，全部经 broker 按 `{to}` 字段转发（NDJSON over stdin/stdout，
  见 `lib/ipc/protocol.ts`）；`DWOJ_IPC_TRACE=1` 可以打印每条消息。
- `lib/database.ts` 会按进程角色自动选择驱动：db 进程用本地驱动，
  http/judge 用 `RemoteSqlDriver` 把 SQL 转发出去 —— 业务代码完全不用改。
- **故障恢复**：任一子进程退出，broker 立即广播 `peer-down`，其它进程里发往它的请求
  立刻失败（HTTP 返回 500、提交判 `System Error`），1s 后按指数退避重启；
  judge 重启后会自动把 `Pending`/`Running` 的提交重新排队。
- 日志格式统一为 `[等级][模块] 时间 信息`：模块名最长 **6 字符**，后面补空格，
  让所有日志的时间列对齐：

  ```text
  [INFO][broker] 2026-11-04T10:24:49.980Z starting db (db_service.ts)
  [INFO][db]     2026-11-04T10:24:50.121Z connected via Bun.SQL (sqlite)
  [WARN][judge]  2026-11-04T10:24:49.979Z 评测后端为 process（无隔离）…
  [ERRO][update] 2026-11-04T10:24:50.493Z Error checking for updates:
  ```

  等级统一 4 个字符（`INFO` / `WARN` / `ERRO`），模块名 ≤6 字符。

  模块名由 `createLogger('模块名')` 统一加，业务代码里不再手写 `[Judge]` 之类的标签；
  现有模块：`broker` / `db` / `http` / `judge` / `v86` / `plugin` / `dbmon` / `update`。
  插件日志的模块名由插件自己决定（`manifest.name` 规整后 ≤6 字符，见 `plugin.md`）。
- 日志统一写到 `log/app_<时间戳>.log`。子进程的 stdout 被 IPC 占用，因此它们把日志整行交给
  broker 打印：**INFO 走 stdout，只有 WARN / ERRO 走 stderr** —— 终端里不会再把普通 INFO 渲染成红色。
- 调试或没有 IPC 的环境可以退回单进程：`DWOJ_SINGLE_PROCESS=1 bun app.ts`。

### 运行测试

```bash
# 运行所有测试
bun test

# 运行单个测试文件
bun test tests/database.test.ts
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DB_DRIVER` | 数据库类型：`sqlite` / `mysql` / `postgres` | `sqlite` |
| `DB_URL` | 外部数据库连接串（`DB_DRIVER` 不是 `sqlite` 时必填） | 空 |
| `DB_POOL_MAX` | 外部数据库连接池上限 | `10` |
| `DWOJ_DB_NAME` | SQLite 数据库文件名（仅 `DB_DRIVER=sqlite` 生效） | `dwoj.db` |
| `PORT` | 监听端口 | `3000` |
| `JWT_SECRET` | JWT 签名密钥（**生产环境必须修改**） | `your_jwt_secret_key` |
| `JUDGE_CONCURRENCY` | 同时评测的提交数上限 | `2` |
| `JUDGE_SANDBOX` | 执行后端：`v86` / `process` / `auto` | `auto` |
| `V86_MEMORY_MB` | v86 客户机内存（需容纳 ~150MB initramfs） | `512` |
| `V86_BOOT_TIMEOUT_MS` | 客户机冷启动超时 | `180000` |
| `V86_COMPILE_TIMEOUT_MS` | 沙箱内 C++ 编译超时 | `180000` |
| `COMPILE_TIMEOUT_MS` | 本机后端 C++ 编译超时 | `20000` |
| `JUDGE_WORKER` | 单进程模式下是否把执行后端再拆一个子进程（`0` 关闭，调试/测试用） | `1` |
| `ENABLED_BUILTIN_PLUGINS` | 启用的内置插件（逗号分隔） | `db-monitor` |
| `JUDGE_SANDBOX_ACK` | 设为 `1` 跳过无隔离后端的启动风险确认（仅限非交互部署） | 空 |
| `DWOJ_SINGLE_PROCESS` | 设为 `1` 时所有服务跑在一个进程里（调试 / 无 IPC 环境） | 空 |
| `DWOJ_IPC_TRACE` | 设为 `1` 时打印每条进程间消息 | 空 |

#### 数据库配置

默认使用内置 SQLite，零配置即可运行。如需换成 MySQL / PostgreSQL，只需设置
`DB_DRIVER` 与 `DB_URL`，业务代码无需任何改动：

```bash
# MySQL / MariaDB
DB_DRIVER=mysql DB_URL='mysql://user:pass@127.0.0.1:3306/dwoj' bun app.ts

# PostgreSQL
DB_DRIVER=postgres DB_URL='postgres://user:pass@127.0.0.1:5432/dwoj' bun app.ts
```

建表、默认数据与列迁移都会在启动时自动完成（幂等，可重复执行）。三种数据库的
方言差异（占位符、自增主键、受影响行数、列信息查询）由 `lib/db/` 统一处理，
因此切换数据库不需要修改任何 SQL 语句。

> 注意：切换数据库不会自动迁移旧数据，请自行导出导入。

---

## 2. 使用教程

### 用户与权限
系统拥有三级权限体系：
1. **Default (普通用户)**: 只能做题、查看讨论区、发帖回复、修改个人资料。
2. **Super User (高级用户)**: 拥有管理面板权限，可以创建/编辑题目、管理插件、管理讨论节点、封禁普通用户。
3. **Root (超级管理员)**: 系统内置账号，拥有最高权限，无法被封禁，可编辑所有题目。

### 题目管理 (仅 Super User/Root)
1. **创建题目**:
   - 点击首页右上角的"新建题目"。
   - 填写标题、描述（支持 Markdown 和 LaTeX 公式）。
   - **测试数据**: 需要上传一个 `.zip` 压缩包。
     - **Zip 结构要求**: 压缩包内直接包含数据文件，不要包含文件夹。
     - 文件命名: `1.in`, `1.out`, `2.in`, `2.out` ...（输入输出需一一对应）。

2. **评测机制**:
   - 语言：**Python 3**、**C++（g++ -O2 -std=c++17）**、**Node.js**（本机后端支持；沙箱后端因模拟器里启动太慢暂不开放）。
   - 提交后进入评测队列，由 `JUDGE_CONCURRENCY` 控制并发，同一用户两次提交间隔不得小于 3 秒。
   - **评测跑在独立的 `judge` 进程里**（见下面的「进程模型」）：HTTP 进程只发一条
     `enqueue` 消息，沙箱把 WASM 内存吃爆或把客户机搞崩只会带走 judge 进程，
     broker 会重新拉起它，并把受影响的提交判为 `System Error` / 自动重新排队。
   - 本机后端：每个测试点独立子进程执行，工作目录是 `data/judge_tmp/<uuid>/`（评测结束即删除）；
     C++ 先编译再运行，编译失败判 `Compile Error`。
   - 每个测试点的时间限制取自题目的 `timeLimit`（毫秒，限制在 200–10000 之间），输出上限 1 MB。
   - 输出比对规则：统一 `\r\n` / `\n`、忽略**行末**空格与文末多余空行，行首与行内空格仍然敏感。
   - 测试点按 `1.in < 2.in < 10.in` 的数字序执行；缺少对应的 `.out` 会直接判定为 `System Error`。
   - 可能出现的状态：`Pending` / `Running` / `Accepted` / `Wrong Answer` / `Time Limit Exceeded` / `Runtime Error` / `Output Limit Exceeded` / `Compile Error`（语言不支持）/ `System Error`（题目或测试数据异常）。
   - 服务重启时，上次未跑完的 `Pending` / `Running` 提交会自动重新排队。
   - 管理员可在提交详情页点击「重新评测」。
   - 每个测试点的时间由沙箱/子进程内的计时器强制执行，超时立即中断。

### 2.1 沙箱（v86 内嵌虚拟机）

默认的 `auto` 模式会在 `data/sandbox/` 资源齐全时使用 **v86**（纯 WASM 的 x86 模拟器，
不需要 root、容器或 nsjail，Windows 上也能用）：

```bash
bun run sandbox:setup   # 一次性下载 BIOS / 内核 / Python / g++，生成 initramfs（约 55 MB 压缩、150 MB 解压）
JUDGE_SANDBOX=v86 bun app.ts
```

- 用户代码运行在一台 **32 位 Alpine Linux** 虚拟机里（v86 不支持 64 位内核与 PAE）：
  没有网络设备、看不到宿主机文件系统。
- **控制面与用户面隔离**：9p 共享目录 `/mnt/9p` 只由客户机里的守护进程（root）读写；
  用户代码被关进一个 `chroot` 沙箱 `/srv/ojroot`（里面没有 `/mnt/9p`），并以
  `nobody(65534)` 身份、独立进程组、`RLIMIT_NPROC/FSIZE` 限制运行，每个测试点用
  独立的 work 目录（跑完即删）。因此用户代码**读不到**别的提交的源码/测试数据，
  也**写不了** `job_*/res_*/out_*/ok_*` 这些控制与结果文件。
- **编译阶段同样在沙箱里**：C/C++ 的预处理、编译、汇编、链接全部在同一个
  `chroot` + 专属 UID 下执行，编译器只能看到当前提交的 work 目录；产物通过
  ELF/大小校验后才由 root 放进 `/opt/bin`（0700）缓存。因此 `.incbin` /
  `#include` 无法读取其他提交的编译缓存、`/mnt/9p` 或 root-only 文件（issue #6）。
- **进程清理 + 每提交独立 UID**：每个提交分配 `60000 + id % 4000` 的 UID，
  不同提交的进程不能互相发信号；任务结束时（不只是超时）会 `killpg` 并反复扫描
  `/proc`，把 setsid / 双 fork 逃逸的后台进程全部 SIGKILL，确认无残留后才处理下一条
  提交。daemon 重启和每条提交开始前也会清一遍（issue #7）。
- 客户机里常驻一个 **Python 评测守护进程**（`/mnt/9p/daemon.py`）：
  * Python 提交：`fork` 子进程执行用户代码，省掉解释器冷启动 →
    单测试点约 **50~200 ms**（早期实现每次重开解释器是 1~4 s）；
  * C++ 提交：**每个提交只编译一次**（`g++ -O2 -std=c++17`，模拟器里约 5~20 s），
    之后每个测试点直接跑二进制，约 **20~50 ms**。
- 客户机在 OJ 启动时后台冷启动（总耗时约 1.5~2.5 分钟：内核解压 ~70 s +
  守护进程预热 ~45 s + 编译预热 ~15 s，日志里搜 `[Judge/v86]`），之后常驻内存；
  被搞死时整台重建，不影响服务。initramfs 带 Python+g++，解压后约 150 MB，所以
  `V86_MEMORY_MB` 默认 512（小于 512 会导致内核解压 initramfs 失败）。
- 沙箱跑在独立的 `judge` 进程里（见「进程模型」），broker 和 HTTP 进程都不持有
  虚拟机的 WASM 内存；judge 崩溃后 broker 会自动重启它并重新排队未完成的提交。
- **运行错误不回显用户 stderr**：用户程序可以把当前测试点的 stdin（未公开测试输入）
  写进 stderr 再非零退出；因此 `Runtime Error` 的公开信息只有退出码/信号，
  用户 stderr 单独存入 `submissions.errorDetail`，仅 `super_user` / `root`
  在提交详情页可见（普通用户、process 后端、v86 后端统一策略）。
- 限制：**沙箱模式不支持 Node.js**（会被判为 `Compile Error` 并提示支持列表）；
  C++ 编译时间也算在提交里，适合练手/内网场景，不适合严格的竞赛计时。
- 不想用虚拟机时设 `JUDGE_SANDBOX=process`，用户代码会以 **服务器进程权限** 直接执行，
  仅限本地开发；这种情况下 `auto` 会在日志里打印醒目警告。

### 讨论区
- 所有注册用户均可发布帖子。
- 支持 Markdown 语法（如 `**加粗**`, `[链接](url)`）。
- 支持 LaTeX 数学公式（如 `$E=mc^2$`, `$$\sum_{i=1}^n i$$`）。

### 插件管理
- 入口：登录管理员账号 -> 顶部导航栏"管理面板" -> "插件管理"。
- 功能：
  - **上传**: 上传 `.js` 格式的插件文件。
  - **启用/禁用**: 动态切换插件状态。注意：涉及路由（新页面）的插件启用后建议重启服务器以确保稳定。
  - **删除**: 物理删除插件文件。

---

## 3. 插件编写教程

详见 [插件编写教程](./plugin.md)