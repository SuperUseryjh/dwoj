import { describe, expect, test } from 'bun:test';
import { decode, encode, takeLines } from '../lib/ipc/protocol';

describe('ipc / codec', () => {
    test('round-trips plain values', () => {
        const value = { kind: 'call', id: 7, from: 'http', to: 'db', params: { sql: 'SELECT 1', params: [1, 'a', null] } };
        expect(decode(encode(value))).toEqual(value);
    });

    test('round-trips Date / Uint8Array / BigInt', () => {
        const date = new Date('2026-01-02T03:04:05.000Z');
        const bytes = new Uint8Array([0, 1, 2, 250]);
        const big = BigInt('9007199254740993');

        const decoded = decode<any>(encode({ date, bytes, big }));

        expect(decoded.date).toBeInstanceOf(Date);
        expect(decoded.date.toISOString()).toBe(date.toISOString());
        expect(decoded.bytes).toBeInstanceOf(Uint8Array);
        expect(Array.from(decoded.bytes)).toEqual([0, 1, 2, 250]);
        expect(decoded.big).toBe(big);
    });

    test('keeps row-like objects intact', () => {
        const rows = [{ id: 1, title: 'A+B', timeLimit: 1000 }, { id: 2, title: 'dup', timeLimit: null }];
        expect(decode(encode({ result: rows }))).toEqual({ result: rows });
    });
});

describe('ipc / line framing', () => {
    test('splits complete lines and keeps the remainder', () => {
        const { lines, rest } = takeLines('{"a":1}\n{"b":2}\n{"c":');
        expect(lines).toEqual(['{"a":1}', '{"b":2}']);
        expect(rest).toBe('{"c":');
    });

    test('ignores empty lines', () => {
        const { lines, rest } = takeLines('\n\n{"a":1}\n\n');
        expect(lines).toEqual(['{"a":1}']);
        expect(rest).toBe('');
    });

    test('handles a chunk with no newline', () => {
        expect(takeLines('partial')).toEqual({ lines: [], rest: 'partial' });
    });
});
