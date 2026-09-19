import type { KeyboardEvent, MouseEvent } from 'react';
import { requestLinkPicker } from './internal-links';
import { stripMarkdownFormatting } from './markdown-format';
import {
    blockInsertion, enterOnList, indentTarget, listBlock, nestedItemUnder, outdentTarget, parseListItem, parseTask,
    renumberOrdered, shiftLines, TABLE_FIRST_CELL, TABLE_TEMPLATE, tableFromTabs, toggleDone, toggleTaskLines,
} from './markdown-lists';

/**
 * Formatting for plain-textarea markdown editors, shared by every markdown textarea in the app
 * (Sidebar's transcript/summary editors, glossary term definitions, biography bio text). The same
 * actions are reachable from keyboard shortcuts (handleMarkdownKeyDown) and from the right-click
 * menu that appears over selected text (handleMarkdownContextMenu, drawn by
 * components/MarkdownContextMenu.tsx).
 */

export type MarkdownAction =
    | 'bold' | 'italic' | 'strikethrough' | 'highlight' | 'code' | 'link' | 'image'
    | 'linkToApp' | 'blockquote' | 'bulletList' | 'numberedList' | 'taskList' | 'table' | 'horizontalRule'
    | 'clearFormatting';

const patterns: Record<string, { prefix: string; suffix: string; detect?: RegExp; defaultText?: string }> = {
    bold: { prefix: '**', suffix: '**', detect: /^\*\*(.*)\*\*$/s },
    italic: { prefix: '*', suffix: '*', detect: /^\*(.*)\*$/s },
    strikethrough: { prefix: '~~', suffix: '~~', detect: /^~~(.*)~~$/s },
    highlight: { prefix: '==', suffix: '==', detect: /^==(.*)==$/s },
    code: { prefix: '`', suffix: '`', detect: /^`(.*)`$/s },
    link: { prefix: '[', suffix: '](https://example.com)', defaultText: 'URL Title' },
    image: { prefix: '![', suffix: '](https://i.imgur.com/7Cn5qJG.png)', defaultText: 'Image' },
};

/** Wraps the selection, or unwraps it when it is already wrapped. With nothing selected, a link or image
 *  is inserted with its template text selected (to type over); bold, italic and the rest are inserted
 *  as an empty pair with the caret between, ready to type. */
function wrapSelection(target: HTMLTextAreaElement, type: string) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const selectedText = target.value.substring(start, end);
    const { prefix, suffix, detect, defaultText } = patterns[type];
    const isLink = type === 'link' || type === 'image';

    let replacement: string;
    let newSelectionStart: number;
    let newSelectionEnd: number;

    const unwrapped = selectedText && detect ? selectedText.match(detect) : null;
    if (unwrapped) {
        // Unwrap: remove markdown
        replacement = unwrapped[1];
        newSelectionStart = start;
        newSelectionEnd = start + replacement.length;
    } else if (selectedText) {
        replacement = prefix + selectedText + suffix;
        if (isLink) {
            // The address is the template part: select it to type over. ("](" is 2 characters, ")" is 1.)
            newSelectionStart = start + prefix.length + selectedText.length + 2;
            newSelectionEnd = newSelectionStart + suffix.length - 3;
        } else {
            // Select the whole result, so the same shortcut takes the formatting off again.
            newSelectionStart = start;
            newSelectionEnd = start + replacement.length;
        }
    } else if (defaultText) {
        // Template text (a link's title, an image's alt text) is selected so typing replaces it.
        replacement = prefix + defaultText + suffix;
        newSelectionStart = start + prefix.length;
        newSelectionEnd = newSelectionStart + defaultText.length;
    } else {
        // An empty pair, with the caret between.
        replacement = prefix + suffix;
        newSelectionStart = newSelectionEnd = start + prefix.length;
    }

    target.focus();
    document.execCommand('insertText', false, replacement);
    setTimeout(() => {
        target.setSelectionRange(newSelectionStart, newSelectionEnd);
    }, 0);
}

