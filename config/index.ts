import path from 'path';

export const PORT: number = parseInt(process.env.PORT || '3000', 10);
export const DATA_DIR: string = path.join(__dirname, '..', 'data');
export const PROB_DIR: string = path.join(__dirname, '..', 'problems_data');
export const UPLOAD_DIR: string = path.join(__dirname, '..', 'uploads');
export const PLUGINS_DIR: string = path.join(__dirname, '..', 'plugins');
/** 评测临时目录（每次评测在其下创建独立子目录作为工作目录，评测结束即删除） */
export const JUDGE_DIR: string = path.join(__dirname, '..', 'data', 'judge_tmp');
export const JWT_SECRET: string = process.env.JWT_SECRET || 'your_jwt_secret_key';

export const UPDATE_CHECK_URL: string = 'http://static.mr-onion-blog.fun/deploy/dwoj/dwoj.json';
export const UPDATE_PACKAGE_URL: string = 'http://static.mr-onion-blog.fun/deploy/dwoj/dwoj.tar.gz';
export const CURRENT_VERSION: string = '4.0.1';

// ============================================================
// 数据库配置
// ============================================================

/**
 * 数据库类型：
 *  - 'sqlite'   : 内置 SQLite 文件（默认，零配置）
 *  - 'mysql'    : MySQL / MariaDB，通过 DB_URL 连接
 *  - 'postgres' : PostgreSQL，通过 DB_URL 连接
 *
 * 未设置 DB_DRIVER 时按 sqlite 处理，并沿用旧的 DWOJ_DB_NAME 逻辑，
 * 保证既有部署和测试无需改动即可继续工作。
 */
export const DB_DRIVER: string = (process.env.DB_DRIVER || 'sqlite').toLowerCase();

/** 外部数据库连接串，例如 mysql://user:pass@host:3306/dwoj */
export const DB_URL: string = process.env.DB_URL || '';

/** 连接池上限（仅外部数据库生效） */
export const DB_POOL_MAX: number = Math.max(1, parseInt(process.env.DB_POOL_MAX || '10', 10) || 10);

// ============================================================
// 评测机配置
// ============================================================

/** 同时评测的提交数上限（每个评测进程都会占用 CPU / 内存） */
export const JUDGE_CONCURRENCY: number = Math.max(1, parseInt(process.env.JUDGE_CONCURRENCY || '2', 10) || 2);

/** 支持的语言（前端下拉框 + 后端白名单，二者必须一致） */
export const LANGUAGES: string[] = ['python', 'node', 'cpp'];

/** 语言 -> 展示名 */
export const LANGUAGE_LABELS: Record<string, string> = {
    python: 'Python 3',
    node: 'Node.js (Bun)',
    cpp: 'C++ (g++ -O2 -std=c++17)',
};

/** 编译超时（C++） */
export const COMPILE_TIMEOUT_MS: number = Math.max(5000, parseInt(process.env.COMPILE_TIMEOUT_MS || '20000', 10) || 20000);

/** 单个测试点默认时间限制（毫秒） */
export const DEFAULT_TIME_LIMIT_MS: number = 1000;
/** 时间限制的允许区间，防止题目里写入 0 或 1e9 之类的值 */
export const MIN_TIME_LIMIT_MS: number = 200;
export const MAX_TIME_LIMIT_MS: number = 10000;

/** 用户程序输出的最大字节数，超过即 Output Limit Exceeded */
export const MAX_OUTPUT_BYTES: number = 1024 * 1024;
/** 保留的 stderr 最大字节数（用于错误信息） */
export const MAX_STDERR_BYTES: number = 8 * 1024;
/** 允许提交的源码最大字节数 */
export const MAX_CODE_BYTES: number = 64 * 1024;

// ============================================================
// 沙箱（v86 内嵌虚拟机）配置
// ============================================================

/**
 * 执行后端：
 *  - 'v86'     : 在 v86 虚拟机里运行（推荐，跨平台，无需 root/容器）
 *  - 'process' : 直接在服务器上跑（无隔离，仅限本地开发）
 *  - 'auto'    : 沙箱资源齐全就用 v86，否则退回 process 并打警告
 */
export const JUDGE_SANDBOX: string = process.env.JUDGE_SANDBOX || 'auto';

/** 沙箱资源目录（由 `bun run sandbox:setup` 生成，已加入 .gitignore） */
export const V86_DIR: string = path.join(__dirname, '..', 'data', 'sandbox');

export const V86_ASSETS = {
    bios: path.join(V86_DIR, 'seabios.bin'),
    vgabios: path.join(V86_DIR, 'vgabios.bin'),
    bzimage: path.join(V86_DIR, 'bzimage'),
    initramfs: path.join(V86_DIR, 'initramfs.cpio.gz'),
};

/**
 * 客户机内存。
 * initramfs 里带了 Python + g++，解压后约 250MB，所以至少要给 384MB；
 * v86 不支持 PAE，32 位客户机上限约 2~3GB。
 */
export const V86_MEMORY_MB: number = Math.max(256, parseInt(process.env.V86_MEMORY_MB || '512', 10) || 512);

/** 沙箱里支持的语言（Node.js 在模拟器里启动太慢，暂不支持） */
export const V86_LANGUAGES: string[] = ['python', 'cpp'];

/** 沙箱内的编译超时（模拟器里 g++ 很慢，给足时间） */
export const V86_COMPILE_TIMEOUT_MS: number = Math.max(30000, parseInt(process.env.V86_COMPILE_TIMEOUT_MS || '180000', 10) || 180000);

/** 冷启动（解压 initramfs + 起 linux）的超时 */
export const V86_BOOT_TIMEOUT_MS: number = Math.max(60000, parseInt(process.env.V86_BOOT_TIMEOUT_MS || '180000', 10) || 180000);

/** 单次执行额外的固定开销预算（解释器在模拟器里启动比真机慢） */
export const V86_RUN_GRACE_MS: number = Math.max(3000, parseInt(process.env.V86_RUN_GRACE_MS || '15000', 10) || 15000);

/** 内置插件列表，用逗号分隔。设为空字符串可禁用所有内置插件。 */
export const ENABLED_BUILTIN_PLUGINS: string[] = (process.env.ENABLED_BUILTIN_PLUGINS || 'db-monitor')
    .split(',').map(s => s.trim()).filter(Boolean);
