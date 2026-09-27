import { useEffect, useLayoutEffect, useRef, useState, type ElementType, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { SnippetCard } from './GlossaryPreview';
import { inlineMarkdown } from '../lib/preview-markdown';

export interface ContextMenuItem {
    label: string;
    icon?: ElementType;
    onClick: () => void;
    disabled?: boolean;
    /** Drawn in red (deleting). */
    danger?: boolean;
    /** A line above this item, to set a group apart. */
    divider?: boolean;
    /** Quiet text at the right end (a shortcut). */
    hint?: string;
    /** While the pointer rests on the item, a card beside the menu shows what this returns (markdown; null for nothing). */
    peek?: { title: string; load: () => Promise<string | null> };
}

/**
 * A right-click menu at the pointer, in the same style as the workspace and window menus. It stays inside the window, and
 * closes on a choice, a click elsewhere, Esc, a scroll, a resize or the window losing focus. Esc is taken here (marked
 * handled) so it doesn't also close a dialog underneath.
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
    const box = useRef<HTMLDivElement>(null);
    const at = useMenuPlace(box, x, y);
    useMenuDismiss(box, onClose);
    // The card an item with `peek` shows beside the menu, after the pointer has rested on it a moment. It goes to the right of
    // the menu, or the left if the window cuts it off there.
    // The pointer can move onto the card (to copy from it): leaving an item or the card only closes it after a moment, and going
    // onto the item or the card in that time keeps it open.
    const [peek, setPeek] = useState<{ rect: DOMRect; title: string; markdown: string; full: string } | null>(null);
    const peekTimer = useRef(0);
    const leaveTimer = useRef(0);
    const peeking = useRef<ContextMenuItem | null>(null);
    useEffect(() => () => { window.clearTimeout(peekTimer.current); window.clearTimeout(leaveTimer.current); }, []);
    const keepPeek = () => window.clearTimeout(leaveTimer.current);
    const startPeek = (item: ContextMenuItem, el: HTMLElement) => {
        keepPeek();
        window.clearTimeout(peekTimer.current);
        peeking.current = item;
        if (!item.peek) { setPeek(null); return; }
        const { title, load } = item.peek;
        peekTimer.current = window.setTimeout(() => {
            load().then(text => {
                // The pointer may have moved to another item while it loaded.
                if (text && peeking.current === item && el.isConnected) setPeek({ rect: el.getBoundingClientRect(), title, markdown: inlineMarkdown(text.slice(0, 2500)), full: text });
            }).catch(() => {});
        }, 250);
    };
    const endPeekSoon = () => {
        keepPeek();
        leaveTimer.current = window.setTimeout(() => {
            window.clearTimeout(peekTimer.current);
            peeking.current = null;
            setPeek(null);
        }, 250);
    };

    return createPortal(
        <div
            ref={box}
            role="menu"
            style={at}
            // Above the video sidebar and dialogs, below the title bar's own menus and the tooltip.
            className="fixed z-[250] w-60 bg-[#272727] border border-[#3f3f3f] rounded-lg shadow-xl py-1 select-none"
            onContextMenu={(e) => e.preventDefault()}
            // A portal still passes clicks up to the React parent (here, the card it was opened from, which would open the video).
            onClick={(e) => e.stopPropagation()}
        >
            {items.map(item => (
                <button
                    key={item.label}
                    role="menuitem"
                    disabled={item.disabled}
                    onMouseEnter={(e) => startPeek(item, e.currentTarget)}
                    onMouseLeave={endPeekSoon}
                    onClick={(e) => { e.stopPropagation(); onClose(); item.onClick(); }}
                    className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 text-sm hover:bg-[#3f3f3f] disabled:text-gray-600 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default ${item.danger ? 'text-red-400' : 'text-gray-300'} ${item.divider ? 'border-t border-[#3f3f3f] mt-1 pt-2' : ''}`}
                >
                    {item.icon && <item.icon className="w-3.5 h-3.5 shrink-0" />}
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.hint && <span className="text-[11px] text-gray-500">{item.hint}</span>}
                </button>
            ))}
            {peek && <SnippetCard anchor={peek.rect} side="right" title={peek.title} markdown={peek.markdown} copyText={peek.full} onMouseEnter={keepPeek} onMouseLeave={endPeekSoon} />}
        </div>,
        document.body,
    );
}

/** Where a menu opened at the pointer goes: at the pointer, kept inside the window (measured once it is drawn), or
 *  above the pointer instead of below it when `above` and there isn't room beneath (a menu from the bottom bar). */
export function useMenuPlace(box: RefObject<HTMLElement | null>, x: number, y: number, above = false) {
    const [at, setAt] = useState({ left: x, top: y });
    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        // Placed again whenever the menu's size changes: one whose rows arrive after it opens (the Trash's) grows from
        // where it was put, and would otherwise run off the bottom of the window.
        const place = () => {
            const { offsetWidth: w, offsetHeight: h } = el;
            const flip = above && y + h + 6 > window.innerHeight;
            const next = {
                left: Math.max(6, Math.min(x, window.innerWidth - w - 6)),
                top: Math.max(6, Math.min(flip ? y - h : y, window.innerHeight - h - 6)),
            };
            setAt(prev => (prev.left === next.left && prev.top === next.top ? prev : next));
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(el);
        return () => observer.disconnect();
    }, [box, x, y, above]);
    return at;
}

/** Closes a menu on a click elsewhere (which does nothing else), Esc, a scroll, a resize or the window losing focus.
 *  Esc is taken here (marked handled) so it doesn't also close a dialog underneath. */
export function useMenuDismiss(box: RefObject<HTMLElement | null>, onClose: () => void) {
    useEffect(() => {
        // A click outside only closes the menu: what was under it (a card, a button) does not also get the click. The
        // press closes it, and the click that completes that press is swallowed on its way in.
        const away = (e: MouseEvent) => {
            // Inside the menu, or on a card it opened that can be clicked (marked data-keep-open, and drawn elsewhere on the page).
            if (box.current?.contains(e.target as Node) || (e.target as Element).closest?.('[data-keep-open]')) return;
            onClose();
            if (e.button !== 0) return;
            const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
            document.addEventListener('click', swallow, { capture: true, once: true });
            // If the press never completes as a click (dragged away), don't leave the trap set for the next real click.
            window.setTimeout(() => document.removeEventListener('click', swallow, true), 600);
        };
        const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
        document.addEventListener('mousedown', away, true);
        document.addEventListener('keydown', escape);
        document.addEventListener('scroll', onClose, true);
        window.addEventListener('resize', onClose);
        window.addEventListener('blur', onClose);
        return () => {
            document.removeEventListener('mousedown', away, true);
            document.removeEventListener('keydown', escape);
            document.removeEventListener('scroll', onClose, true);
            window.removeEventListener('resize', onClose);
            window.removeEventListener('blur', onClose);
        };
    }, [box, onClose]);
}
