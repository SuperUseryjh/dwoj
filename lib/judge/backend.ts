import * as config from '../../config';
import { createLogger } from '../logger';

const logger = createLogger('judge');

// ============================================================
// 评测结果类型（judge 与各执行后端共用）
// ============================================================

export type JudgeErrorKind = 'TLE' | 'RE' | 'OLE' | 'SE' | 'CE';

/** 传给前端的最终状态文案（与 views 中的徽章配色对应） */
export const STATUS_TEXT: Record<JudgeErrorKind, string> = {
    TLE: 'Time Limit Exceeded',
    RE: 'Runtime Error',
    OLE: 'Output Limit Exceeded',
    SE: 'System Error',
    CE: 'Compile Error',
};

export class JudgeError extends Error {
    kind: JudgeErrorKind;
    /**
     * 管理员诊断信息（例如用户程序的 stderr）。
     * **绝不能**进入面向普通用户的 message：隐藏测试点的输入可能被用户程序
     * 原样写进 stderr，回显就等于泄露题面数据（issue #5）。
     */
    diagnostic?: string;
    constructor(kind: JudgeErrorKind, message: string, diagnostic?: string) {
        super(message);
        this.name = 'JudgeError';
        this.kind = kind;
        this.diagnostic = diagnostic;
    }
}

/**
 * 运行期错误的**公开**文案：只包含退出码/信号，不含用户 stderr。
 * 两个后端共用，避免切换后端后又把 stderr 回显出去。
 */
export function runtimeErrorMessage(code: number | null, signal?: string | null): string {
    if (code === null && !signal) return '程序异常退出';
    if (code === null) return `程序被信号 ${signal} 终止`;
    if (signal) return `程序异常退出（退出码 ${code}，信号 ${signal}）`;
    return `程序异常退出（退出码 ${code}）`;
}

/** 未结束的提交状态（启动时会被重新入队） */
export const UNFINISHED_STATUS = ['Pending', 'Queued', 'Running'];

// ============================================================
// 执行后端接口
// ============================================================

export interface ExecuteRequest {
    language: string;
    code: string;
    input: string;
    timeLimitMs: number;
    maxOutputBytes: number;
    submissionId?: number;
}

export type ExecuteOutcome =
    | { status: 'OK'; stdout: string; timeMs: number }
    | {
        status: JudgeErrorKind;
        /** 面向普通用户的文案，不得包含用户 stderr / 隐藏测试输入 */
        message: string;
        /** 仅管理员可见的诊断信息（用户 stderr 等） */
        diagnostic?: string;
        timeMs?: number;
    };

export interface ExecutionBackend {
    /** 后端名字，用于日志 */
    readonly name: string;
    /** 该后端支持的语言（judge 会用它做白名单校验） */
    readonly languages: string[];
    /** 懒加载初始化（例如启动沙箱虚拟机） */
    init(): Promise<void>;
    /** 执行一次用户程序 */
    execute(req: ExecuteRequest): Promise<ExecuteOutcome>;
    /** 释放资源 */
    dispose(): Promise<void>;
}

// ============================================================
// 后端选择（fail-closed：显式指定 v86 但资源缺失时不会降级）
// ============================================================

let backend: ExecutionBackend | null = null;
let resolvedMode: 'process' | 'v86' | null = null;

export function resolveSandboxMode(): 'process' | 'v86' {
    if (resolvedMode) return resolvedMode;

    const requested = String(config.JUDGE_SANDBOX || 'auto').toLowerCase();
    if (requested === 'process') {
        resolvedMode = 'process';
        return resolvedMode;
    }
    if (requested === 'v86') {
        // 显式要求沙箱：资源缺失也不降级，直接由 init() 报错
        resolvedMode = 'v86';
        return resolvedMode;
    }

    // auto：沙箱资源齐全才启用，否则退回进程后端并大声警告
    resolvedMode = v86AssetsReady() ? 'v86' : 'process';
    if (resolvedMode === 'process') {
        logger.warn(
            'v86 sandbox assets not found in ' + config.V86_DIR +
            ', falling back to the process backend. User code will run with server privileges — ' +
            'run `bun run sandbox:setup` or set JUDGE_SANDBOX=v86 for isolation.'
        );
    }
    return resolvedMode;
}

/** v86 运行所需的资源是否齐全（不检查内容正确性） */
export function v86AssetsReady(): boolean {
    const fs = require('fs');
    return [config.V86_ASSETS.bios, config.V86_ASSETS.vgabios, config.V86_ASSETS.bzimage, config.V86_ASSETS.initramfs]
        .every((p: string) => {
            try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch (_) { return false; }
        });
}

export function getBackend(): ExecutionBackend {
    if (backend) return backend;

    const mode = resolveSandboxMode();
    // 默认把执行后端放到独立进程里（JUDGE_WORKER=0 可退回同进程，主要给测试用）
    const useWorker = !['0', 'false', 'no'].includes(String(process.env.JUDGE_WORKER || '1').toLowerCase());

    if (useWorker) {
        const { RemoteBackend } = require('./remote_backend');
        backend = new RemoteBackend(mode);
    } else if (mode === 'v86') {
        const { V86Backend } = require('./v86_backend');
        backend = new V86Backend();
    } else {
        const { ProcessBackend } = require('./process_backend');
        backend = new ProcessBackend();
    }
    return backend!;
}

/** 测试用：重置单例（顺带释放旧实例占用的进程/虚拟机） */
export function resetBackend(mode?: 'process' | 'v86'): void {
    const previous = backend;
    backend = null;
    resolvedMode = mode ?? null;
    if (previous) {
        void previous.dispose().catch(() => { /* ignore */ });
    }
}
