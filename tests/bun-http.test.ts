import { describe, expect, test, mock, beforeEach, afterAll } from 'bun:test';
import { Router, App, UploadHandler } from '../lib/bun-http';
import type { ExtendedRequest, ExtendedResponse, RouteHandler } from '../lib/bun-http';

// ============================================================
// Router Tests
// ============================================================
describe('Router', () => {
    let router: Router;

    beforeEach(() => {
        router = new Router();
    });

    test('get adds a GET route', () => {
        const handler = async () => {};
        router.get('/test', handler);
        expect(router._routes.length).toBe(1);
        expect(router._routes[0].method).toBe('GET');
    });

    test('post adds a POST route', () => {
        const handler = async () => {};
        router.post('/test', handler);
        expect(router._routes.length).toBe(1);
        expect(router._routes[0].method).toBe('POST');
    });

    test('put adds a PUT route', () => {
        const handler = async () => {};
        router.put('/test', handler);
        expect(router._routes.length).toBe(1);
        expect(router._routes[0].method).toBe('PUT');
    });

    test('delete adds a DELETE route', () => {
        const handler = async () => {};
        router.delete('/test', handler);
        expect(router._routes.length).toBe(1);
        expect(router._routes[0].method).toBe('DELETE');
    });

    test('_match finds exact path', () => {
        const handler = async () => {};
        router.get('/hello', handler);
        const result = router._match('GET', '/hello');
        expect(result).not.toBeNull();
        expect(result!.handlers).toContain(handler);
        expect(result!.params).toEqual({});
    });

    test('_match extracts URL parameters', () => {
        const handler = async () => {};
        router.get('/users/:userId/posts/:postId', handler);
        const result = router._match('GET', '/users/42/posts/99');
        expect(result).not.toBeNull();
        expect(result!.params).toEqual({ userId: '42', postId: '99' });
    });

    test('_match returns null for non-matching path', () => {
        router.get('/users/:id', async () => {});
        const result = router._match('GET', '/posts');
        expect(result).toBeNull();
    });

    test('_match returns null for wrong method', () => {
        router.get('/test', async () => {});
        const result = router._match('POST', '/test');
        expect(result).toBeNull();
    });

    test('_match decodes URL parameters', () => {
        router.get('/search/:query', async () => {});
        const result = router._match('GET', '/search/hello%20world');
        expect(result).not.toBeNull();
        expect(result!.params).toEqual({ query: 'hello world' });
    });

    test('multiple handlers on same route', () => {
        const handler1 = async () => {};
        const handler2 = async () => {};
        router.get('/multi', handler1, handler2);
        const result = router._match('GET', '/multi');
        expect(result).not.toBeNull();
        expect(result!.handlers).toHaveLength(2);
        expect(result!.handlers[0]).toBe(handler1);
        expect(result!.handlers[1]).toBe(handler2);
    });

    test('_match with root path', () => {
        const handler = async () => {};
        router.get('/', handler);
        const result = router._match('GET', '/');
        expect(result).not.toBeNull();
        expect(result!.handlers).toContain(handler);
    });

    test('addRoute allows duplicate paths with different methods', () => {
        const getHandler = async () => {};
        const postHandler = async () => {};
        router.get('/resource', getHandler);
        router.post('/resource', postHandler);

        const getResult = router._match('GET', '/resource');
        const postResult = router._match('POST', '/resource');

        expect(getResult!.handlers).toContain(getHandler);
        expect(postResult!.handlers).toContain(postHandler);
    });

    test('use adds middleware', () => {
        const middleware = async () => {};
        router.use(middleware);
        expect(router._middleware).toHaveLength(1);
        expect(router._middleware[0]).toBe(middleware);
    });

    test('use adds sub-router', () => {
        const subRouter = new Router();
        router.use(subRouter);
        expect(router._subRouters).toHaveLength(1);
        expect(router._subRouters[0]).toBe(subRouter);
    });
});

