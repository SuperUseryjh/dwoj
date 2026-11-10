/** 忽略行末空格与首尾空行，保持其余内容严格一致 */
export function normalizeOutput(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .trim();
}

export function compareOutput(actual: string, expected: string): boolean {
    return normalizeOutput(actual) === normalizeOutput(expected);
}
