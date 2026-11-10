import path from 'path';
import fs from 'fs';
import ejs from 'ejs';
import crypto from 'crypto';
import * as config from '../config';

// ============================================================
// 类型定义
// ============================================================

export interface RequestParams {
    [key: string]: string;
}

export interface RequestQuery {
    [key: string]: string;
}

export interface RequestBody {
    [key: string]: any;
}

export interface Cookies {
    [key: string]: string;
}

export interface UploadedFile {
    fieldname: string;
    originalname: string;
    path: string;
    size: number;
    mimetype: string;
    filename: string;
    destination: string;
}

export interface RouteHandler {
    (req: ExtendedRequest, res: ExtendedResponse, next: () => Promise<void>): void | Promise<void>;
}

export interface ExtendedRequest {
    method: string;
    path: string;
    url: string;
    query: RequestQuery;
    body: RequestBody;
    cookies: Cookies;
    headers: Headers;
    params: RequestParams;
    user: any;
    app: App;
    file: UploadedFile | null;
    _files: Record<string, File>;
    _raw: Request;
}

export interface SetCookieOptions {
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    path?: string;
}

export interface ExtendedResponse {
    _status: number;
    _headers: Record<string, string>;
    _body: any;
    _redirectUrl: string | null;
    _cookies: string[];
    _sent: boolean;
    _locals: Record<string, any>;
    locals: Record<string, any>;
    status: (code: number) => ExtendedResponse;
    send: (data: any) => void;
    json: (data: any) => void;
    redirect: (url: string, status?: number) => void;
    cookie: (name: string, value: string, options?: SetCookieOptions) => void;
    clearCookie: (name: string) => void;
    render: (viewName: string, data?: Record<string, any>) => Promise<void>;
    type: (contentType: string) => ExtendedResponse;
}

interface RouteEntry {
    method: string;
    regex: RegExp;
    paramNames: string[];
    handlers: RouteHandler[];
}

interface MiddlewareEntry {
    prefix: string;
    handler: Router | RouteHandler;
    isRouter: boolean;
}

interface CompiledMw {
    kind: 'mw';
    prefix: string;
    handler: RouteHandler;
}

interface CompiledRoute {
    kind: 'route';
    owner: Router;
    prefix: string;
    method: string;
    regex: RegExp;
    paramNames: string[];
    handlers: RouteHandler[];
}

type CompiledStep = CompiledMw | CompiledRoute;

