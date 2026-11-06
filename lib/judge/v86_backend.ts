import crypto from 'crypto';
import fs from 'fs-extra';
import * as config from '../../config';
import { createLogger } from '../logger';
import { ExecuteOutcome, ExecuteRequest, ExecutionBackend, JudgeError, runtimeErrorMessage } from './backend';
import { GUEST_DAEMON } from './guest_daemon';

const logger = createLogger('v86');

/**
 * v86 沙箱后端
 * ---------------------------------------------------------------------------
 * 把用户代码放进一台内嵌的 x86 虚拟机（v86，纯 WASM 实现的 PC 模拟器）里执行：
 *   - 客户机是 32 位 Alpine Linux（内核取自 v86 官方测试镜像，4.16 i686），
 *     v86 不支持 64 位内核、也不支持 PAE，因此只能用 32 位系统。
 *   - 客户机**没有网络设备**，看不到宿主机文件系统。
 *   - 宿主机与客户机之间只有两条通道：
 *       1. 串口：只用于启动守护进程、清理临时文件等控制命令
 *       2. 9p 共享目录：源码、输入、输出、结果 JSON 都走这里
 *   - 客户机里常驻一个 Python 守护进程（/mnt/9p/daemon.py）：
 *       * Python 代码：fork 子进程 + exec，省掉解释器冷启动（约 1~2s → 100ms 量级）
 *       * C++ 代码：g++ 编译一次（每个提交一次），然后每次 fork 出子进程跑二进制
 *   - 用户程序以 root 运行，但它破坏的只是这台一次性虚拟机，卡死就整台重建。
 */

type Emulator = any;

/** 串口控制命令的兜底超时（客户机刚启动时很慢） */
const SHELL_TIMEOUT_MS = 90000;
/** 等待守护进程就绪的上限 */
const DAEMON_READY_TIMEOUT_MS = 180000;
/** 轮询结果文件的间隔 */
const POLL_INTERVAL_MS = 10;
/** 最多缓存多少个提交的编译产物 */
const MAX_COMPILED_SUBMISSIONS = 16;

interface GuestResult {
    rc: number;
    timeMs?: number;
    compileError?: string;
    err?: string;
}

interface CompileEntry {
    hash: string;
    bin: string;
}

/**
 * 客户机返回码 → 结果类型。
 *
 * 安全约束（issue #5）：CE 只由 compileError 决定，绝不能用 "rc === 123"。
 * 否则用户程序运行期 return 123 / os._exit(123) 就会被当成编译错误，
 * 而 CE 的 message 是公开字段，stderr 里的隐藏测试输入会直接泄露。
 */
export function classifyGuestResult(
    rc: number,
    compileError?: string,
): 'CE' | 'TLE' | 'OLE' | 'OK' | 'RE' {
    if (compileError) return 'CE';
    if (rc === 0) return 'OK';
    if (rc === 124) return 'TLE';
    if (rc === 125) return 'OLE';
    return 'RE';
}

export class V86Backend implements ExecutionBackend {
    readonly name = 'v86';
    readonly languages = config.V86_LANGUAGES;

    private emulator: Emulator | null = null;
    private serial = '';
    private booted = false;
    private bootPromise: Promise<void> | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private executed = 0;
    private usedBins = new Set<string>();
    private compiled = new Map<number, CompileEntry>();

    // ------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------

    async init(): Promise<void> {
        await this.ensureGuest();
    }

    async dispose(): Promise<void> {
        await this.destroyGuest();
    }

    async execute(req: ExecuteRequest): Promise<ExecuteOutcome> {
        if (!this.languages.includes(req.language)) {
            return { status: 'CE', message: `沙箱模式暂不支持该语言：${req.language}` };
        }
        // 同一时刻只允许一个用例占用虚拟机
        const task = this.chain.then(() => this.runJob(req));
        this.chain = task.then(() => undefined, () => undefined);
        return task;
    }

