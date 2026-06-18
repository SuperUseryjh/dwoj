import path from 'path';

export const PORT: number = parseInt(process.env.PORT || '3000', 10);
export const DATA_DIR: string = path.join(__dirname, '..', 'data');
export const PROB_DIR: string = path.join(__dirname, '..', 'problems_data');
export const UPLOAD_DIR: string = path.join(__dirname, '..', 'uploads');
export const PLUGINS_DIR: string = path.join(__dirname, '..', 'plugins');
export const JWT_SECRET: string = process.env.JWT_SECRET || 'your_jwt_secret_key';

export const UPDATE_CHECK_URL: string = 'http://static.mr-onion-blog.fun/deploy/dwoj/dwoj.json';
export const UPDATE_PACKAGE_URL: string = 'http://static.mr-onion-blog.fun/deploy/dwoj/dwoj.tar.gz';
export const CURRENT_VERSION: string = '3.0.0';

/** 内置插件列表，用逗号分隔。设为空字符串可禁用所有内置插件。 */
export const ENABLED_BUILTIN_PLUGINS: string[] = (process.env.ENABLED_BUILTIN_PLUGINS || 'db-monitor')
    .split(',').map(s => s.trim()).filter(Boolean);
