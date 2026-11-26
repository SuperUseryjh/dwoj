import { call } from '../ipc/node';
import { createLogger } from '../logger';
import type { PluginManager } from './manager';
import type { PluginInfo, PluginRequest } from './types';
import {
    PLUGIN_RPC,
    PLUGIN_RPC_TIMEOUTS,
    snapshotRequest,
    type JudgeHook,
    type PluginEndpoint,
} from './protocol';

const logger = createLogger('plugin');

/**
 * 插件宿主接口。
 *
 * 单进程模式下由 `LocalPluginHost` 直接调用内存里的 `PluginManager`；
 * 多进程模式下由 `RemotePluginHost` 通过 broker 把调用转发给 plugin 进程。
 */
export interface PluginHost {
    inject(req: PluginRequest): Promise<{ header: string; footer: string; styles: string }>;
    runJudgeHook(hook: JudgeHook, submission: any): Promise<any>;
    getList(): Promise<PluginInfo[]>;
    toggle(filename: string, enabled: boolean): Promise<void>;
    delete(filename: string): Promise<void>;
    reload(): Promise<void>;
    proxy(req: any): Promise<Response | null>;
}

/** 统一的宿主工厂：有本地 manager 用本地实现，否则走 IPC */
export function createPluginHost(manager?: PluginManager): PluginHost {
    return manager ? new LocalPluginHost(manager) : new RemotePluginHost();
}

/** 单进程模式：直接使用本进程内的 PluginManager */
export class LocalPluginHost implements PluginHost {
    constructor(private readonly manager: PluginManager) { }

    inject(req: PluginRequest): Promise<{ header: string; footer: string; styles: string }> {
        return this.manager.inject(req);
    }

    runJudgeHook(hook: JudgeHook, submission: any): Promise<any> {
        return hook === 'beforeJudge'
            ? this.manager.beforeJudge(submission)
            : this.manager.afterJudge(submission);
    }

    getList(): Promise<PluginInfo[]> {
        return Promise.resolve(this.manager.getList());
    }

    toggle(filename: string, enabled: boolean): Promise<void> {
        return this.manager.toggle(filename, enabled);
    }

    delete(filename: string): Promise<void> {
        return this.manager.delete(filename);
    }

    reload(): Promise<void> {
        return this.manager.reload();
    }

    async proxy(): Promise<Response | null> {
        // 单进程模式下插件路由直接挂在主应用上，不需要转发
        return null;
    }
}

/** 多进程模式：通过 broker 调用 plugin 进程 */
export class RemotePluginHost implements PluginHost {
    private endpointPromise: Promise<PluginEndpoint> | null = null;

    private endpoint(): Promise<PluginEndpoint> {
        if (!this.endpointPromise) {
            this.endpointPromise = call<PluginEndpoint>(
                'plugin', PLUGIN_RPC.HTTP_INFO, {}, PLUGIN_RPC_TIMEOUTS.info,
            ).catch(err => {
                this.endpointPromise = null;
                throw err;
            });
        }
        return this.endpointPromise;
    }

    async inject(req: PluginRequest): Promise<{ header: string; footer: string; styles: string }> {
        try {
            return await call(
                'plugin', PLUGIN_RPC.INJECT, { req: snapshotRequest(req) }, PLUGIN_RPC_TIMEOUTS.inject,
            );
        } catch (err) {
            logger.error('plugin inject hook failed', err as Error);
            return { header: '', footer: '', styles: '' };
        }
    }

    async runJudgeHook(hook: JudgeHook, submission: any): Promise<any> {
        try {
            return await call(
                'plugin', PLUGIN_RPC.JUDGE, { hook, submission }, PLUGIN_RPC_TIMEOUTS.judge,
            );
        } catch (err) {
            logger.error(`plugin ${hook} hook failed`, err as Error);
            return submission;
        }
    }

    getList(): Promise<PluginInfo[]> {
        return call('plugin', PLUGIN_RPC.LIST, {}, PLUGIN_RPC_TIMEOUTS.list);
    }

    toggle(filename: string, enabled: boolean): Promise<void> {
        return call('plugin', PLUGIN_RPC.TOGGLE, { filename, enabled }, PLUGIN_RPC_TIMEOUTS.toggle);
    }

    delete(filename: string): Promise<void> {
        return call('plugin', PLUGIN_RPC.DELETE, { filename }, PLUGIN_RPC_TIMEOUTS.delete);
    }

    reload(): Promise<void> {
        return call('plugin', PLUGIN_RPC.RELOAD, {}, PLUGIN_RPC_TIMEOUTS.reload);
    }

    async proxy(req: any): Promise<Response | null> {
        let endpoint = await this.endpoint();
        try {
            return await this.forward(req, endpoint);
        } catch {
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
