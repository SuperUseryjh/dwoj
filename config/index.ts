import path from 'path';

export const PORT: number = parseInt(process.env.PORT || '3000', 10);
export const DATA_DIR: string = path.join(__dirname, '..', 'data');
export const PROB_DIR: string = path.join(__dirname, '..', 'problems_data');
export const UPLOAD_DIR: string = path.join(__dirname, '..', 'uploads');
export const PLUGINS_DIR: string = path.join(__dirname, '..', 'plugins');
export const JWT_SECRET: string = process.env.JWT_SECRET || 'your_jwt_secret_key';

/** 1 核 / 128 MB 低内存模式：开启后启用所有降级默认值 */
export const LOWMEM: boolean = process.env.DWOJ_LOWMEM === '1';

/** 请求体上限 */
export const MAX_BODY_SIZE: number = 8 * 1024 * 1024;
export const URLENCODED_BODY_LIMIT: number = 256 * 1024;

/** 插件上传上限 256 KB */
export const PLUGIN_UPLOAD_LIMIT: number = 256 * 1024;

/** 测试点 zip 上限 20 MB */
export const TESTCASE_ZIP_LIMIT: number = 20 * 1024 * 1024;

/** /status 每页条数 */
export const STATUS_PAGE_SIZE: number = 50;

/** 判题队列长度上限 */
export const JUDGE_QUEUE_LIMIT: number = 50;

/** blob 外置阈值（字节） */
export const BLOB_THRESHOLD: number = 4096;

export const CURRENT_VERSION: string = '3.1.0-lite';

/** 内置插件列表，用逗号分隔。默认不启用任何内置插件，按需设置 ENABLED_BUILTIN_PLUGINS=db-monitor。 */
export const ENABLED_BUILTIN_PLUGINS: string[] = (process.env.ENABLED_BUILTIN_PLUGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
