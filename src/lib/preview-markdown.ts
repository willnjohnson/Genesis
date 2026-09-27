/**
 * Boils a markdown entry down to *inline-only* markdown for a small preview (the glossary hover card): every block
 * becomes one line of text, so the whole thing is a single paragraph that can be cut off with an ellipsis after a few
 * lines, while bold, italics, strikethrough, highlight, inline code and links are left for the renderer to show.
 *
 *  - headings become a bold line (no `#`)
 *  - lists keep a bullet (or their number), one line per item, nesting flattened
 *  - quotes keep a bar in front of their lines
 *  - tables become one line per row, cells joined with " · " (the header row bold)
 *  - code blocks keep their first few lines, each as inline code
 *  - images, horizontal rules and HTML tags are dropped
 */

const MAX_CODE_LINES = 3;
const RULE = /^\s*([-*_]\s*){3,}$/;
const SETEXT = /^\s*(=+|-+)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$|^[^|]+\|[^|]+/;

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()).filter(Boolean);

/** `term` is the entry's own name: a first heading that only repeats it is left out (the card's title already says it). */
export function inlineMarkdown(markdown: string, term = '', maxChars = 1200): string {
    const source = markdown
        .replace(/\r\n?/g, '\n')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<\/?[a-zA-Z][^>]*>/g, '');
    const lines = source.split('\n');
    const out: string[] = [];
    let inCode = false;
    let codeLines = 0;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (/^\s*(```|~~~)/.test(raw)) {
            inCode = !inCode;
            codeLines = 0;
            continue;
        }
        if (inCode) {
            if (raw.trim() && codeLines < MAX_CODE_LINES) {
                out.push('`' + raw.trim().replace(/`/g, "'") + '`');
                codeLines++;
            } else if (raw.trim() && codeLines === MAX_CODE_LINES) {
                out.push('`…`');
                codeLines++;
            }
            continue;
        }
        const line = raw.trim();
        if (!line || RULE.test(line) || SETEXT.test(line)) continue;

        // A table: its separator row (|---|---|) makes the row before it a header; rows join their cells.
        if (TABLE_SEPARATOR.test(line) && line.includes('-') && line.includes('|')) {
            if (out.length > 0 && /\|/.test(lines[i - 1] ?? '')) out[out.length - 1] = `**${out[out.length - 1]}**`;
            continue;
        }
        if (line.includes('|') && TABLE_ROW.test(line) && (TABLE_SEPARATOR.test((lines[i + 1] ?? '').trim()) || /\|/.test(lines[i - 1] ?? '') || /\|/.test(lines[i + 1] ?? ''))) {
            out.push(cells(line).join(' · '));
            continue;
        }

        let m: RegExpMatchArray | null;
        if ((m = line.match(/^#{1,6}\s+(.+?)\s*#*$/))) {
            out.push(m[1].startsWith('**') ? m[1] : `**${m[1]}**`);
        } else if ((m = line.match(/^>+\s?(.*)$/))) {
            if (m[1].trim()) out.push('▎ ' + m[1].trim());
        } else if ((m = line.match(/^(\d+)[.)]\s+(.+)$/))) {
            // The number is escaped, or the line would read as a list item again.
            out.push(`${m[1]}\\. ${m[2]}`);
        } else if ((m = line.match(/^[-*+]\s+(.+)$/))) {
            out.push('• ' + m[1].replace(/^\[[ xX]\]\s+/, ''));
        } else {
            out.push(line);
        }
    }

    if (term && out[0]?.replace(/^\*\*|\*\*$/g, '').trim().toLowerCase() === term.trim().toLowerCase()) out.shift();

    // Whole lines up to the character budget, so nothing is cut in the middle of a mark.
    const kept: string[] = [];
    let used = 0;
    for (const line of out) {
        if (kept.length > 0 && used + line.length > maxChars) break;
        kept.push(line);
        used += line.length + 1;
    }
    return kept.join('\n');
}
