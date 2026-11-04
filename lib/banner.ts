/**
 * 启动横幅（ASCII Art）。
 *
 * 只在「主进程认为启动完成」时打印：即 broker 拉起 db/http/judge 并全部就绪之后，
 * 沙箱客户机的后台冷启动不算在内（v86 会在 ready 之后继续在后台解压 initramfs）。
 *
 * 非 TTY（Docker / systemd / 管道）时自动关闭颜色，但仍然输出，
 * 方便通过 `docker logs` 看到版本与监听端口。
 */

const GLYPHS: Record<string, string[]> = {
    D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
    W: ['██╗    ██╗', '██║    ██║', '██║ █╗ ██║', '██║███╗██║', '╚███╔███╔╝', ' ╚══╝╚══╝ '],
    O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
    J: ['     ██╗', '     ██║', '     ██║', '██   ██║', '╚█████╔╝', ' ╚════╝ '],
};

const WORDMARK: string[] = Array.from({ length: 6 }, (_unused, row) =>
    ['D', 'W', 'O', 'J'].map(letter => GLYPHS[letter][row]).join(' '));

const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
};

export interface StartupInfo {
    version: string;
    port: number;
    mode: 'multi-process' | 'single-process';
    backend?: string;
    languages?: string[];
    pid: number;
    logFile?: string;
}

/** 去掉 ANSI 转义，用于计算真实显示宽度 */
export function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function displayWidth(text: string): number {
    return [...stripAnsi(text)].length;
}

/** 终端是否支持颜色 */
export function supportsColor(): boolean {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
    return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
}

function padRight(text: string, targetWidth: number): string {
    const diff = targetWidth - displayWidth(text);
    return diff > 0 ? text + ' '.repeat(diff) : text;
}

/**
 * 生成横幅文本（不含结尾换行）。
 * 用 `color: false` 可以拿到纯文本版本，方便测试与重定向。
 */
export function renderBanner(info: StartupInfo, options: { color?: boolean } = {}): string {
    const color = options.color ?? false;
    const paint = (code: string, text: string): string => (color ? `${code}${text}${ANSI.reset}` : text);

    const backend = info.backend || 'unknown';
    const languages = info.languages && info.languages.length > 0 ? info.languages.join(', ') : 'n/a';

    const details: string[] = [
        `${paint(ANSI.bold, `DWOJ ${info.version}`)}  ${paint(ANSI.dim, '· online judge')}`,
        `http://localhost:${info.port}`,
        `mode    ${info.mode}${info.mode === 'multi-process' ? ` (broker ${info.pid})` : ''}`,
        `judge   ${backend} (${languages})`,
    ];
    if (backend === 'v86') {
        details.push(paint(ANSI.dim, 'guest   booting in background, see [v86] logs'));
    }
    if (info.logFile) {
        details.push(paint(ANSI.dim, `log     ${info.logFile}`));
    }

    const inner = Math.max(...WORDMARK.map(displayWidth), ...details.map(displayWidth)) + 2;
    const border = (left: string, right: string): string => paint(ANSI.cyan, left + '─'.repeat(inner) + right);
    const row = (text: string, alignLeft = 1): string => {
        const left = ' '.repeat(alignLeft);
        const content = padRight(left + text, inner);
        return paint(ANSI.cyan, '│') + content + paint(ANSI.cyan, '│');
    };

    const lines: string[] = [border('╭', '╮')];
    for (const artLine of WORDMARK) {
        lines.push(row(paint(ANSI.magenta, artLine)));
    }
    lines.push(row(''));
    for (const detail of details) {
        lines.push(row(detail));
    }
    lines.push(border('╰', '╯'));

    return lines.join('\n');
}

/** 打印横幅（TTY 下带颜色） */
export function printBanner(info: StartupInfo): void {
    process.stdout.write(renderBanner(info, { color: supportsColor() }) + '\n');
}
