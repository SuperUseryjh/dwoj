import path from 'path';
import fs from 'fs';
import ejs from 'ejs';
import crypto from 'crypto';

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

    set(key: string, value: any): void { this._settings[key] = value; }
    get(key: string): any { return this._settings[key]; }

    use(...args: any[]): void {
        if (args.length === 1) {
            const h = args[0];
            if (h instanceof Router || typeof h === 'function') {
                this._middleware.push({ prefix: '/', handler: h, isRouter: h instanceof Router });
            }
        } else if (args.length === 2) {
            this._middleware.push({ prefix: args[0], handler: args[1], isRouter: args[1] instanceof Router });
        }
    }

    static(dir: string): RouteHandler {
        const dirPath = path.resolve(dir);
        return async (req: ExtendedRequest, res: ExtendedResponse, next: () => Promise<void>) => {
            const filePath = path.join(dirPath, '.' + req.path);
            if (filePath.startsWith(dirPath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath).toLowerCase();
                const mimeMap: Record<string, string> = {
                    '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html',
                    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
                    '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
                    '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
                };
                const file = Bun.file(filePath);
                res._status = 200;
                res._headers['Content-Type'] = mimeMap[ext] || 'application/octet-stream';
                res._body = file;
                res._sent = true;
            }
            next();
        };
    }

    async renderView(viewName: string, data: Record<string, any>): Promise<string> {
        const viewPath = path.join(this._viewsDir, viewName.endsWith('.ejs') ? viewName : viewName + '.ejs');
        if (!fs.existsSync(viewPath)) {
            throw new Error(`View not found: ${viewPath}`);
        }
        const content = fs.readFileSync(viewPath, 'utf-8');
        const template = ejs.compile(content, { filename: viewPath });
        return template(data);
    }

    listen(port: number, callback?: () => void): any {
        this._server = Bun.serve({
            port,
            fetch: (req: Request) => this._handleRequest(req),
        });
        if (callback) callback();
        return this._server;
    }

    private async _handleRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        const pathname = url.pathname;

        // ---- 解析请求体 ----
        let body: Record<string, any> = {};
        const files: Record<string, File> = {};
        const contentType = request.headers.get('content-type') || '';

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

        // ---- 收集所有中间件和处理函数 ----
        const allMiddleware: MiddlewareEntry[] = [...this._middleware];

        for (const mw of allMiddleware) {
            if (mw.isRouter && mw.handler instanceof Router) {
                const router = mw.handler;
                const relPath = pathname.startsWith(mw.prefix)
                    ? '/' + pathname.slice(mw.prefix.length).replace(/^\/+/, '')
                    : null;

                if (relPath !== null) {
                    const match = router._match(method, relPath);
                    if (match) {
                        req.params = match.params;
                        handlers.push(...match.handlers);
                        continue;
                    }
                    handlers.push(...router._middleware);
                    for (const sub of router._subRouters) {
                        allMiddleware.push({ prefix: mw.prefix, handler: sub, isRouter: true });
                    }
                }
            } else if (typeof mw.handler === 'function') {
                if (mw.prefix === '/' || pathname.startsWith(mw.prefix)) {
                    handlers.push(mw.handler as RouteHandler);
                }
            }
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