    // ------------------------------------------------------------
    // 单次执行
    // ------------------------------------------------------------

    /** 串行执行一个用例（调用方保证不会并发进来） */
    private async runJob(req: ExecuteRequest): Promise<ExecuteOutcome> {
        await this.ensureGuest();

        const tag = crypto.randomBytes(6).toString('hex');
        const isCpp = req.language === 'cpp';
        const src = isCpp ? `sol_${tag}.cpp` : `sol_${tag}.py`;
        const inp = `in_${tag}.txt`;
        // 沙箱内的编译产物（仅 root 可访问；每次运行时硬链接到私有 work 目录）
        const bin = `/opt/bin/prog_${req.submissionId ?? 'anon'}`;
        const compile = isCpp && this.needsCompile(req, bin);
        const limit = req.timeLimitMs;
        const compileTimeout = config.V86_COMPILE_TIMEOUT_MS;

        try {
            // 先写输入/源码/空结果文件，最后写 job 文件（守护进程以 job 文件出现为准）
            await this.writeGuestFile(src, req.code);
            await this.writeGuestFile(inp, req.input);
            for (const name of [`out_${tag}.txt`, `err_${tag}.txt`, `res_${tag}.json`]) {
                await this.writeGuestFile(name, '');
            }
            await this.writeGuestFile(`job_${tag}.json`, JSON.stringify({
                lang: req.language,
                limit,
                maxOut: req.maxOutputBytes,
                compile,
                src,
                inp,
                bin,
                compileTimeoutMs: compileTimeout,
                rmBins: this.drainStaleBins(),
            }));

            const deadline = Date.now() + limit + config.V86_RUN_GRACE_MS + (compile ? compileTimeout : 0);
            const ready = await this.waitForGuestFile(`ok_${tag}`, deadline);
            if (!ready) {
                logger.warn(`job ${tag} did not finish in time, recycling VM`);
                await this.recycleGuest();
                return { status: 'TLE', message: `运行超时（超过 ${limit} ms）或客户机无响应` };
            }

            const result = await this.readGuestResult(tag);
            const rc = result.rc;
            const timeMs = Number(result.timeMs) || 0;
            const kind = classifyGuestResult(rc, result.compileError);

            // 只有编译确实成功（进入运行阶段）才把缓存登记为可复用；
            // CE 时产物不存在，登记了会让重测直接跑空缓存（issue #6 建议 5）。
            if (isCpp && compile && kind !== 'CE') {
                this.markCompiled(req, bin);
            }

            if (kind === 'CE') {
                return { status: 'CE', message: String(result.compileError).trim() };
            }
            if (kind === 'OK') {
                const stdout = await this.readGuestFile(`out_${tag}.txt`);
                return { status: 'OK', stdout, timeMs };
            }
            if (kind === 'TLE') {
                return { status: 'TLE', message: `运行超时（超过 ${limit} ms）`, timeMs };
            }
            if (kind === 'OLE') {
                return { status: 'OLE', message: `输出超过 ${req.maxOutputBytes} 字节` };
            }
            // 同 process 后端：stderr 只能进管理员诊断字段，公开文案只给退出码。
            // 用户程序可以把 stdin（隐藏测试输入）写进 stderr 再非零退出（issue #5）。
            const stderr = (await this.readGuestFile(`err_${tag}.txt`)) || result.err || '';
            return {
                status: 'RE',
                message: runtimeErrorMessage(rc),
                diagnostic: stderr.trim(),
                timeMs,
            };
        } catch (err) {
            if (err instanceof JudgeError) {
                return { status: err.kind, message: err.message, diagnostic: err.diagnostic };
            }
            return { status: 'SE', message: `沙箱错误：${(err as Error).message}` };
        } finally {
            this.executed++;
            if (this.executed % 200 === 0) {
                logger.info('recycling guest VM after 200 runs');
                await this.recycleGuest();
            }
        }
    }

