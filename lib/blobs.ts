import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BLOB_THRESHOLD } from '../config';

const BLOB_DIR = path.join(__dirname, '..', 'data', 'blobs');
const BLOB_PREFIX = '@blob:';

export function isBlobRef(value: unknown): boolean {
    return typeof value === 'string' && value.startsWith(BLOB_PREFIX);
}

/** 超过阈值的大字段写入 data/blobs/<sha256>.txt，DB 内只存引用 */
export function storeBlob(value: string): string {
    const hash = crypto.createHash('sha256').update(value).digest('hex');
    const filePath = path.join(BLOB_DIR, `${hash}.txt`);
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(BLOB_DIR, { recursive: true });
        fs.writeFileSync(filePath, value);
    }
    return BLOB_PREFIX + hash;
}

/** 读取引用内容；引用缺失时回退为空字符串 */
export function readBlob(ref: string): string {
    const hash = ref.slice(BLOB_PREFIX.length);
    const filePath = path.join(BLOB_DIR, `${hash}.txt`);
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        return '';
    }
}

function resolveValue(value: unknown): unknown {
    return isBlobRef(value) ? readBlob(value as string) : value;
}

/** 读取层统一解引用，业务代码无感 */
export function resolveRowBlob<T>(row: T): T {
    if (!row || typeof row !== 'object') return row;
    for (const key of Object.keys(row as Record<string, unknown>)) {
        const value = (row as Record<string, unknown>)[key];
        if (isBlobRef(value)) (row as Record<string, unknown>)[key] = resolveValue(value);
    }
    return row;
}

/** 写入层：把超过阈值的长字符串参数替换为 blob 引用 */
export function externalizeParam(value: unknown): unknown {
    if (typeof value === 'string' && value.length > BLOB_THRESHOLD && !isBlobRef(value)) {
        return storeBlob(value);
    }
    return value;
}

export function externalizeParams(params: unknown[]): unknown[] {
    return params.map(externalizeParam);
}
