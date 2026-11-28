import type { ExecutionBackend } from '../judge/backend';
import { registerJudgeBackend, type JudgeBackendMode } from '../judge/backend_registry';

/** 系统服务插件：把评测执行后端注册到 judge 进程 */
export interface JudgeBackendPlugin {
    name: string;
    version: string;
    description: string;
    system: true;
    mode: JudgeBackendMode;
    create(): ExecutionBackend;
}

export const JUDGE_BACKEND_PLUGINS: JudgeBackendPlugin[] = [
    {
        name: 'judge-process',
        version: '1.0.0',
        description: '进程后端（无隔离，需要显式风险确认）',
        system: true,
        mode: 'process',
        create() {
            const { ProcessBackend } = require('../judge/process_backend');
            return new ProcessBackend();
        },
    },
    {
        name: 'judge-v86',
        version: '1.0.0',
        description: 'v86 沙箱后端',
        system: true,
        mode: 'v86',
        create() {
            const { V86Backend } = require('../judge/v86_backend');
            return new V86Backend();
        },
    },
];

/** 把评测后端插件注册进当前进程的 registry（单进程与 judge 进程都会调用） */
export function loadJudgeBackendPlugins(): void {
    for (const plugin of JUDGE_BACKEND_PLUGINS) {
        registerJudgeBackend(plugin.mode, () => plugin.create());
    }
}
