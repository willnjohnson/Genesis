/**
 * The text logic behind the markdown editor's lists (bullets, numbers and tasks), tables and
 * horizontal rules, kept apart from the textarea handling in lib/markdown-editor.ts so it can be
 * tested on its own. Everything here works on plain strings. The syntax is GitHub-flavoured
 * markdown, which Obsidian reads too: `- item`, `1. item`, `- [ ] task`, `- [x] done`, pipe tables
 * and `---`.
 */

// indent, then a bullet (-, * or +) or a number with . or ), then the gap, then an optional [ ] / [x].
const ITEM_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(?:\[([ xX])\](?:[ \t]+|$))?/;

export interface ListItem {
    indent: string;
    /** The bullet character, or null for a numbered item. */
    bullet: string | null;
    /** The item's number, or null for a bullet. */
    number: number | null;
    /** The `.` or `)` after a number. */
    delimiter: string | null;
    /** The whitespace between the marker and the text. */
    gap: string;
    /** ' ' open, 'x' or 'X' done, or null when the item isn't a task. */
    checkbox: string | null;
    /** Where the "[ ]" starts, when there is one. */
    checkboxAt: number;
    /** Length of everything up to the item's text: "- [ ] ". */
    markerLength: number;
    /** How far a child item is indented under this one: "- " is 2, "1. " is 3. */
    nestWidth: number;
    text: string;
}

export function parseListItem(line: string): ListItem | null {
    const m = ITEM_RE.exec(line);
    if (!m) return null;
    const marker = m[2] ?? `${m[3]}${m[4]}`;
    return {
        indent: m[1],
        bullet: m[2] ?? null,
        number: m[3] === undefined ? null : parseInt(m[3], 10),
        delimiter: m[4] ?? null,
        gap: m[5],
        checkbox: m[6] ?? null,
        checkboxAt: m[1].length + marker.length + m[5].length,
        markerLength: m[0].length,
        nestWidth: marker.length + Math.min(m[5].length, 4),
        text: line.slice(m[0].length),
    };
}

/** A list item that has a checkbox. */
export function parseTask(line: string): ListItem | null {
    const item = parseListItem(line);
    return item && item.checkbox !== null ? item : null;
}

/** Toggles task lists on the given lines. If every non-blank line is already a task the list markers
 *  are removed; otherwise every line becomes one (bullets and numbered items are converted, tasks stay). */
export function toggleTaskLines(lines: string[]): string[] {
    const content = lines.filter(l => l.trim() !== '');
    if (content.length > 0 && content.every(l => parseTask(l))) {
        return lines.map(l => {
            const t = parseTask(l);
            return t ? t.indent + t.text : l;
        });
    }
    return lines.map(l => {
        if (l.trim() === '') return lines.length === 1 ? `${l.match(/^\s*/)![0]}- [ ] ` : l;
        if (parseTask(l)) return l;
        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(l);
        if (bullet) return `${bullet[1]}- [ ] ${bullet[2]}`;
        const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(l);
        if (numbered) return `${numbered[1]}- [ ] ${numbered[2]}`;
        const indent = l.match(/^\s*/)![0];
        return `${indent}- [ ] ${l.slice(indent.length)}`;
    });
}

/** Flips a task between open and done. Other lines are returned as they are. */
export function toggleDone(line: string): string {
    const t = parseTask(line);
    if (!t) return line;
    const at = t.checkboxAt + 1;
    return line.slice(0, at) + (t.checkbox === ' ' ? 'x' : ' ') + line.slice(at + 1);
}

export type EnterResult =
    | { kind: 'none' }
    /** Insert this (a line break and the next item's marker) at the caret. */
    | { kind: 'continue'; insert: string }
    /** The item is empty at the top level: remove its marker, ending the list. */
    | { kind: 'clear' }
    /** The item is empty and nested: move it out one level. */
    | { kind: 'outdent' };

/** What Enter should do with the caret at `caret` (an offset in `line`). `none` means the normal newline. */
export function enterOnList(line: string, caret: number): EnterResult {
    const item = parseListItem(line);
    if (!item || caret < item.markerLength) return { kind: 'none' };
    if (item.text.trim() === '') return item.indent.length > 0 ? { kind: 'outdent' } : { kind: 'clear' };
    const marker = item.bullet ?? `${(item.number ?? 0) + 1}${item.delimiter}`;
    return { kind: 'continue', insert: `\n${item.indent}${marker}${item.gap}${item.checkbox !== null ? '[ ] ' : ''}` };
}

// ── Nesting ──────────────────────────────────────────────────────────────────

/** The indent (in characters) Tab gives `line`: nested one level under the item above it. Null when
 *  it can't go deeper (no list item above, or it is already a child of it). */
export function indentTarget(previousLine: string | undefined, line: string): number | null {
    const own = parseListItem(line);
    const prev = previousLine === undefined ? null : parseListItem(previousLine);
    if (!own || !prev) return null;
    const ownLen = own.indent.length;
    const prevLen = prev.indent.length;
    if (prevLen < ownLen) return null;
    const target = ownLen + (prevLen === ownLen ? prev.nestWidth : own.nestWidth);
    return target <= prevLen + prev.nestWidth ? target : null;
}

