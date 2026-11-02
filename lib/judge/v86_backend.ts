import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import * as config from '../../config';
import logger from '../logger';
import { ExecuteOutcome, ExecuteRequest, ExecutionBackend, JudgeError } from './backend';
import { GUEST_RUNNER } from './guest_runner';

/**
 * v86 沙箱后端
 * ---------------------------------------------------------------------------
 * 把用户代码放进一台内嵌的 x86 虚拟机（v86，纯 WASM 实现的 PC 模拟器）里执行：
 *   - 客户机是 32 位 Alpine Linux（内核由 v86 官方测试镜像提取，4.16 i686），
 *     v86 不支持 64 位内核、也不支持 PAE，因此只能用 32 位系统。
 *   - 客户机**没有网络设备**，看不到宿主机文件系统。
 *   - 宿主机与客户机之间只有两条通道：
 *       1. 串口（只用于发送 shell 命令 / 收执行状态标记）
 *       2. 9p 共享目录（只放当前这次评测的源码、输入、输出文件）
 *   - 用户程序在客户机里以 root 运行，但它破坏的只是这台一次性虚拟机；
 *     一旦客户机卡死就整台重建（优先从预热快照恢复，约 200ms）。
 *
 * 性能说明：模拟器里 Python 解释器启动约 1~2 秒，因此：
 *   - 单次执行的时间限制包含解释器启动开销；
 *   - 每个测试点的时间由客户机内的 runner 用 setitimer 计时并强制中断。
 */

type Emulator = any;

/** 串口命令的兜底超时（不含用户程序时间） */
const SHELL_TIMEOUT_MS = 30000;

