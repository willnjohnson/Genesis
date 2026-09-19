import type { Parent, PhrasingContent, RootContent, Text } from 'mdast';

/**
 * Remark plugin for ==highlighted text== (rendered as <mark>). Used by every markdown view in the
 * app together with remark-gfm, and matched by the Ctrl+H shortcut in lib/markdown-editor.ts.
 * Obsidian understands the same syntax, so exported notes keep their highlights.
 *
 * Follows the usual flanking rule for inline marks: the opening == must be followed by
 * non-whitespace and the closing == preceded by it, so a prose comparison like "a == b or c == d"
 * stays as written. The marked text can contain other formatting (==some **bold** text==) and
 * can't span paragraphs. Code is never touched, since it isn't text to this plugin.
 */

const DELIM = '==';

type Piece =
    | { kind: 'text'; value: string }
    | { kind: 'node'; node: RootContent }
    | { kind: 'delim'; canOpen: boolean; canClose: boolean };

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

function toPieces(children: RootContent[]): Piece[] {
    const pieces: Piece[] = [];
    for (const child of children) {
        if (child.type !== 'text') {
            pieces.push({ kind: 'node', node: child });
            continue;
        }
        const parts = child.value.split(DELIM);
        parts.forEach((part, i) => {
            if (i > 0) pieces.push({ kind: 'delim', canOpen: false, canClose: false });
            if (part) pieces.push({ kind: 'text', value: part });
        });
    }
    // Which side of each delimiter has real content decides if it can open or close a mark.
    // A neighbouring non-text node (bold, a link, ...) counts as content; the edge of the
    // paragraph, or another delimiter, counts as space.
    pieces.forEach((p, k) => {
        if (p.kind !== 'delim') return;
        const before = pieces[k - 1];
        const after = pieces[k + 1];
        const lastCharBefore = !before || before.kind === 'delim' ? undefined : before.kind === 'text' ? before.value.slice(-1) : 'x';
        const firstCharAfter = !after || after.kind === 'delim' ? undefined : after.kind === 'text' ? after.value[0] : 'x';
        p.canClose = !isSpace(lastCharBefore);
        p.canOpen = !isSpace(firstCharAfter);
    });
    return pieces;
}

function literal(value: string): Text {
    return { type: 'text', value };
}

/** Rebuilds `children` with each matched pair of delimiters turned into a highlight. */
function applyMarks(children: RootContent[]): RootContent[] {
    if (!children.some(c => c.type === 'text' && c.value.includes(DELIM))) return children;

    const pieces = toPieces(children);
    // Pair up delimiters left to right: an opener waits for the next closer.
    const closerOf = new Map<number, number>();
    let open: number | null = null;
    pieces.forEach((p, k) => {
        if (p.kind !== 'delim') return;
        if (open === null) {
            if (p.canOpen) open = k;
        } else if (p.canClose) {
            closerOf.set(open, k);
            open = null;
        } else if (p.canOpen) {
            open = k;
        }
    });

    const build = (from: number, to: number): RootContent[] => {
        const out: RootContent[] = [];
        for (let k = from; k < to; k++) {
            const p = pieces[k];
            if (p.kind === 'text') out.push(literal(p.value));
            else if (p.kind === 'node') out.push(p.node);
            else if (closerOf.has(k)) {
                const close = closerOf.get(k)!;
                // An emphasis node that renders as <mark>, so no custom node type is needed.
                out.push({
                    type: 'emphasis',
                    data: { hName: 'mark' },
                    children: build(k + 1, close) as PhrasingContent[],
                });
                k = close;
            } else out.push(literal(DELIM));
        }
        return out;
    };

    // Adjacent text pieces (a literal == next to text) are merged so the tree stays tidy.
    const merged: RootContent[] = [];
    for (const node of build(0, pieces.length)) {
        const last = merged[merged.length - 1];
        if (node.type === 'text' && last?.type === 'text') last.value += node.value;
        else merged.push(node);
    }
    return merged;
}

function walk(node: RootContent | Parent) {
    if (!('children' in node)) return;
    const parent = node as Parent;
    // Inner formatting first, so ==**bold**== and **==marked==** both work.
    for (const child of parent.children) walk(child);
    parent.children = applyMarks(parent.children);
}

export function remarkHighlight() {
    return (tree: Parent) => walk(tree);
}
