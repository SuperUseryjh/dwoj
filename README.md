# DWOJ（dwoj-lite 分支）

基于 **Bun + TypeScript** 的轻量级在线评测系统，具备题库、评测、讨论区与插件系统。本分支面向 **1 vCPU / 128 MB** 的小机器，功能以"够用"为准，已裁剪自动更新器、CLI 与多进程架构。

> 验收基线：空闲 RSS < 35 MB，判题峰值 ≤ 80 MB，不出现 OOM kill。
> 详细优化计划见 [docs/dwoj-lite-plan.md](./docs/dwoj-lite-plan.md)。

## 目录

1. [快速开始](#1-快速开始)
2. [1 核 128 MB 部署](#2-1-核-128-mb-部署)
3. [环境变量](#3-环境变量)
4. [功能裁剪对照表](#4-功能裁剪对照表)
5. [评测机制](#5-评测机制)
6. [插件系统](#6-插件系统)
7. [目录结构](#7-目录结构)

---

## 1. 快速开始

### 环境要求
- **Bun** ≥ 1.0
- **Python 3**（可选，用于评测 Python 提交）
- 操作系统：Linux / macOS / Windows

### 启动

```bash
bun install
bun run start:lowmem   # 等价于 bun --smol app.ts，低内存 GC 模式
# 或
bun app.ts             # 普通模式
```

访问 `http://localhost:3000`。首次启动自动创建管理员账号：`root / root`，请尽快修改密码。

### 测试

```bash
bun test
bun run tsc --noEmit
```

---

## 2. 1 核 128 MB 部署

### systemd（推荐）

```bash
sudo useradd -r -s /usr/sbin/nologin dwoj
sudo mkdir -p /opt/dwoj && sudo chown dwoj:dwoj /opt/dwoj
# 将代码放到 /opt/dwoj 后：
sudo cp deploy/dwoj.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dwoj
```

`deploy/dwoj.service` 已设置：

| 项 | 值 |
|---|---|
| `MemoryHigh` | 80M |
| `MemoryMax` | 96M |
| `Restart` | always |
| `OOMScoreAdjust` | 200 |
| 启动命令 | `bun --smol app.ts` |

环境变量通过 `deploy/lowmem.env` 注入（`DWOJ_LOWMEM=1`、`DWOJ_LOG_CONSOLE=0`、`PORT`）。

### 无 systemd 的兜底

```bash
chmod +x deploy/run.sh
./deploy/run.sh        # nohup 后台启动，PID 写入 dwoj.pid
```

### 运维脚本

```bash
# 每 30s 采样 RSS，超过 100 MB 打 WARN
./scripts/mem_watch.sh <pid> 30 100

# 20 并发压测（首页/状态/讨论区/题目）
bun scripts/loadtest.ts http://127.0.0.1:3000 20 5
```

### 带监控面板启动（开发/观测）

```bash
bun run start:insp
# 或自定义端口
INSP_PORT=4000 PORT=3000 bun run start:insp
```

`start:insp` 会：

1. 以子进程方式启动主程序 `bun --smol app.ts`；
2. 每秒采样主进程的 CPU 与内存 RSS（Linux 读 `/proc`，macOS 用 `ps`，Windows 用常驻 PowerShell 采样器）；
3. 在 `http://localhost:4000` 提供监控页面，实时渲染 CPU / 内存折线图，并显示当前值、峰值、PID 与运行时长。

Ctrl+C 会同时停止监控面板与主进程。

### 升级方式

本分支**不再内置自动更新器**。升级请直接 `git pull` 后 `systemctl restart dwoj`，或替换镜像后重启。

---

## 3. 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 监听端口 | `3000` |
| `DWOJ_DB_NAME` | 数据库文件名（位于 `data/`） | `dwoj.db` |
| `DWOJ_LOWMEM` | `1` 启用低内存降级（SQLite pragma 等） | 未设置 |
| `DWOJ_LOG_CONSOLE` | `1` 同时把日志回显到 stdout | 未设置（只写文件） |
| `ENABLED_BUILTIN_PLUGINS` | 启用的内置插件，逗号分隔（如 `db-monitor`） | 空 |

---

## 4. 功能裁剪对照表

| 能力 | 本分支 | 说明 |
|---|---|---|
| 自动更新器 | 已移除 | 改由部署流程 `git pull` / 换镜像 |
| CLI（`dwoj` 命令） | 已移除 | 用 systemd 常驻 |
| 多进程 IPC（http/db/judge） | 不采用 | 内存 170 MB+，128 MB 机器不可行 |
| v86 沙箱 | 不支持 | 常驻 60–100 MB |
| JWT 库 | 已替换 | 自签 HMAC-SHA256 cookie（登录态一次性失效需重新登录） |
| `fs-extra` / `markdown-it` | 已替换 | 原生 `fs` 工具与极简 Markdown 渲染 |
| 角色表 / Tag 编辑 | 已移除 | 三级角色固定为 `default/super_user/root` |
| `/status` | 分页 50 + 手动刷新 | 不再读取 `code` 大字段、不再 5s 整页刷新 |
| 插件权限代理 | 已移除 | 插件 = 可信代码，直接拿到 `oj`/`db` |
| 判题 | 保留并修复 | 单飞队列、并发 1、资源限制、启动恢复 |
| 讨论区 / 题库 / 用户管理 | 保留 | — |

---

## 5. 评测机制

- 支持 **Python 3** 与 **Node（bun）**。
- 测试点位于 `problems_data/<题目ID>/`，需 `1.in / 1.out` 成对出现；缺 `.out` 判 `Data Error`。
- 单飞 FIFO 队列，并发恒为 1，积压上限 50（超出提示稍后提交）。
- 单点时限 2 s，整场上限 10 s；输出超过 1 MB 判 `OLE`；进程组整体回收。
- Linux 下通过 `ulimit -v 262144 -t 5 -f 8192` 限制进程资源。
- 服务重启时自动恢复 `Pending` / 遗留 `Running` 的提交。
- 测试数据 zip 上限 20 MB，超过返回 413。

---

## 6. 插件系统

- 插件是 `.js` 文件，放入 `plugins/` 目录，可在「管理面板 → 插件管理」上传/启停/删除。
- 插件直接接收 `oj`（app/config/logger）与 `db`（数据库接口），**插件代码等同可信代码**，请只安装可信来源。
- 启停状态保存在 `plugins/config.json`，不再写入数据库。
- 内置插件 `db-monitor` 默认关闭，需要时设置 `ENABLED_BUILTIN_PLUGINS=db-monitor`。
- 插件上传上限 256 KB。
- 钩子：`onLoad` / `onRoute` / `beforeJudge` / `afterJudge` / `injectHeader` / `injectFooter`，详见 [plugin.md](./plugin.md)。

---

## 7. 目录结构

```text
dwoj/
├── data/                  # 数据库、judge_tmp、blobs（自动生成）
├── problems_data/         # 题目测试点（自动生成）
├── uploads/               # 上传临时目录（自动生成）
├── plugins/               # 插件目录 + config.json
├── public/                # 静态资源（启动时建索引 + ETag 缓存）
├── views/                 # EJS 模板（进程内编译缓存）
├── deploy/
│   ├── dwoj.service       # systemd 单元
│   ├── lowmem.env         # 生产环境变量
│   └── run.sh             # 无 systemd 兜底启动
├── scripts/
│   ├── mem_watch.sh       # RSS 采样告警
│   ├── loadtest.ts        # 并发压测
│   └── insp.ts            # 子进程监控主进程 + 图表面板
├── lib/
│   ├── bun-http.ts        # HTTP 框架（路由预编译/模板缓存/静态缓存）
│   ├── database.ts        # SQLite 访问层 + blob 外置
│   ├── blobs.ts           # 大字段外置
│   ├── auth-token.ts      # 自签 cookie
│   ├── markdown.ts        # 极简 Markdown
│   ├── fs-utils.ts        # 原生 fs 工具
│   ├── logger.ts          # 轮转日志
│   ├── plugin_system.ts   # 插件系统
│   ├── judge/
│   │   ├── queue.ts       # 单飞判题队列
│   │   ├── runner.ts      # 判题执行器
│   │   └── compare.ts     # 输出比对
│   └── builtin_plugins/
│       └── db-monitor.ts  # 可选：数据库慢查询监控
├── middleware/            # 全局中间件 / 权限
├── routes/                # 路由模块
├── app.ts                 # 入口
└── package.json
```

---

## 8. 插件开发

详见 [plugin.md](./plugin.md)。
