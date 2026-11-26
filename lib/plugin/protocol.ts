import type { PluginRequest } from './types';

/** 插件进程 RPC 方法名集中定义，避免 host / service 两侧字符串漂移 */
export const PLUGIN_RPC = {
    HTTP_INFO: 'plugin.httpInfo',
    INJECT: 'plugin.inject',
    JUDGE: 'plugin.judge',
    LIST: 'plugin.list',
    TOGGLE: 'plugin.toggle',
    DELETE: 'plugin.delete',
    RELOAD: 'plugin.reload',
} as const;

/** RPC 超时（毫秒）：集中定义，避免散落在调用点 */
export const PLUGIN_RPC_TIMEOUTS = {
    info: 15000,
    inject: 15000,
    judge: 60000,
    list: 15000,
    toggle: 30000,
    delete: 30000,
    reload: 60000,
} as const;

/** 插件路由服务器的连接信息 */
export interface PluginEndpoint {
    port: number;
    token: string;
}

/** 注入钩子请求快照（headers 在 IPC 上是普通对象） */
export interface PluginInjectSnapshot {
    method: string;
    path: string;
    url: string;
    query: Record<string, string>;
    cookies: Record<string, string>;
    params: Record<string, string>;
    headers: Record<string, string>;
    user: { id: number; username?: string; role: string } | null;
}

export type JudgeHook = 'beforeJudge' | 'afterJudge';

/** 请求对象 → 可经 IPC 传输的快照 */
export function snapshotRequest(req: PluginRequest): PluginInjectSnapshot {
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => { headers[key] = value; });
    return {
        method: req.method,
        path: req.path,
        url: req.url,
        query: req.query,
        cookies: req.cookies,
        params: req.params,
        headers,
        user: req.user ?? null,
    };
}

/** IPC 快照 → 插件钩子可用的请求对象 */
export function hydrateRequest(raw: Partial<PluginInjectSnapshot> = {}): PluginRequest {
    return {
        method: String(raw.method || 'GET'),
        path: String(raw.path || '/'),
        url: String(raw.url || ''),
        query: raw.query || {},
        cookies: raw.cookies || {},
        params: raw.params || {},
        headers: new Headers(raw.headers || {}),
        user: raw.user || null,
    };
}
