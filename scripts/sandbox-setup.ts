#!/usr/bin/env bun
/**
 * 准备 v86 沙箱资源（只跑一次，产物在 data/sandbox/，已加入 .gitignore）
 *
 *   bun run sandbox:setup
 *
 * 做三件事：
 *   1. 下载 BIOS 与 v86 官方测试镜像里的 Linux 4.16 i686 内核
 *      （v86 不支持 64 位内核，也不支持 PAE，所以只能用 32 位系统）
 *   2. 从 Alpine 3.19 x86 仓库解析 python3 的依赖闭包并下载 apk
 *   3. 把 busybox + musl + Python + 一个 /init 打包成 initramfs.cpio.gz
 *
 * 之后第一次评测会在后台冷启动客户机（约 30~60s），
 * 启动完成后自动把快照写入 data/sandbox/state.bin，后续启动约 200ms。
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'sandbox');
const PKG_CACHE = path.join(OUT, 'packages');
const INDEX_DIR = path.join(OUT, 'index');

const ALPINE = 'https://dl-cdn.alpinelinux.org/alpine/v3.19';
const ARCH = 'x86';
const V86_BIOS = 'https://copy.sh/v86/bios';
const V86_TEST_ISO = 'https://copy.sh/v86/images/linux4.iso';

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------

function log(msg: string): void {
    console.log(`\x1b[36m[sandbox]\x1b[0m ${msg}`);
}

async function download(url: string, dest: string, minBytes = 1): Promise<void> {
    if (fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) {
        log(`cached  ${path.basename(dest)}`);
        return;
    }
    log(`fetch   ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < minBytes) throw new Error(`文件过小（${buf.length} bytes）：${url}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
}

// ------------------------------------------------------------
// tar（newc/ustar，含 PAX）读取
// ------------------------------------------------------------

interface TarEntry { name: string; type: string; mode: number; data: Buffer; linkname: string }

const cstr = (b: Buffer, off: number, len: number) => b.subarray(off, off + len).toString('utf-8').replace(/\0[\s\S]*$/, '');

function parsePax(data: Buffer): Record<string, string> {
    const out: Record<string, string> = {};
    let i = 0;
    while (i < data.length) {
        const sp = data.indexOf(0x20, i);
        if (sp < 0) break;
        const len = parseInt(data.subarray(i, sp).toString('ascii'), 10);
        if (!len) break;
        const rec = data.subarray(sp + 1, i + len - 1).toString('utf-8');
        const eq = rec.indexOf('=');
        if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
        i += len;
    }
    return out;
}

function untar(buf: Buffer): TarEntry[] {
    const out: TarEntry[] = [];
    let off = 0;
    let paxPath: string | null = null;
    while (off + 512 <= buf.length) {
        const h = buf.subarray(off, off + 512);
        if (h.every(b => b === 0)) break;
        const name = cstr(h, 0, 100);
        const mode = parseInt(cstr(h, 100, 8).trim() || '0', 8);
        const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        const linkname = cstr(h, 157, 100);
        const prefix = cstr(h, 345, 155);
        const dataOff = off + 512;
        if (type === 'x') {
            paxPath = parsePax(buf.subarray(dataOff, dataOff + size)).path ?? paxPath;
        } else {
            const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
            paxPath = null;
            out.push({
                name: full.replace(/^\.\//, ''),
                type,
                mode,
                data: Buffer.from(buf.subarray(dataOff, dataOff + size)),
                linkname,
            });
        }
        off = dataOff + Math.ceil(size / 512) * 512;
    }
    return out;
}

// ------------------------------------------------------------
// ISO9660：从 v86 测试镜像里取出 bzImage
// ------------------------------------------------------------

function extractFromIso(isoPath: string, wantPath: string, dest: string): void {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        log(`cached  ${path.basename(dest)}`);
        return;
    }
    const iso = fs.readFileSync(isoPath);
    const SEC = 2048;

    let root: { lba: number; size: number } | null = null;
    for (let s = 16; s < 64; s++) {
        const off = s * SEC;
        if (iso.subarray(off + 1, off + 6).toString() !== 'CD001') continue;
        if (iso[off] !== 1) continue;
        root = { lba: iso.readUInt32LE(off + 158), size: iso.readUInt32LE(off + 166) };
        break;
    }
    if (!root) throw new Error('不是有效的 ISO9660 镜像');

    const want = wantPath.replace(/^\//, '').toLowerCase();
    const walk = (lba: number, size: number, prefix: string, depth = 0): Buffer | null => {
        let off = lba * SEC;
        const end = off + size;
        while (off < end && depth <= 6) {
            const len = iso[off];
            if (len === 0) { off = Math.ceil((off + 1) / SEC) * SEC; continue; }
            const elba = iso.readUInt32LE(off + 2);
            const esize = iso.readUInt32LE(off + 10);
            const flags = iso[off + 25];
            const nameLen = iso[off + 32];
            const name = iso.subarray(off + 33, off + 33 + nameLen).toString('binary');
            if (flags & 2) {
                if (name !== '\u0000' && name !== '\u0001') {
                    const found = walk(elba, esize, `${prefix}/${name}`, depth + 1);
                    if (found) return found;
                }
            } else {
                // ISO9660 level 1 会把名字大写、把 '-' 换成 '_'，并追加 ".;1"
                const norm = `${prefix}/${name}`
                    .replace(/;\d+$/, '')
                    .replace(/\.$/, '')
                    .replace(/^\//, '')
                    .replace(/_/g, '-')
                    .toLowerCase();
                if (norm === want) return iso.subarray(elba * SEC, elba * SEC + esize);
            }
            off += len;
        }
        return null;
    };

    const data = walk(root.lba, root.size, '');
    if (!data) throw new Error(`ISO 里找不到 ${wantPath}`);
    fs.writeFileSync(dest, data);
    log(`extracted ${path.basename(dest)} (${(data.length / 1048576).toFixed(1)} MB)`);
}

// ------------------------------------------------------------
// APK：索引解析 + 依赖闭包
// ------------------------------------------------------------

interface Pkg { repo: string; name: string; version: string; deps: string[]; provides: string[] }

const byName = new Map<string, Pkg>();
const byProvide = new Map<string, Pkg>();

async function loadIndexes(): Promise<void> {
    for (const repo of ['main', 'community']) {
        const file = path.join(INDEX_DIR, `${repo}.tar.gz`);
        await download(`${ALPINE}/${repo}/${ARCH}/APKINDEX.tar.gz`, file, 1000);
        const indexFile = untar(zlib.gunzipSync(fs.readFileSync(file))).find(e => e.name === 'APKINDEX');
        if (!indexFile) throw new Error(`${repo} 索引格式异常`);
        for (const stanza of indexFile.data.toString('utf-8').split('\n\n')) {
            const f: Record<string, string> = {};
            for (const line of stanza.split('\n')) {
                if (line.length > 2 && line[1] === ':') f[line[0]] = line.slice(2);
            }
            if (!f.P || !f.V) continue;
            const pkg: Pkg = {
                repo,
                name: f.P,
                version: f.V,
                deps: (f.D || '').split(/\s+/).filter(Boolean),
                provides: (f.p || '').split(/\s+/).filter(Boolean),
            };
            byName.set(pkg.name, pkg);
            for (const p of pkg.provides) {
                const token = p.split('=')[0];
                if (!byProvide.has(token)) byProvide.set(token, pkg);
            }
        }
    }
    log(`index   ${byName.size} packages`);
}

function findPkg(token: string): Pkg | undefined {
    if (token.startsWith('!')) return undefined;
    const t = token.split(/[=<>~]/)[0];
    if (t.startsWith('so:') || t.startsWith('cmd:') || t.startsWith('pc:')) return byProvide.get(t);
    return byName.get(t) ?? byProvide.get(t);
}

function resolveClosure(roots: string[]): Pkg[] {
    const out = new Map<string, Pkg>();
    const queue = [...roots];
    const seen = new Set<string>();
    while (queue.length) {
        const token = queue.shift()!;
        if (seen.has(token)) continue;
        seen.add(token);
        const pkg = findPkg(token);
        if (!pkg) throw new Error(`依赖无法解析：${token}`);
        if (out.has(pkg.name)) continue;
        out.set(pkg.name, pkg);
        for (const dep of pkg.deps) queue.push(dep);
    }
    return [...out.values()];
}

// ------------------------------------------------------------
// initramfs（cpio newc）
// ------------------------------------------------------------

interface CpioEntry { name: string; mode: number; data: Buffer; rdev?: number }

/**
 * 精简规则：initramfs 会被整份解压进客户机内存，体积直接决定启动时间和内存占用。
 * 这里去掉的都是「动态链接 + 正常编译」用不到的东西。
 */
