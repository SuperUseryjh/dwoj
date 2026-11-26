import { createLogger } from '../logger';
import { PLUGIN_PERMISSIONS, type PluginDatabase, type PluginPermission } from './types';

const logger = createLogger('plugin');

/** 旧权限名 → 新权限名；oj_access 已删除 */
const LEGACY_PERMISSION_MAP: Record<string, PluginPermission | null> = {
    read_db: 'db:read',
    write_db: 'db:write',
    oj_access: null,
};

export function isPluginPermission(value: string): value is PluginPermission {
    return (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

export interface NormalizedPermissions {
    permissions: PluginPermission[];
    /** 数据库里保存的权限是否需要写回（发生映射/丢弃/去重） */
    changed: boolean;
}

/**
 * 归一化 `plugin_configs.permissions`：
 *   - 旧名 read_db / write_db 自动映射；
 *   - oj_access 与未知值丢弃；
 *   - 无记录时使用插件定义里请求的权限。
 */
export function normalizeStoredPermissions(
    raw: string | null | undefined,
    requested: PluginPermission[],
): NormalizedPermissions {
    const requestedClean = [...new Set(requested.filter(isPluginPermission))];
    if (raw === null || raw === undefined || raw === '') {
        // 配置行缺少权限时，需要把定义里的请求权限写回数据库
        return { permissions: requestedClean, changed: true };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { permissions: requestedClean, changed: true };
    }
    if (!Array.isArray(parsed)) {
        return { permissions: requestedClean, changed: true };
    }

    let changed = false;
    const out: PluginPermission[] = [];
    for (const value of parsed) {
        if (typeof value !== 'string') {
            changed = true;
            continue;
        }

        let mapped: PluginPermission | null | undefined;
        if (value in LEGACY_PERMISSION_MAP) {
            mapped = LEGACY_PERMISSION_MAP[value];
        } else {
            mapped = isPluginPermission(value) ? value : undefined;
        }

        if (!mapped) {
            changed = true;
            continue;
        }
        if (mapped !== value) changed = true;
        if (out.includes(mapped)) {
            changed = true;
            continue;
        }
        out.push(mapped);
    }
    return { permissions: out, changed };
}

type RawDb = {
    query: (sql: string, params?: readonly any[]) => Promise<any[]>;
    queryOne: (sql: string, params?: readonly any[]) => Promise<any>;
    execute: (sql: string, params?: readonly any[]) => Promise<any>;
};

function denied(permission: PluginPermission): never {
    logger.warn(`plugin attempted unauthorized action: ${permission}`);
    throw new Error(`Plugin permission denied: ${permission}`);
}

/**
 * 给插件创建带权限校验的 db 接口。
 * 映射是显式的：query/queryOne → db:read，execute → db:write。
 */
export function createPluginDb(db: RawDb, permissions: Set<PluginPermission>): PluginDatabase {
    const assert = (permission: PluginPermission): void => {
        if (!permissions.has(permission)) denied(permission);
    };

    return {
        async query<T = any>(sql: string, params: readonly any[] = []): Promise<T[]> {
            assert('db:read');
            return await db.query(sql, params) as T[];
        },
        async queryOne<T = any>(sql: string, params: readonly any[] = []): Promise<T | undefined> {
            assert('db:read');
            return await db.queryOne(sql, params) as T | undefined;
        },
        async execute(sql: string, params: readonly any[] = []): Promise<{ lastInsertRowid: number; changes: number }> {
            assert('db:write');
            return await db.execute(sql, params);
        },
    };
}
