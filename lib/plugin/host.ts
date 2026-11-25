import { call } from '../ipc/node';
import { createLogger } from '../logger';
import type PluginSystem from '../plugin_system';

const logger = createLogger('plugin');

/**
 * 插件宿主接口。
 *
 * 单进程模式下由 `LocalPluginHost` 直接调用内存里的 `PluginSystem`；
 * 多进程模式下由 `RemotePluginHost` 通过 broker 把调用转发给 plugin 进程。
 *
 * 这样 http / judge 进程不需要再加载任何插件代码，插件也只在 plugin 进程里存在一份。
 */
export interface PluginHost {
    /** 收集页面注入片段 */
    inject(req: any): Promise<{ header: string; footer: string }>;
    /** 执行 beforeJudge / afterJudge，返回（可能被插件修改过的）提交对象 */
    runJudgeHook(hook: 'beforeJudge' | 'afterJudge', submission: any): Promise<any>;
    /** 管理界面：插件列表 */
    getList(): Promise<any[]>;
    /** 管理界面：启用/禁用 */
    toggle(filename: string, enabled: boolean): Promise<void>;
    /** 管理界面：删除 */
    delete(filename: string): Promise<void>;
    /** 管理界面：重新加载插件目录 */
    reload(): Promise<void>;
    /**
     * 把未命中核心路由的请求转发给 plugin 进程里的插件路由服务器。
     * 没有插件路由（单进程）时返回 null。
     */
    proxy(req: any): Promise<Response | null>;
}

/** 单进程模式：直接使用本进程内的 PluginSystem */
export class LocalPluginHost implements PluginHost {
    constructor(private readonly system: PluginSystem) { }

    inject(req: any): Promise<{ header: string; footer: string }> {
        return this.system.inject(req);
    }

    runJudgeHook(hook: 'beforeJudge' | 'afterJudge', submission: any): Promise<any> {
        return this.system.runJudgeHook(hook, submission);
    }

    getList(): Promise<any[]> {
        return Promise.resolve(this.system.getList());
    }

    toggle(filename: string, enabled: boolean): Promise<void> {
        return this.system.toggle(filename, enabled);
    }

    delete(filename: string): Promise<void> {
        return this.system.delete(filename);
    }

    reload(): Promise<void> {
        return this.system.reload();
    }

    async proxy(): Promise<Response | null> {
        // 单进程模式下插件路由直接注册在主应用上，不需要转发
        return null;
    }
}

interface PluginEndpoint {
    port: number;
    token: string;
}

/** 把 HTTP 请求对象裁剪成可经 IPC 传输的普通对象 */
function serializeRequest(req: any): any {
    const headers: Record<string, string> = {};
    req.headers?.forEach?.((value: string, key: string) => { headers[key] = value; });
    return {
        method: req.method,
        path: req.path,
        url: req.url,
        query: req.query || {},
        cookies: req.cookies || {},
        params: req.params || {},
        headers,
        user: req.user
            ? { id: req.user.id, username: req.user.username, role: req.user.role }
            : null,
    };
}

/** 多进程模式：通过 broker 调用 plugin 进程 */
export class RemotePluginHost implements PluginHost {
    private endpointPromise: Promise<PluginEndpoint> | null = null;

    private endpoint(): Promise<PluginEndpoint> {
        if (!this.endpointPromise) {
            this.endpointPromise = call<PluginEndpoint>('plugin', 'http.info', {}, 15000)
                .catch(err => {
                    this.endpointPromise = null;
                    throw err;
                });
        }
        return this.endpointPromise;
    }

    async inject(req: any): Promise<{ header: string; footer: string }> {
        try {
            return await call('plugin', 'hooks.inject', { req: serializeRequest(req) }, 15000);
        } catch (err) {
            logger.error('plugin inject hook failed', err as Error);
            return { header: '', footer: '' };
        }
    }

    async runJudgeHook(hook: 'beforeJudge' | 'afterJudge', submission: any): Promise<any> {
        try {
            return await call('plugin', 'hooks.judge', { hook, submission }, 60000);
        } catch (err) {
            logger.error(`plugin ${hook} hook failed`, err as Error);
            return submission;
        }
    }

    getList(): Promise<any[]> {
        return call('plugin', 'plugin.list', {}, 15000);
    }

    toggle(filename: string, enabled: boolean): Promise<void> {
        return call('plugin', 'plugin.toggle', { filename, enabled }, 30000);
    }

    delete(filename: string): Promise<void> {
        return call('plugin', 'plugin.delete', { filename }, 30000);
    }

    reload(): Promise<void> {
        return call('plugin', 'plugin.reload', {}, 60000);
    }

    async proxy(req: any): Promise<Response | null> {
        let endpoint = await this.endpoint();
        try {
            return await this.forward(req, endpoint);
        } catch (err) {
            // plugin 进程可能刚重启，端口变了：刷新后再试一次
            this.endpointPromise = null;
            endpoint = await this.endpoint();
            return await this.forward(req, endpoint);
        }
    }

    private async forward(req: any, endpoint: PluginEndpoint): Promise<Response> {
        const headers = new Headers();
        req.headers?.forEach?.((value: string, key: string) => {
            const lower = key.toLowerCase();
            // body 会被重建，长度与分隔符由 fetch 重新生成
            if (lower === 'host' || lower === 'content-length' || lower === 'content-type') return;
            headers.set(key, value);
        });
        headers.set('x-dwoj-internal-token', endpoint.token);
        if (req.user) {
            const identity = { id: req.user.id, username: req.user.username, role: req.user.role };
            headers.set('x-dwoj-user', Buffer.from(JSON.stringify(identity)).toString('base64'));
        }

        const contentType = String(req.headers?.get?.('content-type') || '').toLowerCase();
        let body: BodyInit | undefined;

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const fileEntries = Object.entries(req._files || {}) as [string, File][];
            if (fileEntries.length > 0) {
                const form = new FormData();
                for (const [key, value] of Object.entries(req.body || {})) {
                    form.append(key, String(value));
                }
                for (const [key, file] of fileEntries) {
                    form.append(key, file, file.name);
                }
                body = form;
            } else if (contentType.includes('application/json')) {
                body = JSON.stringify(req.body || {});
                headers.set('content-type', 'application/json');
            } else if (contentType.includes('application/x-www-form-urlencoded')) {
                const form = new URLSearchParams();
                for (const [key, value] of Object.entries(req.body || {})) {
                    form.append(key, String(value));
                }
                body = form;
            } else if (contentType) {
                // 其它类型无法可靠重建，按空 body 转发
                headers.set('content-type', contentType);
            }
        }

        const search = new URL(req.url, 'http://localhost').search;
        const target = `http://127.0.0.1:${endpoint.port}${req.path}${search}`;
        return await fetch(target, { method: req.method, headers, body });
    }
}
