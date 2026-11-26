import fs from 'fs';
import { pathToFileURL } from 'url';
import {
    PLUGIN_HOOK_NAMES,
    PLUGIN_PERMISSIONS,
    type PluginDefinition,
    type PluginHookName,
    type PluginPermission,
} from './types';

/** 扫描插件目录，只接受 .js 文件，顺序稳定 */
export function discoverPluginFiles(pluginDir: string): string[] {
    return fs.readdirSync(pluginDir)
        .filter(file => file.endsWith('.js'))
        .sort();
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePermissions(raw: unknown): PluginPermission[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        throw new Error('permissions 必须是数组');
    }
    const out: PluginPermission[] = [];
    for (const value of raw) {
        if (typeof value !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(value)) {
            throw new Error(`未知的插件权限：${String(value)}（可选：${PLUGIN_PERMISSIONS.join(' / ')}）`);
        }
        if (!out.includes(value as PluginPermission)) out.push(value as PluginPermission);
    }
    return out;
}

function normalizeHooks(raw: unknown): PluginDefinition['hooks'] {    if (raw === undefined) return undefined;
    if (!isPlainObject(raw)) throw new Error('hooks 必须是对象');

    const unknownKeys = Object.keys(raw).filter(key => !(PLUGIN_HOOK_NAMES as readonly string[]).includes(key));
    if (unknownKeys.length > 0) {
        throw new Error(`未知的钩子：${unknownKeys.join(', ')}（可选：${PLUGIN_HOOK_NAMES.join(' / ')}）`);
    }

    const hooks: Record<string, any> = {};
    for (const name of PLUGIN_HOOK_NAMES) {
        const fn = (raw as Record<string, any>)[name];
        if (fn === undefined) continue;
        if (typeof fn !== 'function') throw new Error(`钩子 ${name} 必须是函数`);
        hooks[name as PluginHookName] = fn;
    }
    return hooks as PluginDefinition['hooks'];
}

/** 校验插件静态 CSS：字符串或字符串数组 */
function normalizeStyles(raw: unknown): string | string[] | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) {
        return [...raw];
    }
    throw new Error('styles 必须是字符串或字符串数组');
}

/**
 * 校验并补全 `export default { ... }` 的定义对象。
 * 所有字段都在这里定型，后续模块不再做兼容判断。
 */
export function normalizeDefinition(raw: unknown): PluginDefinition {
    if (!isPlainObject(raw)) {
        throw new Error('插件必须通过 export default 导出一个定义对象');
    }

    const allowedKeys = new Set([
        'name', 'version', 'description', 'permissions', 'styles', 'setup', 'routes', 'hooks', 'api',
    ]);
    const unknownKeys = Object.keys(raw).filter(key => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`未知的插件字段：${unknownKeys.join(', ')}（可选：${[...allowedKeys].join(' / ')}）`);
    }

    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
        throw new Error('插件定义缺少 name（非空字符串）');
    }
    if (raw.version !== undefined && typeof raw.version !== 'string') {
        throw new Error('插件 version 必须是字符串');
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') {
        throw new Error('插件 description 必须是字符串');
    }
    if (raw.setup !== undefined && typeof raw.setup !== 'function') {
        throw new Error('插件 setup 必须是函数');
    }
    if (raw.routes !== undefined && typeof raw.routes !== 'function') {
        throw new Error('插件 routes 必须是函数');
    }
    if (raw.api !== undefined && !isPlainObject(raw.api)) {
        throw new Error('插件 api 必须是对象');
    }

    return {
        name: raw.name.trim(),
        version: raw.version || '1.0.0',
        description: raw.description || '',
        permissions: normalizePermissions(raw.permissions),
        styles: normalizeStyles(raw.styles),
        setup: raw.setup,
        routes: raw.routes,
        hooks: normalizeHooks(raw.hooks),
        api: raw.api,
    };
}

/**
 * 加载并校验单个插件文件。
 *
 * 不支持 CommonJS：检测到 `module.exports` / `exports.xxx` 且没有 `export default`
 * 时直接给出迁移提示。
 */
export async function loadPluginDefinition(fullPath: string): Promise<PluginDefinition> {
    const source = fs.readFileSync(fullPath, 'utf-8');

    const hasEsmDefault = /export\s+default\b/.test(source);
    const hasCjsExport = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(source);
    if (!hasEsmDefault && hasCjsExport) {
        throw new Error('不再支持 CommonJS 插件，请改为 export default { ... }');
    }

    const url = `${pathToFileURL(fullPath).href}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const namespace: any = await import(url);

    if (!namespace || namespace.default === undefined) {
        throw new Error('插件缺少默认导出（export default { ... }）');
    }
    return normalizeDefinition(namespace.default);
}
