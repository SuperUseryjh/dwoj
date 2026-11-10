import fs from 'fs';
import path from 'path';

/** 原生 fs 实现，替代 fs-extra 的最小工具集 */

export function ensureDirSync(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

/** 清空目录内容但保留目录本身（目录不存在时创建） */
export function emptyDirSync(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        fs.rmSync(fullPath, { recursive: true, force: true });
    }
}

export function moveSync(src: string, dst: string, options: { overwrite?: boolean } = {}): void {
    if (options.overwrite && fs.existsSync(dst)) {
        fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.renameSync(src, dst);
}

export function removeSync(target: string): void {
    fs.rmSync(target, { recursive: true, force: true });
}