/** Puts a prefix on every line the selection touches (optionally stripping an existing one first). */
function prependLines(target: HTMLTextAreaElement, getPrefix: (index: number) => string, stripPattern?: RegExp) {
    const value = target.value;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const beforeSelection = value.substring(0, start);
    const lineStart = beforeSelection.lastIndexOf('\n') + 1;
    const afterSelection = value.substring(end);
    const lineEndOffset = afterSelection.indexOf('\n');
    const lineEnd = lineEndOffset === -1 ? value.length : end + lineEndOffset;

    const linesToModify = value.substring(lineStart, lineEnd).split('\n');
    const modifiedLines = linesToModify.map((line, i) => {
        const prefix = getPrefix(i);
        if (stripPattern) {
            const stripped = line.replace(stripPattern, '');
            return prefix + stripped;
        }
        return prefix + line;
    });
    const modifiedText = modifiedLines.join('\n');

    // Replace the full line range with modified text
    target.focus();
    target.setSelectionRange(lineStart, lineEnd);
    document.execCommand('insertText', false, modifiedText);
    setTimeout(() => {
        if (start === end) {
            // Nothing was selected: the caret goes after what was added (typically right after a
            // ">" or "- " on a new line), not over the line.
            const caret = Math.max(lineStart, start + modifiedText.length - (lineEnd - lineStart));
            target.setSelectionRange(caret, caret);
        } else {
            target.setSelectionRange(lineStart, lineStart + modifiedText.length);
        }
    }, 0);
}

// ── Task lists, tables and rules ─────────────────────────────────────────────

/** Start and end (before the line break) of the line containing `pos`. */
function lineBounds(value: string, pos: number): { start: number; end: number } {
    const start = value.lastIndexOf('\n', pos - 1) + 1;
    const end = value.indexOf('\n', pos);
    return { start, end: end === -1 ? value.length : end };
}

/** Replaces text[from, to) with `text` the way typing would (keeping undo history), then puts the
 *  caret at `caret` when given. */
function replaceRange(target: HTMLTextAreaElement, from: number, to: number, text: string, caret?: number) {
    target.focus();
    target.setSelectionRange(from, to);
    document.execCommand('insertText', false, text);
    if (caret !== undefined) setTimeout(() => target.setSelectionRange(caret, caret), 0);
}

/** Ctrl+T: turns the selected lines into a task list, or back into plain lines. */
function toggleTaskList(target: HTMLTextAreaElement) {
    const value = target.value;
    const { start: selStart, end: selEnd } = { start: target.selectionStart, end: target.selectionEnd };
    const from = lineBounds(value, selStart).start;
    const to = lineBounds(value, selEnd).end;
    const oldLines = value.substring(from, to).split('\n');
    const newLines = toggleTaskLines(oldLines);
    const text = newLines.join('\n');
    if (text === oldLines.join('\n')) return;
    if (selStart === selEnd) {
        // A caret stays where it was in the text: it moves by however much the line changed.
        const caret = Math.max(from, selStart + text.length - (to - from));
        replaceRange(target, from, to, text, caret);
    } else {
        replaceRange(target, from, to, text);
        setTimeout(() => target.setSelectionRange(from, from + text.length), 0);
    }
}

/** Inserts a block (table or rule) after the selected lines with a blank line on each side. */
function insertBlock(target: HTMLTextAreaElement, block: string, select?: { start: number; length: number }) {
    const value = target.value;
    const lineEnd = lineBounds(value, target.selectionEnd).end;
    const { insert, blockStart } = blockInsertion(value, lineEnd, block);
    replaceRange(target, lineEnd, lineEnd, insert);
    const at = lineEnd + blockStart;
    setTimeout(() => {
        if (select) target.setSelectionRange(at + select.start, at + select.start + select.length);
        else target.setSelectionRange(at + block.length, at + block.length);
    }, 0);
}

/** A table: selected tab-separated text (copied from a spreadsheet) becomes one, otherwise an empty
 *  two-column table is added after the line. */
function insertTable(target: HTMLTextAreaElement) {
    const start = target.selectionStart;
    const converted = tableFromTabs(target.value.substring(start, target.selectionEnd));
    if (converted) {
        replaceRange(target, start, target.selectionEnd, converted);
        setTimeout(() => target.setSelectionRange(start, start + converted.length), 0);
        return;
    }
    insertBlock(target, TABLE_TEMPLATE, TABLE_FIRST_CELL);
}