    /** 每个提交只编译一次 C++ */
    private codeHash(req: ExecuteRequest): string {
        return crypto.createHash('sha1').update(req.code).digest('hex');
    }

    /** 只做判断，不登记：编译失败时不能把缓存标记为可复用（issue #6 建议 5） */
    private needsCompile(req: ExecuteRequest, bin: string): boolean {
        const id = req.submissionId ?? -1;
        const entry = this.compiled.get(id);
        return !(entry && entry.hash === this.codeHash(req) && entry.bin === bin);
    }

    /** 编译成功（产物已通过校验并写入缓存）之后才登记 */
    private markCompiled(req: ExecuteRequest, bin: string): void {
        const id = req.submissionId ?? -1;
        this.compiled.set(id, { hash: this.codeHash(req), bin });
        if (this.compiled.size > MAX_COMPILED_SUBMISSIONS) {
            const oldest = this.compiled.keys().next().value as number;
            const stale = this.compiled.get(oldest);
            this.compiled.delete(oldest);
            if (stale) this.usedBins.add(stale.bin);
        }
    }

    /** 取出需要清理的旧编译产物（随下一个 job 一起交给守护进程删除） */
    private drainStaleBins(): string[] {
        if (this.usedBins.size === 0) return [];
        const bins = [...this.usedBins];
        this.usedBins.clear();
        return bins;
    }

    private async readGuestResult(tag: string): Promise<GuestResult> {
        const raw = await this.readGuestFile(`res_${tag}.json`);
        try {
            const parsed = JSON.parse(raw);
            return {
                rc: typeof parsed.rc === 'number' ? parsed.rc : -1,
                timeMs: parsed.timeMs,
                compileError: parsed.compileError,
                err: parsed.err,
            };
        } catch (_) {
            return { rc: -1 };
        }
    }

    // ------------------------------------------------------------
    // 虚拟机管理
    // ------------------------------------------------------------

    private async ensureGuest(): Promise<void> {
        if (this.booted) return;
        if (this.bootPromise) return this.bootPromise;
        this.bootPromise = this.startGuest().finally(() => { this.bootPromise = null; });
        return this.bootPromise;
    }

    private async startGuest(): Promise<void> {
        this.assertAssets();

        const { V86 } = await import('v86');
        const wasmPath = require.resolve('v86/build/v86.wasm');
        const wasmFn = async (imports: WebAssembly.Imports) => {
            const bytes = fs.readFileSync(wasmPath);
            const { instance } = await WebAssembly.instantiate(bytes, imports);
            return instance.exports as WebAssembly.Exports;
        };

        const options: Record<string, unknown> = {
            wasm_fn: wasmFn,
            memory_size: config.V86_MEMORY_MB * 1024 * 1024,
            vga_memory_size: 2 * 1024 * 1024,
            bios: { buffer: toArrayBuffer(fs.readFileSync(config.V86_ASSETS.bios)) },
            vga_bios: { buffer: toArrayBuffer(fs.readFileSync(config.V86_ASSETS.vgabios)) },
            bzimage: { buffer: toArrayBuffer(fs.readFileSync(config.V86_ASSETS.bzimage)) },
            initrd: { buffer: toArrayBuffer(fs.readFileSync(config.V86_ASSETS.initramfs)) },
            filesystem: {},
            uart1: true,
            autostart: true,
            cmdline: 'console=ttyS0 rdinit=/init panic=-1 quiet',
        };

        const emulator: Emulator = new V86(options);
        this.emulator = emulator;
        this.serial = '';
        this.booted = false;
        this.usedBins.clear();
        this.compiled.clear();

        emulator.add_listener('serial0-output-byte', (byte: number) => {
            const ch = String.fromCharCode(byte);
            if (ch !== '\r') this.serial += ch;
            if (this.serial.length > 4 * 1024 * 1024) this.serial = this.serial.slice(-2 * 1024 * 1024);
        });

        const startedAt = Date.now();
        // autostart=true：v86 会在 wasm 加载完成后自动开始执行

        const ready = await this.waitFor('SANDBOX_READY', config.V86_BOOT_TIMEOUT_MS).then(
            () => true,
            (err: Error) => {
                logger.warn(`boot wait failed: ${err.message}`);
                return false;
            },
        );
        if (!ready) {
            const tail = this.serial.slice(-400);
            await this.destroyGuest();
            throw new JudgeError('SE', `沙箱启动失败（未在 ${config.V86_BOOT_TIMEOUT_MS} ms 内就绪）\n${tail}`);
        }
        logger.info(`guest cold booted in ${Date.now() - startedAt} ms`);

        await this.configureShell();
        this.booted = true;

        await this.startDaemon();
        await this.warmup();
        logger.info(`guest ready in ${Date.now() - startedAt} ms`);
    }

