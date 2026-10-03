import type { Parent, RootContent, Text } from 'mdast';

/**
 * Remark plugin for video timestamps: [1:23] or [1:02:03] becomes a chip that, clicked, jumps the sidebar's player
 * to that moment (see Sidebar.tsx's seek handler, which finds the chip by its data-k-seek attribute). The square
 * brackets are what set a timestamp apart from a time of day ("12:00 PM" stays text). Seconds, and minutes when
 * there are hours, must be 00 to 59; minutes alone can run past an hour ([75:30]). Text inside links and code is
 * left alone. Plain-text transcripts get the same chips from `splitTimestamps` (components/sidebar/TranscriptText.tsx).
 */

// Global, so its lastIndex must be reset before each use (splitTimestamps does).
export const TIMESTAMP_RE = /\[(?:(\d{1,2}):([0-5]\d)|(\d{1,3})):([0-5]\d)\]/g;

/** The attribute a timestamp chip carries, holding its time in whole seconds. */
export const SEEK_ATTR = 'data-k-seek';

/** The chip's look, shared by both renderings. */
export const TIMESTAMP_CLASS =
    'k-timestamp inline-flex items-baseline rounded px-1 font-mono text-[0.85em] leading-snug no-underline align-baseline cursor-pointer ' +
    'bg-[var(--k-accent)]/15 text-[var(--k-accent)] hover:bg-[var(--k-accent)]/25 transition-colors';

/** A match's time in seconds: hours, minutes, seconds or minutes, seconds. */
function secondsOf(m: RegExpExecArray): number {
    const [, h, mm, mOnly, ss] = m;
    return h !== undefined ? Number(h) * 3600 + Number(mm) * 60 + Number(ss) : Number(mOnly) * 60 + Number(ss);
}

/** A time as a video link's `?t=` writes it (lib/internal-links.ts): whole seconds ("83"), or the same "1:23" /
 *  "1:02:03" a timestamp chip takes, in seconds; null when it's neither. */
export function parseClock(value: string): number | null {
    if (/^\d+$/.test(value)) return Number(value);
    const m = /^(?:(\d{1,2}):([0-5]\d)|(\d{1,3})):([0-5]\d)$/.exec(value);
    if (!m) return null;
    const [, h, mm, mOnly, ss] = m;
    return h !== undefined ? Number(h) * 3600 + Number(mm) * 60 + Number(ss) : Number(mOnly) * 60 + Number(ss);
}

/** Seconds as a clock: "1:23", or "1:02:03" past an hour. */
export function formatClock(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `text` cut into its plain runs and its timestamps, in order. */
export function splitTimestamps(text: string): ({ text: string } | { label: string; seconds: number })[] {
    const out: ({ text: string } | { label: string; seconds: number })[] = [];
    TIMESTAMP_RE.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = TIMESTAMP_RE.exec(text))) {
        if (m.index > last) out.push({ text: text.slice(last, m.index) });
        out.push({ label: m[0].slice(1, -1), seconds: secondsOf(m) });
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
}

function chip(label: string, seconds: number): RootContent {
    // An emphasis node that renders as a <button>, so no custom node type is needed (as remark-highlight does for <mark>).
    return {
        type: 'emphasis',
        data: { hName: 'button', hProperties: { type: 'button', className: TIMESTAMP_CLASS.split(' '), [SEEK_ATTR]: String(seconds), title: `Jump to ${label}` } },
        children: [{ type: 'text', value: label } as Text],
    };
}

function walk(node: RootContent | Parent, chips: boolean) {
    if (!('children' in node)) return;
    const parent = node as Parent;
    if (parent.type === 'link' || parent.type === 'linkReference') return;
    const next: RootContent[] = [];
    for (const child of parent.children) {
        if (child.type !== 'text' || !child.value.includes('[')) {
            walk(child, chips);
            next.push(child);
            continue;
        }
        if (!chips) {
            // Only the link shortcut: a [5:50] straight after a video link joins it; any other one stays as written.
            const first = splitTimestamps(child.value)[0];
            const before = next[next.length - 1];
            if (first && !('text' in first) && before?.type === 'link' && /^kinesis:\/\/video\/[^?]+$/.test(before.url)) {
                before.url = `${before.url}?t=${first.label}`;
                const rest = child.value.slice(first.label.length + 2);
                if (rest) next.push({ type: 'text', value: rest });
            } else {
                next.push(child);
            }
            continue;
        }
        splitTimestamps(child.value).forEach((piece, i) => {
            if ('text' in piece) {
                next.push({ type: 'text', value: piece.text });
                return;
            }
            // Right after a video link without a time (no space between), the timestamp is the link's own: the shortcut
            // for `?t=` (lib/internal-links.ts's foldVideoLinkTimes, which writes it in on save), so it shows the same now.
            const before = next[next.length - 1];
            if (i === 0 && before?.type === 'link' && /^kinesis:\/\/video\/[^?]+$/.test(before.url)) {
                before.url = `${before.url}?t=${piece.label}`;
                return;
            }
            next.push(chip(piece.label, piece.seconds));
        });
    }
    parent.children = next;
}

/** `chips: false` is for text with no video player beside it (Glossary, Biography): there a lone [1:23] has nothing
 *  to jump, so it stays as written, and only the link shortcut ([Talk](kinesis://video/ID)[5:50]) is read. */
export function remarkTimestamps(options: { chips?: boolean } = {}) {
    const chips = options.chips ?? true;
    return (tree: Parent) => walk(tree, chips);
}