/** The lines above `pos`, nearest last (a bounded number of them: nesting only looks a little way up). */
function linesAbove(value: string, pos: number, max = 80): string[] {
    if (pos === 0) return [];
    const lines = value.substring(0, pos - 1).split('\n');
    return lines.slice(-max);
}

/** Replaces the run of list lines around line `index` of `lines` (already changed) with its renumbered
 *  self, in `target`, and returns where that run's text starts. The lines are the whole document. */
function replaceListRun(target: HTMLTextAreaElement, before: string[], after: string[], index: number): { charStart: number; first: number; run: string[] } {
    const [first, last] = listBlock(after, index);
    const run = renumberOrdered(after.slice(first, last + 1));
    // The same run in the old text: the lines outside it are the same, so it ends the same distance from the end.
    const oldLast = before.length - (after.length - 1 - last) - 1;
    const charStart = before.slice(0, first).reduce((n, l) => n + l.length + 1, 0);
    const oldText = before.slice(first, oldLast + 1).join('\n');
    replaceRange(target, charStart, charStart + oldText.length, run.join('\n'));
    return { charStart, first, run };
}

/** Enter on a list item (bullet, number or task) starts the next one; on an empty one it ends the list
 *  (or moves it out a level). Numbers count up, and the numbers after a new item move up with it. */
function continueList(e: KeyboardEvent<HTMLTextAreaElement>) {
    const target = e.currentTarget;
    if (target.selectionStart !== target.selectionEnd) return;
    const caret = target.selectionStart;
    const { start, end } = lineBounds(target.value, caret);
    const line = target.value.substring(start, end);
    const result = enterOnList(line, caret - start);
    if (result.kind === 'none') return;
    e.preventDefault();
    if (result.kind === 'continue') {
        const item = parseListItem(line)!;
        // Spaces after the caret don't carry over to the start of the new item.
        const gap = /^[ \t]*/.exec(line.slice(caret - start))![0].length;
        if (item.number === null) {
            replaceRange(target, caret, caret + gap, result.insert);
            return;
        }
        // In a numbered list the items below are renumbered in the same edit.
        const before = target.value.split('\n');
        const index = target.value.substring(0, start).split('\n').length - 1;
        const inCaret = caret - start;
        const newItem = result.insert.slice(1) + line.slice(inCaret + gap);
        const after = [...before.slice(0, index), line.slice(0, inCaret), newItem, ...before.slice(index + 1)];
        const { charStart, first, run } = replaceListRun(target, before, after, index);
        const newLineStart = charStart + run.slice(0, index + 1 - first).reduce((n, l) => n + l.length + 1, 0);
        const markerLength = parseListItem(run[index + 1 - first])?.markerLength ?? 0;
        const at = newLineStart + markerLength;
        setTimeout(() => target.setSelectionRange(at, at), 0);
    } else if (result.kind === 'clear') replaceRange(target, start, end, '', start);
    else {
        const to = outdentTarget(linesAbove(target.value, start), line) ?? 0;
        const out = shiftLines([line], to - (parseListItem(line)?.indent.length ?? 0))[0];
        replaceRange(target, start, end, out, start + out.length);
    }
}

/** Ctrl+Enter on a task line ticks or unticks it. */
function toggleTaskDone(e: KeyboardEvent<HTMLTextAreaElement>) {
    const target = e.currentTarget;
    const caret = target.selectionStart;
    const { start, end } = lineBounds(target.value, caret);
    const line = target.value.substring(start, end);
    if (!parseTask(line)) return;
    e.preventDefault();
    replaceRange(target, start, end, toggleDone(line), caret);
}

/** Tab / Shift+Tab: nests a list item under the one above it, or moves it back out. Tab on a blank
 *  line under an item starts a nested one. Anywhere else the key keeps its normal job of moving focus. */
