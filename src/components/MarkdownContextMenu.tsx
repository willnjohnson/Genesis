import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ElementType } from 'react';
import {
    Bold, ClipboardPaste, Code, Copy, Highlighter, Image as ImageIcon, Italic, Link, Link2, List, ListChecks,
    ListOrdered, Minus, Quote, RemoveFormatting, Scissors, Strikethrough, Table,
} from 'lucide-react';
import {
    applyHeading, applyMarkdownAction, headingLevelAt, MARKDOWN_MENU_EVENT, selectionIsWrapped,
    type MarkdownAction, type MarkdownMenuRequest,
} from '../lib/markdown-editor';
import { stripMarkdownFormatting } from '../lib/markdown-format';

const mod = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';
const shift = mod === '⌘' ? '⇧' : 'Shift+';
const alt = mod === '⌘' ? '⌥' : 'Alt+';

// The inline formats sit in one row of icons (like a small toolbar), the heading levels in another.
const INLINE: { action: MarkdownAction; label: string; hint: string; Icon: ElementType }[] = [
    { action: 'bold', label: 'Bold', hint: `${mod}B`, Icon: Bold },
    { action: 'italic', label: 'Italic', hint: `${mod}I`, Icon: Italic },
    { action: 'strikethrough', label: 'Strikethrough', hint: `${mod}${shift}X`, Icon: Strikethrough },
    { action: 'highlight', label: 'Highlight', hint: `${mod}H`, Icon: Highlighter },
    { action: 'code', label: 'Code', hint: `${mod}E`, Icon: Code },
];
const HEADINGS = [1, 2, 3, 4, 5, 6];

type Row = { label: string; hint: string; Icon: ElementType; run: (t: HTMLTextAreaElement) => void };
const act = (label: string, hint: string, Icon: ElementType, action: MarkdownAction): Row => ({
    label, hint, Icon, run: (t) => applyMarkdownAction(t, action),
});

const LINK = act('Link', `${mod}K`, Link, 'link');
const LINK_TO = act('Link to...', `${mod}${shift}K`, Link2, 'linkToApp');
const IMAGE = act('Image', `${mod}L`, ImageIcon, 'image');
const QUOTE = act('Quote', `${mod}${shift}.`, Quote, 'blockquote');
const BULLETS = act('Bulleted list', `${mod}${shift}L`, List, 'bulletList');
const NUMBERS = act('Numbered list', `${mod}${shift}7`, ListOrdered, 'numberedList');
const TASKS = act('Task list', `${mod}T`, ListChecks, 'taskList');
const TABLE = act('Table', `${mod}${shift}T`, Table, 'table');
const RULE = act('Horizontal rule', `${mod}${shift}H`, Minus, 'horizontalRule');
const CLEAR = act('Clear formatting', '', RemoveFormatting, 'clearFormatting');
const CUT: Row = { label: 'Cut', hint: `${mod}X`, Icon: Scissors, run: () => { document.execCommand('cut'); } };
const COPY: Row = { label: 'Copy', hint: `${mod}C`, Icon: Copy, run: () => { document.execCommand('copy'); } };
// Reads the clipboard the way the page is allowed to; if the webview refuses, nothing is pasted (Ctrl+V still works).
const PASTE: Row = {
    label: 'Paste', hint: `${mod}V`, Icon: ClipboardPaste,
    run: (t) => {
        navigator.clipboard?.readText()
            .then(text => { if (text) { t.focus(); document.execCommand('insertText', false, text); } })
            .catch(() => { /* not allowed here */ });
    },
};

/** What the menu offers depends on what it was opened over, so it only lists things that make sense there:
 *   - Over selected text: formatting for that text. Blocks that stand on their own line (table, rule) aren't
 *     offered, "Clear formatting" only when the text has formatting to clear, and Cut/Copy/Paste at the end.
 *   - On an empty line: what can start a line (headings, lists, quote, table, rule, image, links) and Paste.
 *     There is no text to bold, so no inline formats. */
function layoutFor(request: MarkdownMenuRequest): { inline: boolean; groups: Row[][] } {
    if (request.kind === 'blank') {
        return {
            inline: false,
            groups: [
                [QUOTE, BULLETS, NUMBERS, TASKS],
                [TABLE, RULE],
                [LINK, LINK_TO, IMAGE],
                [PASTE],
            ],
        };
    }
    const selected = request.textarea.value.substring(request.start, request.end);
    return {
        inline: true,
        groups: [
            [LINK, LINK_TO, IMAGE],
            [QUOTE, BULLETS, NUMBERS, TASKS],
            ...(stripMarkdownFormatting(selected) !== selected ? [[CLEAR]] : []),
            [CUT, COPY, PASTE],
        ],
    };
}

const MENU_WIDTH = 232;
const EDGE = 8;

