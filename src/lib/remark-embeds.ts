import type { Link, Paragraph, PhrasingContent, Root, RootContent } from 'mdast';

/**
 * Remark plugin: a video or playlist link on a line of its own shows as a card (MarkdownLink.tsx draws it), the way a
 * pasted link unfurls in a chat app. A link inside a sentence stays a link: a card there would break the sentence.
 *
 * "A line of its own" is a line of the source, not only a paragraph: in
 *
 *     Watch these first:
 *     [Data Structures playlist](kinesis://playlist/%3ACS-DSA)
 *
 * the link has its own line, though markdown makes the two lines one paragraph. Such a paragraph is split around the
 * link: the lines before and after stay paragraphs, and the link becomes a block of its own (a div, since a card can't
 * sit inside a <p>) marked `data-embed`. The stored markdown is untouched, so exports and sync see ordinary links.
 *
 * Run it before remarkSourceLines (lib/preview-sync.ts): the blocks it makes carry the positions of their lines, so the
 * editor and preview still line up.
 */

const EMBEDDABLE = /^kinesis:\/\/(video|playlist)\//;

const isEmbeddable = (node: PhrasingContent): node is Link => node.type === 'link' && EMBEDDABLE.test(node.url);
const isBlank = (node: PhrasingContent) => node.type === 'text' && node.value.trim() === '';

interface Line {
    nodes: PhrasingContent[];
    /** What separated it from the line before: a soft line break ('\n' in the text) or a hard one. */
    sep: 'soft' | 'hard' | null;
}

function spanOf(nodes: PhrasingContent[]): Paragraph['position'] {
    const first = nodes.find(n => n.position)?.position;
    const last = [...nodes].reverse().find(n => n.position)?.position;
    return first && last ? { start: first.start, end: last.end } : undefined;
}

function splitParagraph(paragraph: Paragraph): RootContent[] {
    const lines: Line[] = [{ nodes: [], sep: null }];
    for (const child of paragraph.children) {
        if (child.type === 'text' && child.value.includes('\n')) {
            child.value.split('\n').forEach((part, i) => {
                if (i > 0) lines.push({ nodes: [], sep: 'soft' });
                if (part) lines[lines.length - 1].nodes.push({ ...child, value: part });
            });
        } else if (child.type === 'break') {
            lines.push({ nodes: [], sep: 'hard' });
        } else {
            lines[lines.length - 1].nodes.push(child);
        }
    }
    const embedIn = (line: Line): Link | null => {
        const meaningful = line.nodes.filter(n => !isBlank(n));
        return meaningful.length === 1 && isEmbeddable(meaningful[0]) ? meaningful[0] : null;
    };
    if (!lines.some(embedIn)) return [paragraph];

    const out: RootContent[] = [];
    let pending: Line[] = [];
    const flush = () => {
        const children: PhrasingContent[] = [];
        pending.forEach((line, i) => {
            if (i > 0) children.push(line.sep === 'hard' ? { type: 'break' } : { type: 'text', value: '\n' });
            children.push(...line.nodes);
        });
        if (children.some(n => !isBlank(n) && n.type !== 'break')) {
            out.push({ type: 'paragraph', children, position: spanOf(children) });
        }
        pending = [];
    };
    for (const line of lines) {
        const link = embedIn(line);
        if (!link) {
            pending.push(line);
            continue;
        }
        flush();
        const marked: Link = { ...link, data: { ...link.data, hProperties: { ...link.data?.hProperties, dataEmbed: 'true' } } };
        out.push({ type: 'paragraph', children: [marked], position: link.position, data: { hName: 'div', hProperties: { className: ['k-embed'] } } });
    }
    flush();
    return out;
}

function transform(parent: Root | RootContent) {
    if (!('children' in parent)) return;
    const next: RootContent[] = [];
    for (const child of parent.children as RootContent[]) {
        if (child.type === 'paragraph') next.push(...splitParagraph(child));
        else {
            transform(child);
            next.push(child);
        }
    }
    (parent as { children: RootContent[] }).children = next;
}

export function remarkEmbeds() {
    return (tree: Root) => transform(tree);
}
