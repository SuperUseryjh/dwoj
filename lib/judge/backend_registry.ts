import type { ExecutionBackend } from './backend';

export type JudgeBackendMode = 'process' | 'v86';

const factories = new Map<JudgeBackendMode, () => ExecutionBackend>();

/** 注册一个评测后端工厂；后注册的同名后端会覆盖先前的实现 */
export function registerJudgeBackend(mode: JudgeBackendMode, factory: () => ExecutionBackend): void {
    factories.set(mode, factory);
}

export function createJudgeBackend(mode: JudgeBackendMode): ExecutionBackend | null {
    const factory = factories.get(mode);
    return factory ? factory() : null;
}

export function listJudgeBackends(): string[] {
    return [...factories.keys()];
}
