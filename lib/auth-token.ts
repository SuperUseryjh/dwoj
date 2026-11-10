import crypto from 'crypto';
import * as config from '../config';

/** 自签 HMAC-SHA256 cookie：payload 为 base64url(JSON)，格式 `<body>.<sig>` */
export interface TokenPayload {
    id: number;
    username: string;
    role: string;
    bio?: string;
    exp: number;
}

const MAX_AGE_MS = 3600 * 1000;

function signBody(body: string): string {
    return crypto.createHmac('sha256', config.JWT_SECRET).update(body).digest('base64url');
}

export function issueToken(user: { id: number; username: string; role: string; bio?: string | null }): string {
    const payload: TokenPayload = {
        id: user.id,
        username: user.username,
        role: user.role,
        bio: user.bio ?? '',
        exp: Date.now() + MAX_AGE_MS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${signBody(body)}`;
}

export function verifyToken(token: string): TokenPayload | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;

    const body = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = signBody(body);

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
        if (!payload || typeof payload.id !== 'number' || !payload.exp) return null;
        if (payload.exp < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

export const TOKEN_MAX_AGE_MS = MAX_AGE_MS;