// ============================================================
// App Tests
// ============================================================
describe('App', () => {
    let app: App;

    beforeEach(() => {
        app = new App();
    });

    test('set and get settings', () => {
        app.set('view engine', 'ejs');
        expect(app.get('view engine')).toBe('ejs');
    });

    test('set and get arbitrary values', () => {
        app.set('port', 3000);
        expect(app.get('port')).toBe(3000);
    });

    test('use registers middleware with default prefix', () => {
        const handler = async () => {};
        app.use(handler);
        expect(app._middleware).toHaveLength(1);
        expect(app._middleware[0].prefix).toBe('/');
        expect(app._middleware[0].handler).toBe(handler);
        expect(app._middleware[0].isRouter).toBe(false);
    });

    test('use registers middleware with custom prefix', () => {
        const handler = async () => {};
        app.use('/api', handler);
        expect(app._middleware[0].prefix).toBe('/api');
    });

    test('use registers router', () => {
        const router = new Router();
        app.use(router);
        expect(app._middleware[0].isRouter).toBe(true);
        expect(app._middleware[0].handler).toBe(router);
    });

    test('listen starts server and calls callback', async () => {
        const callback = mock(() => {});
        const server = app.listen(0, callback);
        expect(server).toBeDefined();
        expect(callback).toHaveBeenCalled();
        server.stop();
    });

    test('listen returns server with stop method', () => {
        const server = app.listen(0);
        expect(server).toBeDefined();
        expect(typeof server.stop).toBe('function');
        server.stop();
    });

    test('renderView throws for non-existent view', async () => {
        try {
            await app.renderView('non_existent_view', {});
            // Should not reach here
            expect(true).toBe(false);
        } catch (err: any) {
            expect(err.message).toContain('not found');
        }
    });

    test('handleRequest returns 404 for unknown routes', async () => {
        const server = app.listen(0);
        const url = `http://localhost:${server.port}/unknown-route`;
        const response = await fetch(url);
        expect(response.status).toBe(404);
        const text = await response.text();
        expect(text).toBe('Not Found');
        server.stop();
    });

    test('handleRequest processes middleware chain', async () => {
        const middlewareOrder: number[] = [];

        app.use(async (_req: ExtendedRequest, _res: ExtendedResponse, next: () => Promise<void>) => {
            middlewareOrder.push(1);
            await next();
        });

        app.use(async (_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            middlewareOrder.push(2);
            res.send('hello');
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/test`);
        expect(response.status).toBe(200);
        expect(middlewareOrder).toEqual([1, 2]);
        server.stop();
    });

    test('handleRequest sets cookies correctly on redirect', async () => {
        app.use((_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.cookie('token', 'abc123', { httpOnly: true });
            res.redirect('/');
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/redirect-test`, {
            redirect: 'manual',
        });
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/');
        const setCookie = response.headers.get('Set-Cookie');
        expect(setCookie).toContain('token=abc123');
        expect(setCookie).toContain('HttpOnly');
        server.stop();
    });

    test('handleRequest returns JSON', async () => {
        app.use((_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.json({ message: 'ok', code: 200 });
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/json`);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('application/json');
        const data = await response.json();
        expect(data).toEqual({ message: 'ok', code: 200 });
        server.stop();
    });

    test('handleRequest sets custom status code', async () => {
        app.use((_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.status(201).send('created');
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/create`);
        expect(response.status).toBe(201);
        server.stop();
    });

    test('router matching in app', async () => {
        const router = new Router();
        router.get('/hello', async (_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.send('world');
        });

        app.use(router);

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/hello`);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toBe('world');
        server.stop();
    });

    test('router with URL parameters in app', async () => {
        const router = new Router();
        router.get('/users/:id', async (req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.json({ userId: req.params.id });
        });

        app.use(router);

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/users/42`);
        const data = await response.json();
        expect(data).toEqual({ userId: '42' });
        server.stop();
    });

    test('query parameters are parsed', async () => {
        app.use((req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.json({ q: req.query.q, page: req.query.page });
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/search?q=test&page=2`);
        const data = await response.json();
        expect(data).toEqual({ q: 'test', page: '2' });
        server.stop();
    });

    test('POST form data is parsed', async () => {
        app.use(async (req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.json({ body: req.body });
        });

        const server = app.listen(0);
        const formData = new FormData();
        formData.append('username', 'testuser');
        formData.append('action', 'login');

        const response = await fetch(`http://localhost:${server.port}/form`, {
            method: 'POST',
            body: formData,
        });
        const data = await response.json();
        expect(data.body.username).toBe('testuser');
        expect(data.body.action).toBe('login');
        server.stop();
    });

    test('cookies are parsed from request', async () => {
        app.use((req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.json({ cookies: req.cookies });
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/cookies`, {
            headers: { Cookie: 'session=abc; theme=dark' },
        });
        const data = await response.json();
        expect(data.cookies.session).toBe('abc');
        expect(data.cookies.theme).toBe('dark');
        server.stop();
    });

    test('clearCookie sets maxAge 0', async () => {
        app.use((_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.clearCookie('session');
            res.redirect('/');
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/clear-cookie`, {
            redirect: 'manual',
        });
        const setCookie = response.headers.get('Set-Cookie');
        expect(setCookie).toContain('session=');
        expect(setCookie).toContain('Max-Age=0');
        server.stop();
    });

    test('next() skips to next handler', async () => {
        let step = 0;

        app.use(async (_req: ExtendedRequest, _res: ExtendedResponse, next: () => Promise<void>) => {
            step = 1;
            await next();
            step = 3;
        });

        app.use(async (_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            expect(step).toBe(1);
            step = 2;
            res.send('done');
        });

        const server = app.listen(0);
        await fetch(`http://localhost:${server.port}/chain`);
        expect(step).toBe(3);
        server.stop();
    });

    test('handler error does not crash server', async () => {
        app.use(async (_req: ExtendedRequest, _res: ExtendedResponse, _next: () => Promise<void>) => {
            throw new Error('test error');
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/error`);
        // Server should still respond with 500
        expect(response.status).toBe(500);
        server.stop();
    });

    test('send called twice only sends once', async () => {
        app.use((_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.send('first');
            res.send('second'); // Should be ignored
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/double-send`);
        const text = await response.text();
        expect(text).toBe('first');
        server.stop();
    });

    test('type sets Content-Type header', async () => {
        app.use((_req: ExtendedRequest, res: ExtendedResponse, _next: () => Promise<void>) => {
            res.type('text/plain').send('plain text');
        });

        const server = app.listen(0);
        const response = await fetch(`http://localhost:${server.port}/type-test`);
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        server.stop();
    });
});

// ============================================================
// UploadHandler Tests
// ============================================================
describe('UploadHandler', () => {
    const testDir = 'tests/_upload_test';

    beforeEach(() => {
        // Create test directory
        try {
            const fs = require('fs');
            fs.mkdirSync(testDir, { recursive: true });
        } catch {}
    });

    afterAll(() => {
        // Cleanup test directory
        try {
            const fs = require('fs');
            const path = require('path');
            const rmDir = (dir: string) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        rmDir(fullPath);
                    } else {
                        fs.unlinkSync(fullPath);
                    }
                }
                fs.rmdirSync(dir);
            };
            if (fs.existsSync(testDir)) {
                rmDir(testDir);
            }
        } catch {}
    });

    test('constructor creates destination directory', () => {
        const uploader = new UploadHandler({ dest: testDir });
        const fs = require('fs');
        expect(fs.existsSync(testDir)).toBe(true);
    });

    test('single returns a RouteHandler function', () => {
        const uploader = new UploadHandler({ dest: testDir });
        const handler = uploader.single('file');
        expect(typeof handler).toBe('function');
    });

    test('single handler calls next when no file', async () => {
        const uploader = new UploadHandler({ dest: testDir });
        const handler = uploader.single('file');

        const req = { _files: {} } as any as ExtendedRequest;
        const res = {} as any as ExtendedResponse;
        const next = mock(() => {});

        await handler(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(req.file).toBeUndefined();
    });
});