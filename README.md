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
│   ├── bun-http.ts     (HTTP 服务器框架)
│   ├── database.ts     (数据库操作)
│   ├── logger.ts       (日志模块)
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
   如果看到输出 `DWOJ 2.0 running on port 3000 (Bun + TypeScript)`，说明启动成功。

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
| `V86_MEMORY_MB` | v86 客户机内存 | `192` |
| `V86_BOOT_TIMEOUT_MS` | 客户机冷启动超时 | `180000` |
| `ENABLED_BUILTIN_PLUGINS` | 启用的内置插件（逗号分隔） | `db-monitor` |
| `JUDGE_SANDBOX_ACK` | 设为 `1` 跳过无隔离后端的启动风险确认（仅限非交互部署） | 空 |

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

### PM2 部署说明

系统已集成 PM2 进程管理器，提供更稳定的生产环境部署方案。

**常用 PM2 命令:**
```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs dwoj

# 重启应用
pm2 restart dwoj

# 停止应用
pm2 stop dwoj

# 实时监控
pm2 monit
```

**详细部署文档请查看:** [DEPLOYMENT.md](./DEPLOYMENT.md)

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
   - 系统支持 Python 3（`python3`/`python`，自动探测并校验主版本）和 Node.js（`bun`，缺失时回退 `node`）。
   - 提交后进入评测队列，由 `JUDGE_CONCURRENCY` 控制并发，同一用户两次提交间隔不得小于 3 秒。
   - 每个测试点独立进程执行，工作目录是 `data/judge_tmp/<uuid>/`（评测结束即删除）。
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
bun run sandbox:setup   # 一次性下载 BIOS / 内核 / Python，生成 initramfs（约 15 MB）
JUDGE_SANDBOX=v86 bun app.ts
```

- 用户代码运行在一台 **32 位 Alpine Linux** 虚拟机里（v86 不支持 64 位内核与 PAE）：
  没有网络设备、看不到宿主机文件系统，只能通过串口和 9p 共享目录拿到本次评测的源码与输入。
- 客户机在 OJ 启动时后台冷启动（约 30~60 s，日志里搜 `[Judge/v86]`），之后常驻内存，
  每个测试点约 1~4 s；被搞死时整台重建，不影响服务。
- 限制：**沙箱模式只支持 Python**（Node.js 在模拟器里启动太慢，会被判为
  `Compile Error`）；时间限制包含模拟器里 Python 的启动开销，适合练手/内网场景，
  不适合严格的竞赛计时。
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