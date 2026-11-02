/**
 * 输出比对。
 * 规则：统一换行符、删除每行行末空白、忽略文末多余空行；
 * 行首空白与行内空白保持敏感（这些在题目语义里可能是有意义的）。
 */
export function normalizeOutput(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n+$/, '');
}

export function compareOutput(actual: string, expected: string): boolean {
    return normalizeOutput(actual) === normalizeOutput(expected);
}
