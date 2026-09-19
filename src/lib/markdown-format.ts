/**
 * The text with inline formatting (bold, italic, strikethrough, highlight, code, links) and each
 * line's heading, quote or list marker removed. Used by the editor's "Clear formatting" action
 * (lib/markdown-editor.ts).
 */
export function stripMarkdownFormatting(text: string): string {
    return text
        .split('\n')
        .map(line => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/, ''))
        .join('\n')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/gs, '$1')
        .replace(/~~(.+?)~~/gs, '$1')
        .replace(/==(.+?)==/gs, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/gs, '$1')
        .replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/gs, '$1');
}
