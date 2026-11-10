import { spawn, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';

/**
 * OJ 运行监控面板：
 *  - 以子进程方式启动主程序（bun --smol app.ts）
 *  - 采样主进程的 CPU 与 RSS
 *  - 在独立端口提供网页，把指标渲染成折线图
 */

const INSP_PORT = Number(process.env.INSP_PORT || 4000);
const OJ_PORT = process.env.PORT || '3000';
const INTERVAL_MS = Number(process.env.INSP_INTERVAL_MS || 1000);
const MAX_SAMPLES = 600; // 最多保留 10 分钟的 1s 采样

interface Sample {
    t: number;
    cpu: number | null;
    rss: number | null;
}

interface ProcessReading {
    cpuSec: number | null;
    rssMb: number | null;
}

const samples: Sample[] = [];
let startedAt = Date.now();
let child: ChildProcess | null = null;
let prevCpuSec: number | null = null;
let prevSampleAt = Date.now();
let lastError = '';
let online = false;

// ---------------- 平台相关采样 ----------------

const LINUX_CLK_TCK = 100;
const PAGE_SIZE = 4096;

function readLinuxCpuSeconds(pid: number): number | null {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const utime = Number(fields[11]);
        const stime = Number(fields[12]);
        if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
        return (utime + stime) / LINUX_CLK_TCK;
    } catch {
        return null;
    }
}

function readLinuxRssMb(pid: number): number | null {
    try {
        const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf-8').trim().split(/\s+/);
        return (Number(statm[1]) * PAGE_SIZE) / 1048576;
    } catch {
        return null;
    }
}

function parseCpuTime(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const daySplit = trimmed.split('-');
    let days = 0;
    let rest = trimmed;
    if (daySplit.length === 2) {
        days = Number(daySplit[0]);
        rest = daySplit[1];
    }
    const parts = rest.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return null;
    if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
    return Number(trimmed) || null;
}

function readWindows(pid: number): ProcessReading {
    try {
        const out = execFileSync('powershell.exe', [
            '-NoProfile',
            '-Command',
            `$p = Get-Process -Id ${pid} -ErrorAction Stop; '{0}|{1}' -f $p.CPU, $p.WorkingSet64`,
        ], { encoding: 'utf-8', timeout: 5000, windowsHide: true }).trim();
        const [cpuSec, workingSet] = out.split('|');
        return {
            cpuSec: Number(cpuSec),
            rssMb: Number(workingSet) / 1048576,
        };
    } catch {
        return { cpuSec: null, rssMb: null };
    }
}

function readDarwin(pid: number): ProcessReading {
    try {
        const out = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
        const [rssKb, cpuTime] = out.split(/\s+/);
        return {
            cpuSec: parseCpuTime(cpuTime),
            rssMb: Number(rssKb) / 1024,
        };
    } catch {
        return { cpuSec: null, rssMb: null };
    }
}

function readProcess(pid: number): ProcessReading {
    if (process.platform === 'linux') {
        return { cpuSec: readLinuxCpuSeconds(pid), rssMb: readLinuxRssMb(pid) };
    }
    if (process.platform === 'win32') return readWindows(pid);
    if (process.platform === 'darwin') return readDarwin(pid);
    return { cpuSec: null, rssMb: null };
}

// ---------------- 采样循环 ----------------

let sampleTimer: ReturnType<typeof setInterval> | null = null;
let helper: ChildProcess | null = null;
let helperBuffer = '';

function pushSample(at: number, cpuSec: number | null, rssMb: number | null): void {
    let cpu: number | null = null;
    if (cpuSec !== null && prevCpuSec !== null) {
        const elapsed = (at - prevSampleAt) / 1000;
        if (elapsed > 0) cpu = Math.max(0, ((cpuSec - prevCpuSec) / elapsed) * 100);
    }
    if (cpuSec !== null) prevCpuSec = cpuSec;
    prevSampleAt = at;

    online = cpuSec !== null || rssMb !== null;
    if (!online) lastError = '无法读取主进程指标（进程可能已退出）';

    samples.push({ t: at, cpu, rss: rssMb });
    if (samples.length > MAX_SAMPLES) samples.shift();
}

function takeSample(): void {
    if (!child || child.pid === undefined) return;
    const reading = readProcess(child.pid);
    pushSample(Date.now(), reading.cpuSec, reading.rssMb);
}