interface GuestResult {
    rc: number;
    stdout: string;
    stderr: string;
    timeMs?: number;
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
        const task = this.chain.then(() => this.executeExclusive(req));
        this.chain = task.then(() => undefined, () => undefined);
        return task;
    }

    // ------------------------------------------------------------
    // 单次执行
    // ------------------------------------------------------------

    private async executeExclusive(req: ExecuteRequest): Promise<ExecuteOutcome> {
        await this.ensureGuest();

        const tag = crypto.randomBytes(6).toString('hex');
        const sol = `/sol_${tag}.py`;
        const inp = `/in_${tag}.txt`;
        const out = `/out_${tag}.txt`;
        const err = `/err_${tag}.txt`;
        const tm = `/time_${tag}.txt`;

        try {
            await this.writeGuestFile('/runner.py', GUEST_RUNNER);
            await this.writeGuestFile(sol, req.code);
            await this.writeGuestFile(inp, req.input);
            for (const f of [out, err, tm]) await this.writeGuestFile(f, '');

            const limit = req.timeLimitMs;
            const hard = limit + config.V86_RUN_GRACE_MS;
            const script =
                `python3 -I /mnt/9p/runner.py ${limit} ${req.maxOutputBytes}` +
                ` /mnt/9p${sol} /tmp/o_${tag} /tmp/e_${tag}` +
                ` /mnt/9p${out} /mnt/9p${err} /mnt/9p${tm}` +
                ` < /mnt/9p${inp} > /tmp/o_${tag} 2> /tmp/e_${tag}; echo RC=$?`;

            let rc: number;
            try {
                const reply = await this.shell(script, hard + SHELL_TIMEOUT_MS);
                rc = parseRc(reply);
            } catch (err2) {
                // 客户机没在预期时间内回来，说明被用户代码卡死了
                logger.warn(`[Judge/v86] guest unresponsive (${(err2 as Error).message}), recycling VM`);
                await this.recycleGuest();
                return { status: 'TLE', message: `运行超时（超过 ${req.timeLimitMs} ms）或客户机无响应` };
            }

            const [stdout, stderr, timeText] = await Promise.all([
                this.readGuestFile(out),
                this.readGuestFile(err),
                this.readGuestFile(tm),
            ]);
            const timeMs = Number.parseInt(timeText.trim(), 10);

            await this.cleanupGuestTmp(tag);

            if (rc === 0) {
                return { status: 'OK', stdout, timeMs: Number.isFinite(timeMs) ? timeMs : 0 };
            }
            if (rc === 124) {
                return { status: 'TLE', message: `运行超时（超过 ${req.timeLimitMs} ms）`, timeMs: limit };
            }
            if (rc === 125) {
                return { status: 'OLE', message: `输出超过 ${req.maxOutputBytes} 字节` };
            }
            if (rc === 123) {
                return { status: 'CE', message: stderr.trim() || '语法错误' };
            }
            if (rc < 0) {
                return { status: 'SE', message: '沙箱未返回执行结果' };
            }
            return { status: 'RE', message: stderr.trim() || `程序异常退出（退出码 ${rc}）`, timeMs };
        } catch (err3) {
            if (err3 instanceof JudgeError) {
                return { status: err3.kind, message: err3.message };
            }
            return { status: 'SE', message: `沙箱错误：${(err3 as Error).message}` };
        }
    }

    private async cleanupGuestTmp(tag: string): Promise<void> {
        if (!this.booted) return;
        try {
            await this.shell(
                `rm -f /mnt/9p/sol_${tag}.py /mnt/9p/in_${tag}.txt /mnt/9p/out_${tag}.txt` +
                ` /mnt/9p/err_${tag}.txt /mnt/9p/time_${tag}.txt /tmp/o_${tag} /tmp/e_${tag} 2>/dev/null`,
                15000,
            );
        } catch (_) { /* 清理失败不影响判定 */ }
        this.executed++;
        // 每 200 次执行做一次重建，避免客户机状态漂移
        if (this.executed % 200 === 0) {
            logger.info('[Judge/v86] recycling guest VM after 200 runs');
            await this.recycleGuest();
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

        emulator.add_listener('serial0-output-byte', (byte: number) => {
            const ch = String.fromCharCode(byte);
            if (ch !== '\r') this.serial += ch;
            // 防止串口输出无限增长
            if (this.serial.length > 4 * 1024 * 1024) this.serial = this.serial.slice(-2 * 1024 * 1024);
        });

        const startedAt = Date.now();
        // autostart=true：v86 会在 wasm 加载完成后自动开始执行

        const ready = await this.waitFor('SANDBOX_READY', config.V86_BOOT_TIMEOUT_MS).then(
            () => true,
            (err: Error) => {
                logger.warn(`[Judge/v86] boot wait failed: ${err.message}`);
                return false;
            },
        );
        if (!ready) {
            const tail = this.serial.slice(-400);
            await this.destroyGuest();
            throw new JudgeError('SE', `沙箱启动失败（未在 ${config.V86_BOOT_TIMEOUT_MS} ms 内就绪）\n${tail}`);
        }
        logger.info(`[Judge/v86] guest cold booted in ${Date.now() - startedAt} ms`);

        await this.configureShell();
        this.booted = true;

        // 预热（首次 import 会让模拟器从 initramfs 里读几十 MB，很慢）
        try {
            await this.shell('python3 -I -c pass', 120000);
        } catch (err) {
            logger.warn(`[Judge/v86] python warmup failed: ${(err as Error).message}`);
        }
    }

    /**
     * 关闭回显和提示符，让串口只承载命令结果。
     * 标记用 `printf '%s\n' __CFG""<nonce>__` 生成：
     * 命令本身被回显时是带引号的形式，不会和输出里的标记串混淆。
     */
    private async configureShell(): Promise<void> {
        const nonce = crypto.randomBytes(4).toString('hex');
        const marker = `__CFG${nonce}__`;
        const from = this.serial.length;
        this.send(`stty -echo; PS1=''; printf '%s\\n' __CFG""${nonce}__\n`);
        await this.waitFor(marker, SHELL_TIMEOUT_MS, 1, from);
    }

    private async recycleGuest(): Promise<void> {
        await this.destroyGuest();
        await this.ensureGuest().catch(err => {
            logger.error('[Judge/v86] failed to restart guest', err as Error);
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
}

// ------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------

function parseRc(reply: string): number {
    const match = /RC=(-?\d+)/.exec(reply);
    return match ? Number.parseInt(match[1], 10) : -1;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    const copy = new Uint8Array(buffer.byteLength);
    copy.set(buffer);
    return copy.buffer;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