/**
 * The right-click menu in a markdown editor, over selected text or an empty line (see layoutFor for
 * what each offers). Mounted once in App; editors only ask for it (handleMarkdownContextMenu in
 * lib/markdown-editor.ts).
 */
export function MarkdownContextMenu() {
    const [request, setRequest] = useState<MarkdownMenuRequest | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onRequest = (e: Event) => setRequest((e as CustomEvent<MarkdownMenuRequest>).detail);
        window.addEventListener(MARKDOWN_MENU_EVENT, onRequest);
        return () => window.removeEventListener(MARKDOWN_MENU_EVENT, onRequest);
    }, []);

    useEffect(() => {
        if (!request) return;
        const close = () => setRequest(null);
        const onMouseDown = (e: globalThis.MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) close();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        window.addEventListener('scroll', close, true);
        return () => {
            document.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', close);
            window.removeEventListener('blur', close);
            window.removeEventListener('scroll', close, true);
        };
    }, [request]);

    // Keeps the whole menu on screen. It is measured once drawn (before the browser paints), so the
    // size never has to be guessed: near the bottom it opens upwards from the pointer, near the right
    // edge it opens leftwards, and if the window is too short it scrolls.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!request || !el) return;
        const { width, height } = el.getBoundingClientRect();
        let left = request.x;
        let top = request.y;
        if (left + width > window.innerWidth - EDGE) left = window.innerWidth - width - EDGE;
        if (top + height > window.innerHeight - EDGE) {
            top = request.y - height >= EDGE ? request.y - height : window.innerHeight - height - EDGE;
        }
        el.style.left = `${Math.max(EDGE, left)}px`;
        el.style.top = `${Math.max(EDGE, top)}px`;
    }, [request]);

    if (!request) return null;

    const { inline, groups } = layoutFor(request);
    const selected = request.textarea.value.substring(request.start, request.end);
    // Which heading (if any) the line is already, so choosing it again can remove it.
    const currentHeading = headingLevelAt(request.textarea);

    const run = (fn: (t: HTMLTextAreaElement) => void) => {
        const { textarea, start, end } = request;
        setRequest(null);
        // The click took focus off the editor; put the selection back so the action applies to it.
        textarea.focus();
        textarea.setSelectionRange(start, end);
        fn(textarea);
    };

    const toggleClass = (on: boolean) =>
        on ? 'bg-red-600 text-white' : 'text-[#cccccc] hover:bg-[#272727] hover:text-white';

    return (
        <div
            ref={ref}
            style={{ left: request.x, top: request.y, width: MENU_WIDTH, maxHeight: `calc(100vh - ${EDGE * 2}px)` }}
            // Keep the editor focused while the menu is used.
            onMouseDown={(e) => e.preventDefault()}
            onContextMenu={(e) => e.preventDefault()}
            className="fixed z-[300] overflow-y-auto bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-1 animate-in fade-in duration-100"
        >
            {inline && (
                <div className="flex gap-0.5">
                    {INLINE.map(({ action, label, hint, Icon }) => {
                        const on = selectionIsWrapped(selected, action);
                        return (
                            <button
                                key={action}
                                onClick={() => run((t) => applyMarkdownAction(t, action))}
                                title={`${label} (${hint})`}
                                aria-label={label}
                                aria-pressed={on}
                                className={`flex-1 h-8 flex items-center justify-center rounded-lg transition-colors cursor-pointer ${toggleClass(on)}`}
                            >
                                <Icon className="w-4 h-4" />
                            </button>
                        );
                    })}
                </div>
            )}
            <div className={`flex gap-0.5 ${inline ? 'mt-0.5' : ''}`}>
                {HEADINGS.map(level => (
                    <button
                        key={level}
                        onClick={() => run((t) => applyHeading(t, level))}
                        title={`Heading ${level} (${alt}${level})`}
                        aria-label={`Heading ${level}`}
                        aria-pressed={currentHeading === level}
                        className={`flex-1 h-8 rounded-lg text-[11px] font-bold transition-colors cursor-pointer ${toggleClass(currentHeading === level)}`}
                    >
                        H{level}
                    </button>
                ))}
            </div>
            {groups.map((group, g) => (
                <div key={g}>
                    <div className="my-1 h-px bg-[#2a2a2a]" />
                    {group.map(row => (
                        <button
                            key={row.label}
                            onClick={() => run(row.run)}
                            className="w-full flex items-center gap-2.5 px-3 h-8 rounded-lg text-xs text-gray-200 hover:bg-[#272727] transition-colors cursor-pointer"
                        >
                            <row.Icon className="w-3.5 h-3.5 text-[#aaaaaa] shrink-0" />
                            <span className="flex-1 text-left">{row.label}</span>
                            <span className="text-[10px] text-[#666666]">{row.hint}</span>
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
}