/** Windows：常驻 PowerShell 采样器，避免每秒启动新进程阻塞事件循环 */
function startWindowsHelper(pid: number): void {
    helperBuffer = '';
    const script = [
        `while ($true) {`,
        `  $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
        `  if (-not $p) { break }`,
        `  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds();`,
        `  [Console]::Out.WriteLine(('{0}|{1}|{2}' -f $now, $p.CPU, $p.WorkingSet64));`,
        `  [Console]::Out.Flush();`,
        `  Start-Sleep -Milliseconds ${INTERVAL_MS}`,
        `}`,
    ].join('\n');

    helper = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
    });

    helper.stdout?.on('data', (chunk: Buffer) => {
        helperBuffer += chunk.toString();
        const lines = helperBuffer.split(/\r?\n/);
        helperBuffer = lines.pop() || '';
        for (const line of lines) {
            const parts = line.trim().split('|');
            if (parts.length !== 3) continue;
            const at = Number(parts[0]);
            const cpuSec = Number(parts[1]);
            const workingSet = Number(parts[2]);
            if (!Number.isFinite(at)) continue;
            pushSample(at, Number.isFinite(cpuSec) ? cpuSec : null,
                Number.isFinite(workingSet) ? workingSet / 1048576 : null);
        }
    });

    helper.on('error', (err) => {
        lastError = `Windows 采样器启动失败：${err.message}`;
    });
}

// ---------------- 启动主进程 ----------------

function startMain(): void {
    startedAt = Date.now();
    samples.length = 0;
    prevCpuSec = null;
    prevSampleAt = startedAt;
    lastError = '';

    child = spawn(process.execPath, ['--smol', 'app.ts'], {
        stdio: 'inherit',
        env: process.env,
    });

    child.on('exit', (code, signal) => {
        online = false;
        lastError = `主进程已退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`;
        if (helper) { try { helper.kill(); } catch { /* ignore */ } helper = null; }
        console.log(`[insp] ${lastError}，监控面板继续运行，可 Ctrl+C 退出`);
    });

    child.on('error', (err) => {
        online = false;
        lastError = `主进程启动失败：${err.message}`;
        console.error(`[insp] ${lastError}`);
    });

    if (sampleTimer) {
        clearInterval(sampleTimer);
        sampleTimer = null;
    }
    if (helper) {
        try { helper.kill(); } catch { /* ignore */ }
        helper = null;
    }

    if (process.platform === 'win32') {
        // 常驻采样器异步输出，不阻塞监控面板
        startWindowsHelper(child.pid!);
    } else {
        takeSample();
        sampleTimer = setInterval(takeSample, INTERVAL_MS);
    }

    console.log(`[insp] 主进程已启动 pid=${child.pid}`);
    console.log(`[insp] OJ 端口: http://localhost:${OJ_PORT}`);
    console.log(`[insp] 监控面板: http://localhost:${INSP_PORT}`);
}

// ---------------- 监控面板 ----------------

