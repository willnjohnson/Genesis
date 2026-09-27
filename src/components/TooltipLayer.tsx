import { useEffect, useState } from 'react';
import { FloatingCard, type Side } from './FloatingCard';

/**
 * The app's one tooltip, standing in for the system's (which is slow, plain and looks different on every platform).
 * Nothing needs to opt in: any element with a `title` attribute gets it. While the pointer is over such an element its
 * `title` is set aside (so the system's never shows) and put back when the pointer leaves.
 *
 * It opens below the element, or above, to the right or to the left if there is no room there, with a small arrow
 * pointing at the element; an element can ask for a side with `data-tooltip-side="top|bottom|left|right"` (still
 * flipped if it doesn't fit). It is kept inside the window, the arrow staying on the element. It opens after a short wait,
 * at once in the title bar, and closes on a click, a key, a scroll, or when the element goes away.
 *
 * Mounted once (main.tsx), so every window that has it (the app, the tray popup) gets the same tooltips.
 */

const DELAY_MS = 400;

interface Shown {
    text: string;
    rect: DOMRect;
    side: Side | 'auto';
}

const SET_ASIDE = 'data-tooltip-text';

export function TooltipLayer() {
    const [shown, setShown] = useState<Shown | null>(null);

    useEffect(() => {
        let current: Element | null = null;
        let timer = 0;
        let watcher = 0;

        // The title goes back on the element, so it is what it was (and reads to assistive tools) when not hovered.
        const restore = (el: Element | null) => {
            const text = el?.getAttribute(SET_ASIDE);
            if (el && text !== null && text !== undefined) {
                if (!el.hasAttribute('title')) el.setAttribute('title', text);
                el.removeAttribute(SET_ASIDE);
            }
        };
        const close = () => {
            window.clearTimeout(timer);
            window.clearInterval(watcher);
            setShown(null);
        };
        const leave = () => {
            close();
            restore(current);
            current = null;
        };

        const onOver = (e: PointerEvent) => {
            if (e.pointerType === 'touch') return;
            const target = e.target as Element | null;
            const el = target?.closest?.(`[title],[${SET_ASIDE}]`) ?? null;
            if (el === current) return;
            leave();
            if (!el) return;
            const title = el.getAttribute('title');
            if (title !== null) {
                el.setAttribute(SET_ASIDE, title);
                el.removeAttribute('title');
            }
            const text = el.getAttribute(SET_ASIDE) ?? '';
            current = el;
            if (!text.trim()) return;
            const open = () => {
                if (!current?.isConnected) return;
                const asked = current.closest('[data-tooltip-side]')?.getAttribute('data-tooltip-side');
                const side = asked === 'top' || asked === 'bottom' || asked === 'left' || asked === 'right' ? asked : 'auto';
                setShown({ text, rect: current.getBoundingClientRect(), side });
                // The element can go away under a still pointer (a re-render): no mouseout comes then.
                watcher = window.setInterval(() => {
                    if (!current?.isConnected) { leave(); return; }
                    // A re-render can put a (new) title back on the element while it is hovered: take it over again.
                    const changed = current.getAttribute('title');
                    if (changed !== null) {
                        current.setAttribute(SET_ASIDE, changed);
                        current.removeAttribute('title');
                        setShown(s => (s && s.text !== changed ? { ...s, text: changed } : s));
                    }
                }, 250);
            };
            // At once in the title bar (its buttons are icons, and the point of the tooltip is to name them), after a
            // short wait elsewhere.
            if (el.closest('[data-app-titlebar]')) open();
            else timer = window.setTimeout(open, DELAY_MS);
        };
        const onOut = (e: PointerEvent) => {
            if (!current) return;
            const to = e.relatedTarget as Node | null;
            if (to && current.contains(to)) return;
            leave();
        };
        // A click, a key, a scroll or the window losing focus ends it, and it stays away until the pointer comes back.
        const onEnd = () => { close(); };

        document.addEventListener('pointerover', onOver, true);
        document.addEventListener('pointerout', onOut, true);
        document.addEventListener('pointerdown', onEnd, true);
        document.addEventListener('keydown', onEnd, true);
        document.addEventListener('wheel', onEnd, { capture: true, passive: true });
        document.addEventListener('scroll', onEnd, true);
        window.addEventListener('blur', onEnd);
        return () => {
            document.removeEventListener('pointerover', onOver, true);
            document.removeEventListener('pointerout', onOut, true);
            document.removeEventListener('pointerdown', onEnd, true);
            document.removeEventListener('keydown', onEnd, true);
            document.removeEventListener('wheel', onEnd, true);
            document.removeEventListener('scroll', onEnd, true);
            window.removeEventListener('blur', onEnd);
            leave();
        };
    }, []);

    if (!shown) return null;
    return (
        <FloatingCard
            anchor={shown.rect}
            side={shown.side}
            // Highest of anything in the app: a tooltip is explaining whatever's under the pointer, so nothing —
            // dialog, menu, title bar, plugin popover — should ever be able to sit on top of it and hide it.
            zIndex={2147483647}
            className="w-max max-w-[min(34rem,calc(100vw-1rem))] [overflow-wrap:anywhere] px-3 py-1.5 text-sm font-normal leading-snug text-white whitespace-pre-line"
        >
            {shown.text}
        </FloatingCard>
    );
}