function indentLists(e: KeyboardEvent<HTMLTextAreaElement>) {
    const target = e.currentTarget;
    const value = target.value;
    const selStart = target.selectionStart;
    const selEnd = target.selectionEnd;
    const from = lineBounds(value, selStart).start;
    const to = lineBounds(value, selEnd).end;
    const lines = value.substring(from, to).split('\n');
    const above = linesAbove(value, from);
    const previous = above[above.length - 1];

    // A blank line right under a list item: Tab starts a nested item there.
    if (!e.shiftKey && lines.length === 1 && lines[0].trim() === '' && previous !== undefined) {
        const nested = nestedItemUnder(previous);
        if (nested) {
            e.preventDefault();
            replaceRange(target, from, to, nested, from + nested.length);
        }
        return;
    }

    const content = lines.filter(l => l.trim() !== '');
    if (content.length === 0 || !content.every(l => parseListItem(l))) return;
    e.preventDefault();
    const first = lines.find(l => l.trim() !== '')!;
    const current = parseListItem(first)!.indent.length;
    const wanted = e.shiftKey ? outdentTarget(above, first) : indentTarget(above.length ? previousContent(above) : undefined, first);
    if (wanted === null || wanted === current) return;

    // Every selected line moves by the same amount, so a nested block keeps its shape. In numbered
    // lists the numbers are then redone: an item moved in starts its own list at 1, and one moved out
    // carries on from the list it joins.
    const before = value.split('\n');
    const firstIndex = value.substring(0, from).split('\n').length - 1;
    const after = before.slice();
    after.splice(firstIndex, lines.length, ...shiftLines(lines, wanted - current));
    const { charStart, first: runFirst, run } = replaceListRun(target, before, after, firstIndex);
    const lineStartOf = (index: number) => charStart + run.slice(0, index - runFirst).reduce((n, l) => n + l.length + 1, 0);
    const newFirstStart = lineStartOf(firstIndex);
    if (selStart === selEnd) {
        const oldLen = lines[0].length;
        const newLen = run[firstIndex - runFirst].length;
        const caret = Math.max(newFirstStart, newFirstStart + (selStart - from) + (newLen - oldLen));
        setTimeout(() => target.setSelectionRange(caret, caret), 0);
    } else {
        const lastIndex = firstIndex + lines.length - 1;
        const newLastEnd = lineStartOf(lastIndex) + run[lastIndex - runFirst].length;
        setTimeout(() => target.setSelectionRange(newFirstStart, newLastEnd), 0);
    }
}

/** The nearest non-blank line of `above`. */
function previousContent(above: string[]): string | undefined {
    for (let i = above.length - 1; i >= 0; i--) if (above[i].trim() !== '') return above[i];
    return undefined;
}

const HEADING_PREFIX = /^#{1,6}\s+/;

