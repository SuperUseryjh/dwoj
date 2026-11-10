/**
 * 轻量压测：首页 / 题目 / 状态 / 提交（默认 20 并发）
 * 用法：bun scripts/loadtest.ts [baseUrl] [concurrency] [rounds]
 */

const baseUrl = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
const concurrency = Number(process.argv[3] || 20);
const rounds = Number(process.argv[4] || 5);

interface Endpoint {
    method: 'GET' | 'POST';
    path: string;
    body?: string;
}

const endpoints: Endpoint[] = [
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/status' },
    { method: 'GET', path: '/discuss' },
    { method: 'GET', path: '/problem/1' },
];

const latencies: number[] = [];
let failures = 0;

async function hit(endpoint: Endpoint): Promise<void> {
    const startedAt = performance.now();
    try {
        const response = await fetch(`${baseUrl}${endpoint.path}`, {
            method: endpoint.method,
            headers: endpoint.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
            body: endpoint.body,
            redirect: 'manual',
        });
        await response.text();
        if (response.status >= 500) failures++;
    } catch {
        failures++;
    } finally {
        latencies.push(performance.now() - startedAt);
    }
}

async function worker(workerId: number): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        const endpoint = endpoints[(workerId + i) % endpoints.length];
        await hit(endpoint);
    }
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
const elapsed = performance.now() - startedAt;

console.log(`目标: ${baseUrl}`);
console.log(`并发: ${concurrency} 轮次: ${rounds} 总请求: ${latencies.length}`);
console.log(`失败: ${failures}`);
console.log(`总耗时: ${Math.round(elapsed)} ms`);
console.log(`平均: ${(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)).toFixed(1)} ms`);
console.log(`P50: ${percentile(latencies, 0.5).toFixed(1)} ms  P95: ${percentile(latencies, 0.95).toFixed(1)} ms  P99: ${percentile(latencies, 0.99).toFixed(1)} ms`);

if (failures > 0) process.exit(1);