/** The indent Shift+Tab gives `line`: that of the closest item above it that sits further out.
 *  `above` is the text above, nearest line last. Null when the line is already at the top level. */
export function outdentTarget(above: string[], line: string): number | null {
    const own = parseListItem(line);
    if (!own || own.indent.length === 0) return null;
    for (let i = above.length - 1; i >= 0; i--) {
        if (above[i].trim() === '') continue;
        const item = parseListItem(above[i]);
        if (!item) break;
        if (item.indent.length < own.indent.length) return item.indent.length;
    }
    return 0;
}

/** Moves lines in or out by `delta` characters (out removes up to that many spaces, or a tab). */
export function shiftLines(lines: string[], delta: number): string[] {
    return lines.map(l => {
        if (l.trim() === '') return l;
        if (delta >= 0) return ' '.repeat(delta) + l;
        if (l.startsWith('\t')) return l.slice(1);
        const spaces = /^ */.exec(l)![0].length;
        return l.slice(Math.min(spaces, -delta));
    });
}

/** The empty item a blank line becomes when Tab is pressed under an item: the same kind, one level in. */
export function nestedItemUnder(previousLine: string): string | null {
    const above = parseListItem(previousLine);
    if (!above) return null;
    const marker = above.bullet ?? `1${above.delimiter}`;
    return `${' '.repeat(above.indent.length + above.nestWidth)}${marker} ${above.checkbox !== null ? '[ ] ' : ''}`;
}

/** The first and last index of the run of list items (no blank or text lines between) around `index`. */
export function listBlock(lines: string[], index: number): [number, number] {
    let first = index;
    let last = index;
    while (first > 0 && parseListItem(lines[first - 1])) first--;
    while (last < lines.length - 1 && parseListItem(lines[last + 1])) last++;
    return [first, last];
}

/**
 * Renumbers the numbered items in a run of list lines so each list counts 1, 2, 3 from its own start.
 * Moving an item in or out changes which list it belongs to, and the number it carried is wrong there:
 * a "2." nested under "1." starts a new list, so it is 1, and the items after it carry on from the
 * list they are in. The first item of the outermost list keeps the number it started with.
 */
export function renumberOrdered(lines: string[]): string[] {
    const items = lines.map(parseListItem);
    const indents = items.flatMap(i => (i ? [i.indent.length] : []));
    if (indents.length === 0) return lines;
    const outermost = Math.min(...indents);
    const last = new Map<number, number>();
    return lines.map((line, i) => {
        const item = items[i];
        if (!item) return line;
        const at = item.indent.length;
        for (const key of [...last.keys()]) if (key > at) last.delete(key);
        if (item.number === null) {
            last.delete(at);
            return line;
        }
        const next = last.has(at) ? last.get(at)! + 1 : at === outermost ? item.number : 1;
        last.set(at, next);
        return line.replace(/^([ \t]*)\d{1,9}/, `$1${next}`);
    });
}

// ── Tables ───────────────────────────────────────────────────────────────────

export const TABLE_TEMPLATE = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |';
/** Where "Column 1" starts inside TABLE_TEMPLATE, to select it for typing over. */
export const TABLE_FIRST_CELL = { start: 2, length: 'Column 1'.length };

/** A pipe table from tab-separated text (what copying cells out of a spreadsheet gives), or null
 *  when the text has no tabs. The first row becomes the header. */
export function tableFromTabs(text: string): string | null {
    if (!text.includes('\t')) return null;
    const rows = text
        .split('\n')
        .map(r => r.replace(/\r$/, ''))
        .filter(r => r.trim() !== '')
        .map(r => r.split('\t').map(c => c.trim().replace(/\|/g, '\\|')));
    if (rows.length === 0) return null;
    const width = Math.max(...rows.map(r => r.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

/**
 * What to insert to put a block (a table, a rule) after the line ending at `lineEnd`, with a blank line
 * on each side. A block that touches the paragraph above would change its meaning (`---` right under a
 * line of text makes that line a heading), so the blank lines matter.
 */
export function blockInsertion(value: string, lineEnd: number, block: string): { insert: string; blockStart: number } {
    const lineStart = value.lastIndexOf('\n', lineEnd - 1) + 1;
    const lineIsEmpty = value.slice(lineStart, lineEnd).trim() === '';
    // Under a line of text it takes a blank line. On an empty line the block goes on that line, and
    // that is only blank enough if the line above it is blank too.
    const previousLine = lineStart === 0 ? '' : value.slice(value.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1);
    const before = !lineIsEmpty ? '\n\n' : previousLine.trim() === '' ? '' : '\n';
    const rest = value.slice(lineEnd);
    const after = rest === '' || rest === '\n' || rest.startsWith('\n\n') ? '' : '\n';
    return { insert: before + block + after, blockStart: before.length };
}
