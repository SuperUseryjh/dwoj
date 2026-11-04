/**
 * 进程间通信协议（NDJSON over stdin/stdout）。
 *
 * 拓扑是「星型」：所有子进程只和主进程（broker）说话，由 broker 按 `to` 转发。
 *   http ──┐
 *   judge ─┼──► broker ──► db
 *   db ◄───┘
 *
 * 消息类型：
 *   ready  子进程启动完成（broker 用于启动编排）
 *   call   请求（需要 reply）
 *   reply  响应
 *   event  通知（不需要响应）
 */

export type Role = 'broker' | 'db' | 'http' | 'judge';

export interface Envelope {
    kind: 'ready' | 'call' | 'reply' | 'event' | 'shutdown';
    /** 唯一请求 id（由发起方生成，全局递增即可） */
    id?: number;
    /** 发起方角色 */
    from?: Role;
    /** 目标角色 */
    to?: Role;
    /** call / event 的方法名 */
    method?: string;
    params?: any;
    /** reply 的结果 */
    ok?: boolean;
    result?: any;
    error?: string;
    /** ready 时上报的附加信息（例如端口、方言） */
    info?: Record<string, any>;
}

// ============================================================
// 序列化：JSON 不能直接表达 Date / Uint8Array / BigInt
// ============================================================

const MARK = '__dwoj_t';

/**
 * 注意：不能用 JSON.stringify 的 replacer 处理 Date
 * —— Date.prototype.toJSON 会在 replacer 之前执行，拿到的已经是字符串。
 * 所以这里先做一次深度归一化。
 */
function normalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'bigint') return { [MARK]: 'bigint', v: value.toString() };
        return value;
    }
    if (value instanceof Date) return { [MARK]: 'date', v: value.toISOString() };
    if (value instanceof Uint8Array) return { [MARK]: 'bytes', v: Buffer.from(value).toString('base64') };
    if (Array.isArray(value)) return value.map(normalize);

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalize(item);
    return out;
}

export function encode(value: unknown): string {
    return JSON.stringify(normalize(value));
}

export function decode<T = any>(text: string): T {
    return JSON.parse(text, (_key, v) => {
        if (v && typeof v === 'object' && typeof v[MARK] === 'string') {
            const tag = v[MARK];
            if (tag === 'date') return new Date(v.v);
            if (tag === 'bytes') return Buffer.from(v.v, 'base64');
            if (tag === 'bigint') return BigInt(v.v);
        }
        return v;
    }) as T;
}

/** 一行一条消息；返回消费掉多少字符 */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
    const lines: string[] = [];
    let start = 0;
    let idx: number;
    while ((idx = buffer.indexOf('\n', start)) >= 0) {
        const line = buffer.slice(start, idx).trim();
        if (line) lines.push(line);
        start = idx + 1;
    }
    return { lines, rest: buffer.slice(start) };
}