const TRIM_PATTERNS: RegExp[] = [
    /^\/usr\/bin\/lto-dump$/,          // 33MB，用不到
    /^\/usr\/bin\/dwp$/,               // debug info 打包器
    /^\/usr\/bin\/gcov/,
    /^\/usr\/bin\/gcc-(ar|nm|ranlib)/,
    /^\/usr\/libexec\/gcc\/.+\/(lto1|lto-wrapper|install-tools)/,
    /^\/usr\/lib\/gcc\/.+\/plugin\//,
    // 静态库（默认动态链接不需要）
    /^\/usr\/lib\/lib(c|stdc\+\+|supc\+\+|gcc|gcc_eh|gomp|atomic|itm|ssp|quadmath|stdc\+\+fs)\.a$/,
    // Python 里用不到的大块头
    /^\/usr\/lib\/python3[^/]*\/(ensurepip|idlelib|tkinter|turtledemo|pydoc_data|test|lib2to3)\//,
    /^\/usr\/lib\/python3[^/]*\/turtle\.py$/,
    /^\/usr\/share\//,
];

function buildInitramfs(apks: { pkg: Pkg; file: string }[], dest: string): void {
    const entries: CpioEntry[] = [];
    const dirs = new Set<string>();

    const addDir = (name: string): void => {
        const d = name.replace(/\/+$/, '') || '/';
        if (dirs.has(d)) return;
        dirs.add(d);
        entries.push({ name: d, mode: 0o040755, data: Buffer.alloc(0) });
    };
    const addFile = (name: string, data: Buffer, mode = 0o100644): void => {
        entries.push({ name, mode: mode | 0o100000, data });
    };
    const addLink = (name: string, target: string): void => {
        entries.push({ name, mode: 0o120777, data: Buffer.from(target) });
    };
    const addDev = (name: string, major: number, minor: number): void => {
        entries.push({ name, mode: 0o020600, data: Buffer.alloc(0), rdev: (major << 8) | minor });
    };

    for (const d of ['/', '/bin', '/sbin', '/lib', '/usr', '/usr/bin', '/usr/lib', '/usr/share',
        '/proc', '/sys', '/dev', '/tmp', '/mnt', '/mnt/9p', '/root']) addDir(d);

    // apk 里会用硬链接（type '1'）共享同一个文件（比如 /usr/bin/g++ -> /usr/bin/c++），
    // cpio 没有跨条目硬链接的概念，这里直接把目标内容复制一份。
    const blobs = new Map<string, Buffer>();
    const hardlinks: { name: string; target: string; mode: number }[] = [];

    const ensureParents = (name: string): void => {
        let parent = path.posix.dirname(name);
        while (parent !== '/' && !dirs.has(parent)) {
            addDir(parent);
            parent = path.posix.dirname(parent);
        }
    };

    for (const { pkg, file } of apks) {
        const tar = untar(zlib.gunzipSync(fs.readFileSync(file)));
        for (const e of tar) {
            if (e.name.startsWith('.') || e.name.includes('/.')) continue; // .PKGINFO / .SIGN
            const name = `/${e.name}`;
            if (TRIM_PATTERNS.some(re => re.test(name))) continue;
            ensureParents(name);
            if (e.type === '5') addDir(name);
            else if (e.type === '2') addLink(name, e.linkname);
            else if (e.type === '1') {
                hardlinks.push({ name, target: `/${e.linkname.replace(/^\.\//, '')}`, mode: e.mode & 0o777 });
            } else if (e.type === '0' || e.type === '\0' || e.type === '7') {
                addFile(name, e.data, e.mode & 0o777);
                blobs.set(name, e.data);
            }
        }
        log(`pack    ${pkg.name}-${pkg.version}`);
    }

    for (const link of hardlinks) {
        const data = blobs.get(link.target);
        if (data) addFile(link.name, data, link.mode);
        else log(`warn    hardlink target missing: ${link.name} -> ${link.target}`);
    }

    addDev('/dev/console', 5, 1);
    addDev('/dev/tty', 5, 0);
    addDev('/dev/null', 1, 3);

    const init = `#!/bin/sh
/bin/mount -t proc proc /proc 2>/dev/null
/bin/mount -t sysfs sys /sys 2>/dev/null
/bin/mount -t devtmpfs dev /dev 2>/dev/null
/bin/mount -t tmpfs tmpfs /tmp 2>/dev/null
mkdir -p /mnt/9p 2>/dev/null
/bin/mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/9p 2>/dev/null
export PATH=/usr/bin:/bin:/sbin
export PYTHONIOENCODING=utf-8
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUNBUFFERED=1
export HOME=/root
echo SANDBOX_READY
exec /bin/sh
`;
    entries.push({ name: '/init', mode: 0o100755, data: Buffer.from(init, 'utf-8') });

    const chunks: Buffer[] = [];
    const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
    let ino = 1;
    for (const e of entries) {
        const nameBuf = Buffer.concat([Buffer.from(e.name, 'utf-8'), Buffer.alloc(1)]);
        chunks.push(Buffer.from(
            '070701' + hex8(ino++) + hex8(e.mode) + hex8(0) + hex8(0) + hex8(1) + hex8(0) +
            hex8(e.data.length) + hex8(0) + hex8(0) +
            hex8(e.rdev ? (e.rdev >> 8) & 0xff : 0) + hex8(e.rdev ? e.rdev & 0xff : 0) +
            hex8(nameBuf.length) + hex8(0), 'ascii'));
        chunks.push(nameBuf, Buffer.alloc((4 - ((110 + nameBuf.length) % 4)) % 4), e.data,
            Buffer.alloc((4 - (e.data.length % 4)) % 4));
    }
    const trailer = Buffer.from(
        '070701' + hex8(ino) + hex8(0) + hex8(0) + hex8(0) + hex8(1) + hex8(0) +
        hex8(0) + hex8(0) + hex8(0) + hex8(0) + hex8(0) + hex8(11) + hex8(0) + 'TRAILER!!!\0',
        'ascii');
    chunks.push(trailer, Buffer.alloc((4 - (trailer.length % 4)) % 4));

    const cpio = Buffer.concat(chunks);
    const gz = zlib.gzipSync(cpio, { level: 9 });
    fs.writeFileSync(dest, gz);
    log(`built   ${path.basename(dest)}  cpio=${(cpio.length / 1048576).toFixed(1)}MB gz=${(gz.length / 1048576).toFixed(1)}MB (${entries.length} entries)`);
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------

async function main(): Promise<void> {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(PKG_CACHE, { recursive: true });
    fs.mkdirSync(INDEX_DIR, { recursive: true });

    await download(`${V86_BIOS}/seabios.bin`, path.join(OUT, 'seabios.bin'), 100000);
    await download(`${V86_BIOS}/vgabios.bin`, path.join(OUT, 'vgabios.bin'), 10000);
    await download(V86_TEST_ISO, path.join(OUT, 'linux4.iso'), 1_000_000);

    extractFromIso(path.join(OUT, 'linux4.iso'), 'boot/bzimage', path.join(OUT, 'bzimage'));

    await loadIndexes();
    // 客户机需要：python3（常驻评测守护进程）+ g++（C++ 编译）+ busybox
    const closure = resolveClosure(['python3', 'busybox-static', 'g++']);
    log(`deps    ${closure.length} packages`);

    const apks: { pkg: Pkg; file: string }[] = [];
    for (const pkg of closure.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(PKG_CACHE, `${pkg.name}-${pkg.version}.apk`);
        await download(`${ALPINE}/${pkg.repo}/${ARCH}/${pkg.name}-${pkg.version}.apk`, file, 100);
        apks.push({ pkg, file });
    }

    buildInitramfs(apks, path.join(OUT, 'initramfs.cpio.gz'));

    console.log(`
\x1b[32m沙箱资源就绪\x1b[0m  ${OUT}

  下一步：
    1. 设置 JUDGE_SANDBOX=v86（或在 .env / 启动命令里导出）后启动 OJ
    2. OJ 启动时会在后台冷启动客户机（约 30~60s，日志里搜 "[Judge/v86]"），
       启动完成后常驻内存，之后每个测试点约 1~4s
    3. 沙箱模式当前只支持 Python；Node.js 在模拟器里启动过慢，暂不支持
    4. 客户机被用户代码搞死时会自动重建（重新冷启动一次），不影响服务

  如需清理：删除 data/sandbox 即可（下一次可重新运行本脚本生成）
`);
}

main().catch(err => {
    console.error(`\x1b[31m[sandbox] 失败：\x1b[0m ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
});
