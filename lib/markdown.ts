/** 极简 Markdown 渲染：段落 / 粗体 / 行内代码 / 链接 / 换行（无外部依赖） */

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderInline(text: string): string {
    const codeStore: string[] = [];
    let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_m, code: string) => {
        codeStore.push(code);
        return `\u0000${codeStore.length - 1}\u0000`;
    });

    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');

    return out.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => `<code>${codeStore[Number(idx)]}</code>`);
}

export function renderMarkdown(content: string | null | undefined): string {
    if (!content) return '';
    const blocks = String(content).replace(/\r\n/g, '\n').split(/\n{2,}/);
    return blocks.map(block => {
        const lines = block.split('\n').map(renderInline);
        return `<p>${lines.join('<br>')}</p>`;
    }).join('\n');
}
