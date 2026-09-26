import type { Root, RootContent } from 'mdast';

/**
 * Keeps the markdown editor and its rendered preview looking at the same place. Going into the
 * preview scrolls it to the text the caret was in, and going back to the editor scrolls it to what
 * the preview was showing, with the same placement on screen.
 *
 * The two views are tied together by source line: the remark plugin below writes each block's line
 * number into the rendered HTML (data-line), and the helpers turn a line into a spot in the preview
 * and back.
 */

const BLOCKS = new Set(['heading', 'paragraph', 'listItem', 'blockquote', 'code', 'table', 'thematicBreak', 'html']);

/** Remark plugin: marks every block in the preview with the line of the text it came from (data-line). */
export function remarkSourceLines() {
    const mark = (node: Root | RootContent) => {
        if (BLOCKS.has(node.type) && node.position) {
            const data = (node.data ??= {}) as { hProperties?: Record<string, unknown> };
            data.hProperties = { ...data.hProperties, 'data-line': node.position.start.line };
        }
        if ('children' in node) (node.children as RootContent[]).forEach(mark);
    };
    return (tree: Root) => mark(tree);
}

/** The 1-based line `index` falls on. */
export function lineAt(text: string, index: number): number {
    let line = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
    return line;
}

/** Where `line` (1-based) starts in `text`. */
export function indexOfLine(text: string, line: number): number {
    let index = 0;
    for (let l = 1; l < line; l++) {
        const next = text.indexOf('\n', index);
        if (next === -1) return text.length;
        index = next + 1;
    }
    return index;
}

/**
 * How far down a textarea's text `index` is drawn (what its scrollTop would be to have it at the very
 * top). Lines wrap, so it can't be worked out from the line number: the text up to `index` is laid out
 * in a hidden copy of the textarea and measured.
 */
export function caretY(textarea: HTMLTextAreaElement, index: number): number {
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    for (const prop of ['boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'tabSize',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth'] as const) {
        mirror.style[prop] = style[prop];
    }
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.overflowWrap = 'break-word';
    mirror.textContent = textarea.value.slice(0, index);
    const marker = document.createElement('span');
    marker.textContent = '.';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const y = marker.offsetTop;
    document.body.removeChild(mirror);
    return y;
}

const lineOf = (el: Element) => Number(el.getAttribute('data-line'));

/** Scrolls the preview so the block holding `line` is `at` (0-1) of the way down its visible area. A preview
 *  with no marked blocks (a plain-text transcript) is scrolled by `fraction` (how far through the text the
 *  spot is, 0-1) instead. */
export function scrollPreviewToLine(container: HTMLElement, line: number, at = 0.3, fraction = 0): void {
    let target: HTMLElement | null = null;
    for (const el of container.querySelectorAll<HTMLElement>('[data-line]')) {
        if (lineOf(el) > line) break;
        target = el;
    }
    if (!target) {
        container.scrollTop = fraction * container.scrollHeight - container.clientHeight * at;
        return;
    }
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTop = top - container.clientHeight * at;
}

/** The first block showing in the preview: its source line, and how far below the top edge it is (negative
 *  when it's partly scrolled off). */
export function topVisibleLine(container: HTMLElement): { line: number; offset: number } | null {
    const containerTop = container.getBoundingClientRect().top;
    for (const el of container.querySelectorAll<HTMLElement>('[data-line]')) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > containerTop + 1) return { line: lineOf(el), offset: rect.top - containerTop };
    }
    return null;
}