    /**
     * 关闭回显和提示符，让串口只承载控制命令的结果。
     * 标记用 `printf '%s\n' __CFG""<nonce>__` 生成：
     * 命令本身被回显时是带引号的形式，不会和输出里的标记串混淆。
     */
    private async configureShell(): Promise<void> {
        for (let attempt = 1; attempt <= 3; attempt++) {
            const nonce = crypto.randomBytes(4).toString('hex');
            const marker = `__CFG${nonce}__`;
            const from = this.serial.length;
            this.send(`stty -echo; PS1=''; printf '%s\\n' __CFG""${nonce}__\n`);
            try {
                await this.waitFor(marker, Math.floor(SHELL_TIMEOUT_MS / 2), 1, from);
                return;
            } catch (err) {
                logger.warn(`shell setup attempt ${attempt} failed: ${(err as Error).message}`);
                logger.warn(`serial tail: ${JSON.stringify(this.serial.slice(-300))}`);
            }
        }
        throw new JudgeError('SE', '客户机 shell 无响应（串口无回显）');
    }

    /** 把常驻守护进程放到客户机里并启动 */
    private async startDaemon(): Promise<void> {
        await this.writeGuestFile('/daemon.py', GUEST_DAEMON);
        await this.shell(
            'rm -f /mnt/9p/daemon.ready; (python3 -I /mnt/9p/daemon.py > /tmp/daemon.log 2>&1 &)',
            SHELL_TIMEOUT_MS,
        );
        logger.info('daemon launched, waiting for ready file');

        const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const pid = await this.readGuestFile('/daemon.ready');
            if (pid.trim()) {
                logger.info(`daemon ready (pid ${pid.trim()})`);
                return;
            }
            await sleep(POLL_INTERVAL_MS * 5);
        }
        const failure = await this.readGuestFile('/daemon.error').catch(() => '');
        const log = await this.readGuestFile('/daemon.log').catch(() => '');
        throw new JudgeError('SE', `沙箱守护进程启动失败\n${failure || log}`);
    }

    /** 预热：跑一个空 Python 程序 + 编译一个最小 C++ 程序（填充页缓存） */
    private async warmup(): Promise<void> {
        const startedAt = Date.now();

        const python = await this.runJob({ language: 'python', code: 'pass', input: '', timeLimitMs: 5000, maxOutputBytes: 1024 });
        if (python.status !== 'OK') {
            logger.warn(`python warmup failed: ${python.status}`);
        }

        if (this.languages.includes('cpp')) {
            const cpp = await this.runJob({
                language: 'cpp',
                code: '#include <cstdio>\nint main(){int a,b;if(scanf("%d %d",&a,&b)!=2)return 0;printf("%d\\n",a+b);return 0;}\n',
                input: '1 2\n',
                timeLimitMs: 5000,
                maxOutputBytes: 1024,
                submissionId: -1,
            });
            if (cpp.status !== 'OK') {
                logger.warn(`c++ warmup failed: ${cpp.status} ${'message' in cpp ? cpp.message : ''}`);
            }
        }

        logger.info(`warmup finished in ${Date.now() - startedAt} ms`);
    }

    private async recycleGuest(): Promise<void> {
        await this.destroyGuest();
        await this.ensureGuest().catch(err => {
            logger.error('failed to restart guest', err as Error);
        });
    }

    private async destroyGuest(): Promise<void> {
        this.booted = false;
        const emulator = this.emulator;
        this.emulator = null;
        if (!emulator) return;
        try {
            await emulator.destroy();
        } catch (_) { /* ignore */ }
    }

    private assertAssets(): void {
        const missing = [
            [config.V86_ASSETS.bios, 'seabios.bin'],
            [config.V86_ASSETS.vgabios, 'vgabios.bin'],
            [config.V86_ASSETS.bzimage, 'bzimage'],
            [config.V86_ASSETS.initramfs, 'initramfs.cpio.gz'],
        ].filter(([p]) => {
            try { return !fs.existsSync(p as string) || fs.statSync(p as string).size === 0; } catch (_) { return true; }
        }).map(([, name]) => name);

        if (missing.length > 0) {
            throw new JudgeError(
                'SE',
                `沙箱资源缺失（${missing.join(', ')}），请先运行 \`bun run sandbox:setup\`（目录：${config.V86_DIR}）`,
            );
        }
    }

    // ------------------------------------------------------------
    // 串口 / 9p 通信
    // ------------------------------------------------------------

    private send(data: string): void {
        this.emulator?.serial0_send(data);
    }

    private async waitFor(needle: string, timeoutMs: number, occurrence = 1, from = 0): Promise<void> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (this.indexOfOccurrence(needle, occurrence, from) >= 0) return;
            await sleep(15);
        }
        throw new Error(`等待 "${needle}" 超时（${timeoutMs} ms）`);
    }

    private indexOfOccurrence(needle: string, occurrence: number, from: number): number {
        let idx = from;
        let count = 0;
        while (true) {
            const found = this.serial.indexOf(needle, idx);
            if (found < 0) return -1;
            if (++count === occurrence) return found;
            idx = found + needle.length;
        }
    }

    /** 在客户机 shell 里执行一条命令，返回它输出到串口的内容 */
    private async shell(command: string, timeoutMs: number): Promise<string> {
        if (!this.emulator) throw new Error('沙箱未启动');
        const nonce = crypto.randomBytes(6).toString('hex');
        const marker = `__R${nonce}__`;
        const from = this.serial.length;
        // __R""<nonce>__ 拼接：命令回显里不会出现 marker 本身
        this.send(`${command}; printf '%s\\n' __R""${nonce}__\n`);
        await this.waitFor(marker, timeoutMs, 1, from);
        const markerPos = this.serial.indexOf(marker, from);
        return this.serial.slice(from, markerPos);
    }

    private async writeGuestFile(name: string, content: string): Promise<void> {
        if (!this.emulator) throw new Error('沙箱未启动');
        const data = new TextEncoder().encode(content);
        await this.emulator.create_file(name, data);
    }

    private async readGuestFile(name: string): Promise<string> {
        if (!this.emulator) throw new Error('沙箱未启动');
        try {
            const data = await this.emulator.read_file(name);
            if (!data) return '';
            return new TextDecoder().decode(data as Uint8Array);
        } catch (_) {
            return '';
        }
    }

    /** 轮询等待客户机写出某个文件（内容非空即视为完成） */
    private async waitForGuestFile(name: string, deadline: number): Promise<boolean> {
        while (Date.now() < deadline) {
            const content = await this.readGuestFile(name);
            if (content.length > 0) return true;
            await sleep(POLL_INTERVAL_MS);
        }
        return false;
    }
}

// ------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    const copy = new Uint8Array(buffer.byteLength);
    copy.set(buffer);
    return copy.buffer;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