const MIME_MAP: Record<string, string> = {
    '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
    '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

// ============================================================
// Router — 路由管理器
// ============================================================

export class Router {
    _routes: RouteEntry[] = [];
    _prefix: string = '';
    _middleware: RouteHandler[] = [];
    _subRouters: Router[] = [];

    private _addRoute(method: string, pathPattern: string, handlers: RouteHandler[]): void {
        const paramNames: string[] = [];
        const regexStr = pathPattern.replace(/:([^/]+)/g, (_: string, name: string) => {
            paramNames.push(name);
            return '([^/]+)';
        });
        const regex = new RegExp(`^${regexStr}$`);
        this._routes.push({ method: method.toUpperCase(), regex, paramNames, handlers });
    }

    get(path: string, ...handlers: RouteHandler[]): void { this._addRoute('GET', path, handlers); }
    post(path: string, ...handlers: RouteHandler[]): void { this._addRoute('POST', path, handlers); }
    put(path: string, ...handlers: RouteHandler[]): void { this._addRoute('PUT', path, handlers); }
    delete(path: string, ...handlers: RouteHandler[]): void { this._addRoute('DELETE', path, handlers); }

    use(handler: Router | RouteHandler): void {
        if (handler instanceof Router) {
            this._subRouters.push(handler);
        } else if (typeof handler === 'function') {
            this._middleware.push(handler);
        }
    }

    _match(method: string, pathname: string): { params: RequestParams; handlers: RouteHandler[] } | null {
        for (const route of this._routes) {
            if (route.method !== method) continue;
            const m = pathname.match(route.regex);
            if (m) {
                const params: RequestParams = {};
                route.paramNames.forEach((name, i) => {
                    params[name] = decodeURIComponent(m[i + 1]);
                });
                return { params, handlers: route.handlers };
            }
        }
        return null;
    }
}

// ============================================================
// UploadHandler — 文件上传处理 (替代 multer)
// ============================================================

export class UploadHandler {
    private dest: string;

    constructor(options: { dest: string }) {
        this.dest = options.dest;
        fs.mkdirSync(this.dest, { recursive: true });
    }

    single(fieldName: string): RouteHandler {
        return async (req: ExtendedRequest, res: ExtendedResponse, next: () => Promise<void>) => {
            const file = req._files?.[fieldName];
            if (file) {
                const ext = path.extname(file.name) || '';
                const fileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
                const filePath = path.join(this.dest, fileName);
                await Bun.write(filePath, new Response(file.stream()));
                req.file = {
                    fieldname: fieldName,
                    originalname: file.name,
                    path: filePath,
                    size: file.size,
                    mimetype: file.type,
                    filename: fileName,
                    destination: this.dest,
                };
            }
            next();
        };
    }
}

// ============================================================
// App — 应用主类 (封装 Bun.serve)
// ============================================================

export class App {
    _middleware: MiddlewareEntry[] = [];
    _settings: Record<string, any> = {};
    _viewsDir: string = path.join(process.cwd(), 'views');
    _viewCache: Record<string, ejs.TemplateFunction> = {};
    _pluginManager: any = null;
    _server: any = null;
    _router: Router = new Router();
    _compiled: CompiledStep[] | null = null;

    set(key: string, value: any): void { this._settings[key] = value; }

    /** 设置读取 (1 个参数) 或 HTTP 路由注册 (≥2 个参数) */
    get(key: string, ...handlers: RouteHandler[]): any {
        if (handlers.length > 0) {
            this._router.get(key, ...handlers);
            this._compiled = null;
            return;
        }
        return this._settings[key];
    }

    post(path: string, ...handlers: RouteHandler[]): void {
        this._router.post(path, ...handlers);
        this._compiled = null;
    }

    put(path: string, ...handlers: RouteHandler[]): void {
        this._router.put(path, ...handlers);
        this._compiled = null;
    }

    delete(path: string, ...handlers: RouteHandler[]): void {
        this._router.delete(path, ...handlers);
        this._compiled = null;
    }

    use(...args: any[]): void {
        if (args.length === 1) {
            const h = args[0];
            if (h instanceof Router || typeof h === 'function') {
                this._middleware.push({ prefix: '/', handler: h, isRouter: h instanceof Router });
            }
        } else if (args.length === 2) {
            this._middleware.push({ prefix: args[0], handler: args[1], isRouter: args[1] instanceof Router });
        }
        this._compiled = null;
    }

    static(dir: string): RouteHandler {
        const dirPath = path.resolve(dir);
        const index = new Map<string, { filePath: string; mtime: number; etag: string }>();

        // 启动时建立静态资源索引，请求时不再做 existsSync/statSync
        const walk = (current: string, urlPrefix: string): void => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const fullPath = path.join(current, entry.name);
                const urlPath = `${urlPrefix}/${entry.name}`;
                if (entry.isDirectory()) {
                    walk(fullPath, urlPath);
                } else {
                    const stat = fs.statSync(fullPath);
                    index.set(urlPath, {
                        filePath: fullPath,
                        mtime: stat.mtimeMs,
                        etag: `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`,
                    });
                }
            }
        };
        if (fs.existsSync(dirPath)) walk(dirPath, '');

        return async (req: ExtendedRequest, res: ExtendedResponse, next: () => Promise<void>) => {
            const entry = index.get(req.path);
            if (!entry) {
                next();
                return;
            }

            const clientEtag = req.headers.get('if-none-match');
            const ifModifiedSince = req.headers.get('if-modified-since');
            const notModified =
                (clientEtag !== null && clientEtag === entry.etag) ||
                (ifModifiedSince !== null && new Date(ifModifiedSince).getTime() >= Math.floor(entry.mtime / 1000) * 1000);

            res._headers['Cache-Control'] = 'public, max-age=86400';
            res._headers['ETag'] = entry.etag;
            res._headers['Last-Modified'] = new Date(entry.mtime).toUTCString();

            if (notModified) {
                res._status = 304;
                res._body = '';
                res._sent = true;
            } else {
                const ext = path.extname(entry.filePath).toLowerCase();
                res._status = 200;
                res._headers['Content-Type'] = MIME_MAP[ext] || 'application/octet-stream';
                res._body = Bun.file(entry.filePath);
                res._sent = true;
            }
            next();
        };
    }

    async renderView(viewName: string, data: Record<string, any>): Promise<string> {
        const viewPath = path.join(this._viewsDir, viewName.endsWith('.ejs') ? viewName : viewName + '.ejs');
        let template = this._viewCache[viewPath];
        if (!template) {
            if (!fs.existsSync(viewPath)) {
                throw new Error(`View not found: ${viewPath}`);
            }
            const content = fs.readFileSync(viewPath, 'utf-8');
            template = ejs.compile(content, { filename: viewPath, cache: true });
            this._viewCache[viewPath] = template;
        }
        return template(data);
    }

    /** 启动/注册变更后摊平路由与中间件，避免每请求递归重建 */
    private _compileRoutes(): CompiledStep[] {
        const steps: CompiledStep[] = [];

        const addRouter = (router: Router, prefix: string): void => {
            for (const route of router._routes) {
                steps.push({
                    kind: 'route',
                    owner: router,
                    prefix,
                    method: route.method,
                    regex: route.regex,
                    paramNames: route.paramNames,
                    handlers: route.handlers,
                });
            }
            for (const sub of router._subRouters) addRouter(sub, prefix);
            for (const mw of router._middleware) steps.push({ kind: 'mw', prefix, handler: mw });
        };

        for (const entry of this._middleware) {
            if (entry.isRouter && entry.handler instanceof Router) {
                addRouter(entry.handler, entry.prefix);
            } else if (typeof entry.handler === 'function') {
                steps.push({ kind: 'mw', prefix: entry.prefix, handler: entry.handler as RouteHandler });
            }
        }

        // app.get/post/put/delete 注册的路由优先匹配
        const appRouterSteps: CompiledStep[] = [];
        for (const route of this._router._routes) {
            appRouterSteps.push({
                kind: 'route',
                owner: this._router,
                prefix: '/',
                method: route.method,
                regex: route.regex,
                paramNames: route.paramNames,
                handlers: route.handlers,
            });
        }
        return [...appRouterSteps, ...steps];
    }

    listen(port: number, callback?: () => void): any {
        this._compiled = this._compileRoutes();
        this._server = Bun.serve({
            port,
            maxRequestBodySize: config.MAX_BODY_SIZE,
            development: false,
            idleTimeout: 30,
            fetch: (req: Request) => this._handleRequest(req),
        });
        if (callback) callback();
        return this._server;
    }

    private async _handleRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        const pathname = url.pathname;

        const contentType = request.headers.get('content-type') || '';

        // ---- 请求体大小前置检查（同时在 Bun.serve 层限制 8 MB）----
        if (method === 'POST' || method === 'PUT') {
            const declaredLength = Number(request.headers.get('content-length') || 0);
            const isMultipart = contentType.includes('multipart/form-data');
            const limit = isMultipart ? config.MAX_BODY_SIZE : config.URLENCODED_BODY_LIMIT;
            if (declaredLength > limit) {
                return new Response('Payload Too Large', { status: 413 });
            }
        }

        // ---- 解析请求体 ----
        let body: Record<string, any> = {};
        const files: Record<string, File> = {};

        if (method === 'POST' || method === 'PUT') {
            if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
                try {
                    const formData = await request.formData();
                    for (const [key, value] of formData) {
                        if (value instanceof File) {
                            files[key] = value;
                        } else {
                            body[key] = value;
                        }
                    }
                } catch (_) { /* ignore parse errors */ }
            }
        }

        // ---- 解析 Cookie ----
        const cookies: Record<string, string> = {};
        const cookieHeader = request.headers.get('cookie');
        if (cookieHeader) {
            cookieHeader.split(';').forEach(c => {
                const eqIdx = c.indexOf('=');
                if (eqIdx > 0) {
                    const name = c.substring(0, eqIdx).trim();
                    const value = c.substring(eqIdx + 1).trim();
                    cookies[name] = value;
                }
            });
        }

        // ---- 构建 req 对象 ----
        const req: ExtendedRequest = {
            method,
            path: pathname,
            url: request.url,
            query: Object.fromEntries(url.searchParams),
            body,
            cookies,
            headers: request.headers,
            params: {},
            user: null,
            app: this,
            file: null,
            _files: files,
            _raw: request,
        };

        // ---- 构建 res 对象 ----
        let handlerIndex = 0;
        const handlers: RouteHandler[] = [];

        const res: ExtendedResponse = {
            _status: 200,
            _headers: {},
            _body: null,
            _redirectUrl: null,
            _cookies: [],
            _sent: false,
            _locals: {},

            get locals() { return this._locals; },
            set locals(v) { this._locals = v; },

            status(code: number) { this._status = code; return this; },

            send(data: any) {
                if (this._sent) return;
                this._sent = true;
                if (typeof data === 'object' && data !== null && !(data instanceof Blob)) {
                    this._body = JSON.stringify(data);
                    this._headers['Content-Type'] = 'application/json';
                } else {
                    this._body = String(data ?? '');
                    this._headers['Content-Type'] = this._headers['Content-Type'] || 'text/html; charset=utf-8';
                }
            },

            json(data: any) {
                if (this._sent) return;
                this._sent = true;
                this._body = JSON.stringify(data);
                this._headers['Content-Type'] = 'application/json';
            },

            redirect(url: string, status = 302) {
                if (this._sent) return;
                this._sent = true;
                this._status = status;
                this._redirectUrl = url;
            },

            cookie(name: string, value: string, options: SetCookieOptions = {}) {
                let cookieStr = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
                if (options.maxAge !== undefined) cookieStr += `; Max-Age=${options.maxAge}`;
                if (options.httpOnly) cookieStr += '; HttpOnly';
                if (options.secure) cookieStr += '; Secure';
                if (options.path) cookieStr += `; Path=${options.path}`;
                this._cookies.push(cookieStr);
            },

            clearCookie(name: string) {
                this.cookie(name, '', { maxAge: 0 });
            },

            async render(viewName: string, data?: Record<string, any>) {
                if (this._sent) return;
                try {
                    const mergedData = { ...this._locals, ...(data || {}) };
                    const html = await req.app.renderView(viewName, mergedData);
                    this._sent = true;
                    this._body = html;
                    this._headers['Content-Type'] = 'text/html; charset=utf-8';
                } catch (err) {
                    console.error('Render error:', err);
                    this._status = 500;
                    this._sent = true;
                    this._body = 'Template rendering error';
                    this._headers['Content-Type'] = 'text/html; charset=utf-8';
                }
            },

            type(contentType: string) {
                this._headers['Content-Type'] = contentType;
                return this;
            }
        };

        // ---- 匹配预编译路由（启动时已摊平）----
        if (!this._compiled) this._compiled = this._compileRoutes();
        const matchedRouters = new Set<Router>();

        for (const step of this._compiled) {
            if (step.kind === 'mw') {
                if (step.prefix === '/' || pathname.startsWith(step.prefix)) handlers.push(step.handler);
                continue;
            }

            if (step.method !== method || matchedRouters.has(step.owner)) continue;

            let relPath: string;
            if (step.prefix === '/') {
                relPath = pathname;
            } else if (pathname.startsWith(step.prefix)) {
                relPath = '/' + pathname.slice(step.prefix.length).replace(/^\/+/, '');
            } else {
                continue;
            }

            const m = relPath.match(step.regex);
            if (!m) continue;

            matchedRouters.add(step.owner);
            const params: RequestParams = {};
            step.paramNames.forEach((name, i) => {
                params[name] = decodeURIComponent(m[i + 1]);
            });
            req.params = params;
            handlers.push(...step.handlers);
        }

        // ---- 执行处理链 ----
        const next = async () => {
            if (res._sent) return;
            if (handlerIndex >= handlers.length) {
                if (!res._sent) {
                    res._status = 404;
                    res.send('Not Found');
                }
                return;
            }
            const handler = handlers[handlerIndex++];
            try {
                const result = handler(req, res, next);
                if (result instanceof Promise) await result;
            } catch (err) {
                console.error('Handler error:', err);
                if (!res._sent) {
                    res._status = 500;
                    res.send('Internal Server Error');
                }
            }
        };

        await next();

        // ---- 构建最终 Response ----
        if (res._sent && res._redirectUrl) {
            const headers: Record<string, string | string[]> = { Location: res._redirectUrl };
            if (res._cookies.length > 0) headers['Set-Cookie'] = res._cookies;
            return new Response(null, { status: res._status || 302, headers: headers as any });
        }

        const responseHeaders: Record<string, string | string[]> = { ...res._headers };
        if (res._cookies.length > 0) {
            responseHeaders['Set-Cookie'] = res._cookies;
        }

        // 304/204 不允许携带 body
        if (res._status === 304 || res._status === 204) {
            return new Response(null, { status: res._status, headers: responseHeaders as any });
        }

        if (res._body instanceof Blob) {
            return new Response(res._body, { status: res._status || 200, headers: responseHeaders as any });
        }

        const bodyStr = typeof res._body === 'string' ? res._body : '';
        return new Response(bodyStr, {
            status: res._status || 200,
            headers: responseHeaders as any,
        });
    }
}