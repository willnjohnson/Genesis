import { useCallback, useEffect, useRef, useState } from 'react';

/** The element holding the transcript or AI summary as it's read. Ctrl+F only ever looks inside it. */
export const FIND_SCOPE_SELECTOR = '#sidebar-container [data-find-scope]';

const ALL = 'find-all';
const CURRENT = 'find-current';

/** The text nodes under `root`, with where each starts in their combined text. */
function textNodesOf(root: Element) {
    const nodes: { node: Text; start: number }[] = [];
    let total = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n as Text, start: total });
        total += (n as Text).data.length;
    }
    return { nodes, total };
}

/** A spot `offset` characters into the combined text, as a node and an offset in it. */
function locate(nodes: { node: Text; start: number }[], offset: number, preferEnd: boolean): [Text, number] {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid].start <= offset) lo = mid;
        else hi = mid - 1;
    }
    // A boundary between two nodes belongs to the end of the first when closing a range.
    if (preferEnd && lo > 0 && nodes[lo].start === offset) lo--;
    return [nodes[lo].node, offset - nodes[lo].start];
}

/** Scrolls the nearest scrolling ancestor so `range` sits mid-view. Done by hand rather than with
 *  scrollIntoView, which would also scroll the panels that clip their content rather than scroll it. */
function scrollRangeIntoView(range: Range) {
    const el = range.startContainer.parentElement;
    if (!el) return;
    let box: HTMLElement | null = el;
    while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (!box) return;
    const top = range.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = top - box.clientHeight / 2;
}

/**
 * Ctrl+F for the transcript and AI summary while they're being read: finds text in what's rendered
 * (never the rest of the app), marks every match, and steps through them. Nothing is changed. The
 * matches are painted with the CSS Custom Highlight API, so the text itself is left untouched; where
 * that isn't available the current match is selected instead.
 *
 * `content` is the text shown; it's searched again when it changes.
 */
export function useReadFind(active: boolean, content: string) {
    const [findText, setFindText] = useState('');
    const [matchCase, setMatchCase] = useState(false);
    const [matchWholeWord, setMatchWholeWord] = useState(false);
    const [ranges, setRanges] = useState<Range[]>([]);
    const [current, setCurrent] = useState(-1);
    const rangesRef = useRef<Range[]>([]);

    const clearHighlights = useCallback(() => {
        if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
            CSS.highlights.delete(ALL);
            CSS.highlights.delete(CURRENT);
        }
    }, []);

    // Look for the text in what's on screen.
    useEffect(() => {
        const root = active && findText ? document.querySelector(FIND_SCOPE_SELECTOR) : null;
        if (!root) {
            rangesRef.current = [];
            setRanges([]);
            setCurrent(-1);
            return;
        }
        const { nodes } = textNodesOf(root);
        const full = nodes.map(n => n.node.data).join('');
        const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(matchWholeWord ? `(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])` : escaped, matchCase ? 'g' : 'gi');
        const found: Range[] = [];
        for (let m = pattern.exec(full); m; m = pattern.exec(full)) {
            if (m[0].length === 0) { pattern.lastIndex++; continue; }
            const range = document.createRange();
            const [startNode, startOffset] = locate(nodes, m.index, false);
            const [endNode, endOffset] = locate(nodes, m.index + m[0].length, true);
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);
            found.push(range);
        }
        rangesRef.current = found;
        setRanges(found);
        setCurrent(found.length > 0 ? 0 : -1);
    }, [active, findText, matchCase, matchWholeWord, content]);

    // Paint the matches, the current one differently, and bring it into view.
    useEffect(() => {
        clearHighlights();
        const range = ranges[current];
        if (!range) return;
        if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
            CSS.highlights.set(ALL, new Highlight(...ranges));
            CSS.highlights.set(CURRENT, new Highlight(range));
        } else {
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
        }
        scrollRangeIntoView(range);
    }, [ranges, current, clearHighlights]);

    // Closing it takes the marks off.
    useEffect(() => {
        if (!active) {
            clearHighlights();
            setFindText('');
        }
    }, [active, clearHighlights]);
    useEffect(() => clearHighlights, [clearHighlights]);

    const navigateMatch = (dir: 'next' | 'prev') => {
        const count = rangesRef.current.length;
        if (count === 0) return;
        setCurrent(i => (dir === 'next' ? (i + 1) % count : (i - 1 + count) % count));
    };

    return {
        findText, setFindText,
        matchCase, setMatchCase,
        matchWholeWord, setMatchWholeWord,
        matchCount: ranges.length,
        currentIndex: current,
        navigateMatch,
    };
}