/** The heading level (1-6) of the line the selection starts on, or 0 when it isn't a heading. */
export function headingLevelAt(target: HTMLTextAreaElement): number {
    const value = target.value;
    const lineStart = value.lastIndexOf('\n', target.selectionStart - 1) + 1;
    const lineEnd = value.indexOf('\n', lineStart);
    const line = value.substring(lineStart, lineEnd === -1 ? value.length : lineEnd);
    const match = /^(#{1,6})\s/.exec(line);
    return match ? match[1].length : 0;
}

/** Makes the selected lines a heading of `level`; choosing the level they already have removes the heading. */
export function applyHeading(target: HTMLTextAreaElement, level: number) {
    const remove = headingLevelAt(target) === level;
    prependLines(target, () => (remove ? '' : '#'.repeat(level) + ' '), HEADING_PREFIX);
}

/** Removes inline formatting (bold, italic, strikethrough, highlight, code, links) and each line's
 *  heading, quote or list marker from the selected text. */
function clearFormatting(target: HTMLTextAreaElement) {
    const start = target.selectionStart;
    const selected = target.value.substring(start, target.selectionEnd);
    if (!selected) return;
    const cleaned = stripMarkdownFormatting(selected);
    if (cleaned === selected) return;
    target.focus();
    document.execCommand('insertText', false, cleaned);
    setTimeout(() => target.setSelectionRange(start, start + cleaned.length), 0);
}

/** Runs a formatting action on the textarea's current selection. */
export function applyMarkdownAction(target: HTMLTextAreaElement, action: MarkdownAction) {
    switch (action) {
        case 'linkToApp':
            // The picker pane in App asks what to link to and writes the link back into this editor.
            requestLinkPicker({ textarea: target, start: target.selectionStart, end: target.selectionEnd });
            return;
        case 'blockquote':
            return prependLines(target, () => '> ');
        case 'bulletList':
            return prependLines(target, () => '- ');
        case 'numberedList':
            return prependLines(target, (i) => `${i + 1}. `);
        case 'taskList':
            return toggleTaskList(target);
        case 'table':
            return insertTable(target);
        case 'horizontalRule':
            return insertBlock(target, '---');
        case 'clearFormatting':
            return clearFormatting(target);
        default:
            return wrapSelection(target, action);
    }
}

// The value/setter arguments are no longer needed (the textarea itself is read), but callers still pass them.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const handleMarkdownKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, _value?: string, _setter?: (val: string) => void) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') return;

    const target = e.currentTarget;
    const run = (action: MarkdownAction) => {
        e.preventDefault();
        applyMarkdownAction(target, action);
    };

    // Lists (bullets, numbers, tasks): Enter carries on the list, Ctrl+Enter ticks a task, Tab / Shift+Tab nest and un-nest.
    // Not while an input method (composing text) is using these keys.
    if (!e.nativeEvent.isComposing) {
        if (e.key === 'Enter' && !e.altKey) {
            if (e.ctrlKey || e.metaKey) return toggleTaskDone(e);
            if (!e.shiftKey) return continueList(e);
        }
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return indentLists(e);
    }

    if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (!e.shiftKey && !e.altKey) {
            if (key === 'b') run('bold');
            else if (key === 'i') run('italic');
            else if (key === 'h') run('highlight');
            else if (key === 'e') run('code');
            else if (key === 't') run('taskList');
            else if (key === 'k') run('link');
            else if (key === 'l') run('image');
        } else if (e.shiftKey && !e.altKey) {
            if (key === 'x') run('strikethrough');
            else if (key === 'k') run('linkToApp');
            else if (key === 't') run('table');
            else if (key === 'h') run('horizontalRule');
            else if (key === 'l') run('bulletList');
            else if (e.code === 'Digit7' || e.key === '&') run('numberedList');
            else if (e.key === '.' || e.key === '>') run('blockquote');
        } else if (e.altKey && !e.shiftKey) {
            if (['1', '2', '3', '4', '5', '6'].includes(e.key)) {
                e.preventDefault();
                applyHeading(target, parseInt(e.key));
            }
        }
    }
};

// ── Right-click menu over selected text ──────────────────────────────────────

export const MARKDOWN_MENU_EVENT = 'kinesis:markdown-menu';

/** What the menu is opened over: selected text, or an empty line (where blocks like tables and rules can go). */
export type MarkdownMenuKind = 'selection' | 'blank';

export interface MarkdownMenuRequest {
    textarea: HTMLTextAreaElement;
    kind: MarkdownMenuKind;
    /** The selection when the menu was opened (empty for a blank line: the caret). */
    start: number;
    end: number;
    /** Where the menu opens, in viewport coordinates. */
    x: number;
    y: number;
}

/** Whether `text` is already wrapped in the markers of a wrapping action, so its menu button can show
 *  as on. Italic is checked so that **bold** doesn't also count as italic. */
export function selectionIsWrapped(text: string, action: MarkdownAction): boolean {
    if (action === 'italic') return /^\*[^*](.*[^*])?\*$/s.test(text) || /^\*\*\*.+\*\*\*$/s.test(text);
    if (action === 'bold') return /^\*\*.+\*\*$/s.test(text);
    const detect = patterns[action]?.detect;
    return !!detect && detect.test(text);
}

/** onContextMenu for a markdown textarea. The formatting menu (the single MarkdownContextMenu in
 *  App answers) opens over selected text and on an empty line. Anywhere else, and in read-only text,
 *  the browser's own menu (paste, spell check) is left alone so it isn't taken over for nothing. */
export const handleMarkdownContextMenu = (e: MouseEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    if (textarea.readOnly || textarea.disabled) return;
    const { selectionStart: start, selectionEnd: end } = textarea;
    let kind: MarkdownMenuKind;
    if (start !== end) {
        kind = 'selection';
    } else {
        const { start: lineStart, end: lineEnd } = lineBounds(textarea.value, start);
        if (textarea.value.substring(lineStart, lineEnd).trim() !== '') return;
        kind = 'blank';
    }
    e.preventDefault();
    window.dispatchEvent(new CustomEvent<MarkdownMenuRequest>(MARKDOWN_MENU_EVENT, {
        detail: { textarea, kind, start, end, x: e.clientX, y: e.clientY },
    }));
};