function metricsPayload() {
    return {
        online,
        pid: child?.pid ?? null,
        startedAt,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        intervalMs: INTERVAL_MS,
        platform: process.platform,
        error: online ? '' : lastError,
        samples,
    };
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DWOJ 运行监控</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0;
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
  .stat {
    background: #1e293b; border: 1px solid #334155; border-radius: 10px;
    padding: 12px 16px; min-width: 150px;
  }
  .stat .label { font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
  .stat .value { font-size: 20px; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; }
  .ok { background: #064e3b; color: #6ee7b7; }
  .off { background: #7f1d1d; color: #fca5a5; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 18px; }
  .card h2 { font-size: 15px; margin: 0 0 12px; color: #cbd5e1; font-weight: 600; }
  canvas { width: 100%; height: 260px; display: block; }
  .hint { color: #94a3b8; font-size: 12px; margin-top: 8px; }
  .err { color: #fca5a5; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
  <h1>DWOJ 运行监控 <span id="badge" class="badge ok">在线</span></h1>
  <div id="err" class="err"></div>
  <div class="bar">
    <div class="stat"><div class="label">当前 CPU（单核 %）</div><div class="value" id="cpuNow">-</div></div>
    <div class="stat"><div class="label">当前内存 RSS</div><div class="value" id="rssNow">-</div></div>
    <div class="stat"><div class="label">峰值 CPU</div><div class="value" id="cpuPeak">-</div></div>
    <div class="stat"><div class="label">峰值内存</div><div class="value" id="rssPeak">-</div></div>
    <div class="stat"><div class="label">主进程 PID</div><div class="value" id="pid">-</div></div>
    <div class="stat"><div class="label">运行时长</div><div class="value" id="uptime">-</div></div>
  </div>

  <div class="card">
    <h2>CPU 占用（%）</h2>
    <canvas id="cpuChart"></canvas>
  </div>

  <div class="card">
    <h2>内存占用（RSS，MB）</h2>
    <canvas id="memChart"></canvas>
  </div>

  <div class="hint">每秒刷新；图表窗口为最近 120 秒。CPU 为进程累计 CPU 时间差分，可能超过 100%（多线程瞬时）。</div>

<script>
const CPU_LIMIT = 100;
const MEM_LIMIT = 128;
const WINDOW_SEC = 120;

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawLineChart(canvas, samples, key, { color, unit, limit, title }) {
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { left: 58, right: 20, top: 16, bottom: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const now = Date.now();
  const minT = now - WINDOW_SEC * 1000;
  const points = samples.filter(s => s.t >= minT && typeof s[key] === 'number');
  const values = points.map(s => s[key]);
  const peak = values.length ? Math.max(...values) : 0;
  const yMax = Math.max(limit, Math.ceil((peak + limit * 0.15) / 20) * 20);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(pad.left, pad.top, plotW, plotH);

  // 网格 + Y 轴
  ctx.strokeStyle = '#243449';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px Segoe UI';
  ctx.lineWidth = 1;
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const v = (yMax / ySteps) * i;
    const y = pad.top + plotH - (v / yMax) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 8, y + 4);
  }

  // 上限线
  ctx.strokeStyle = '#ef4444';
  ctx.setLineDash([3, 4]);
  const yLimit = pad.top + plotH - (limit / yMax) * plotH;
  ctx.beginPath();
  ctx.moveTo(pad.left, yLimit);
  ctx.lineTo(pad.left + plotW, yLimit);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fca5a5';
  ctx.fillText('上限 ' + limit + unit, pad.left + 8, yLimit - 6);

  // X 轴刻度
  ctx.fillStyle = '#94a3b8';
  const xSteps = 6;
  for (let i = 0; i <= xSteps; i++) {
    const t = minT + (WINDOW_SEC * 1000 / xSteps) * i;
    const x = pad.left + (i / xSteps) * plotW;
    ctx.fillText('-' + Math.round((now - t) / 1000) + 's', x + 2, height - 8);
  }

  // 折线
  if (points.length > 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((s, i) => {
      const x = pad.left + ((s.t - minT) / (WINDOW_SEC * 1000)) * plotW;
      const y = pad.top + plotH - (Math.min(s[key], yMax) / yMax) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 当前点
    const last = points[points.length - 1];
    const lx = pad.left + ((last.t - minT) / (WINDOW_SEC * 1000)) * plotW;
    const ly = pad.top + plotH - (Math.min(last[key], yMax) / yMax) * plotH;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 轴框
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  return peak;
}

function fmt(v, digits = 1, suffix = '') {
  return v === null || v === undefined ? '-' : v.toFixed(digits) + suffix;
}

async function refresh() {
  try {
    const data = await (await fetch('/api/metrics')).json();
    const s = data.samples || [];
    const last = s[s.length - 1] || {};
    const cpuPeak = drawLineChart(document.getElementById('cpuChart'), s, 'cpu', { color: '#60a5fa', unit: '%', limit: CPU_LIMIT, title: 'CPU' });
    const memPeak = drawLineChart(document.getElementById('memChart'), s, 'rss', { color: '#f59e0b', unit: ' MB', limit: MEM_LIMIT, title: '内存' });

    document.getElementById('cpuNow').textContent = fmt(last.cpu, 1, '%');
    document.getElementById('rssNow').textContent = fmt(last.rss, 1, ' MB');
    document.getElementById('cpuPeak').textContent = fmt(cpuPeak, 1, '%');
    document.getElementById('rssPeak').textContent = fmt(memPeak, 1, ' MB');
    document.getElementById('pid').textContent = data.pid ?? '-';
    document.getElementById('uptime').textContent = data.uptimeSec + ' s';

    const badge = document.getElementById('badge');
    badge.textContent = data.online ? '在线' : '离线';
    badge.className = 'badge ' + (data.online ? 'ok' : 'off');
    document.getElementById('err').textContent = data.online ? '' : (data.error || '主进程不可用');
  } catch (err) {
    document.getElementById('err').textContent = '获取监控数据失败：' + err;
  }
}

refresh();
setInterval(refresh, 1000);
window.addEventListener('resize', refresh);
</script>
</body>
</html>`;

function startInspectorServer(): void {
    const server = Bun.serve({
        port: INSP_PORT,
        development: false,
        idleTimeout: 30,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === '/api/metrics') {
                return Response.json(metricsPayload());
            }
            if (url.pathname === '/' || url.pathname === '/index.html') {
                return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            }
            return new Response('Not Found', { status: 404 });
        },
    });
    console.log(`[insp] 监控服务已监听 ${server.hostname}:${server.port}`);
    return;
}

// ---------------- 生命周期 ----------------

function shutdown(code = 0): void {
    console.log('[insp] 正在停止...');
    if (sampleTimer) clearInterval(sampleTimer);
    if (helper) { try { helper.kill(); } catch { /* ignore */ } helper = null; }
    if (child && child.pid !== undefined) {
        try {
            if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
            else child.kill('SIGTERM');
        } catch {
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }
    }
    setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

startInspectorServer();
startMain();
