import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small card floated next to an element, with an arrow pointing at it: the box the app's tooltips (TooltipLayer) and
 * its hover previews (GlossaryPreview) share, so they look and place alike. It goes on the side of the element that has
 * room (the asked-for one first, then the opposite, then the others), stays inside the window, and the arrow stays on
 * the element when the box has to slide over. Never takes the pointer: hovering the element goes on as if it weren't there.
 */

export type Side = 'top' | 'bottom' | 'left' | 'right';

/** Space between the element and the card's box, of which the arrow takes about 7 (the rest is air between its tip and the element). */
const GAP = 14;
const MARGIN = 6;
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

// The bridge across the GAP (14px), on the side of the card that faces the element.
const BRIDGE: Record<Side, string> = {
    bottom: 'left-0 right-0 bottom-full h-[14px]',
    top: 'left-0 right-0 top-full h-[14px]',
    right: 'top-0 bottom-0 right-full w-[14px]',
    left: 'top-0 bottom-0 left-full w-[14px]',
};

interface Placed {
    x: number;
    y: number;
    side: Side;
    /** Where the arrow sits along the edge facing the element (px from the box's start). */
    arrow: number;
}

/** Where the box goes: the first side that has room (the asked-for one first), kept inside the window. */
function place(target: DOMRect, size: { w: number; h: number }, want: Side | 'auto'): Placed {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const room: Record<Side, boolean> = {
        bottom: target.bottom + GAP + size.h <= vh - MARGIN,
        top: target.top - GAP - size.h >= MARGIN,
        right: target.right + GAP + size.w <= vw - MARGIN,
        left: target.left - GAP - size.w >= MARGIN,
    };
    const order: Side[] = want === 'auto'
        ? ['bottom', 'top', 'right', 'left']
        : [want, OPPOSITE[want], ...(['bottom', 'top', 'right', 'left'] as Side[]).filter(s => s !== want && s !== OPPOSITE[want])];
    const side = order.find(s => room[s]) ?? order[0];
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    const cx = target.left + target.width / 2;
    const cy = target.top + target.height / 2;
    if (side === 'top' || side === 'bottom') {
        const x = clamp(cx - size.w / 2, MARGIN, vw - size.w - MARGIN);
        const y = side === 'bottom' ? target.bottom + GAP : target.top - GAP - size.h;
        return { x, y, side, arrow: clamp(cx - x, 12, size.w - 12) };
    }
    const y = clamp(cy - size.h / 2, MARGIN, vh - size.h - MARGIN);
    const x = side === 'right' ? target.right + GAP : target.left - GAP - size.w;
    return { x, y, side, arrow: clamp(cy - y, 10, size.h - 10) };
}

interface Props {
    /** The element's rectangle in the window. */
    anchor: DOMRect;
    side?: Side | 'auto';
    /** ARIA role of the box. */
    role?: string;
    /** The pointer can go onto the card (it is otherwise transparent to it). It then also bridges the gap between itself and the
     *  element, so crossing that gap doesn't count as leaving; and a menu that opened it counts a click on it as inside. */
    interactive?: boolean;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    /** Sizing and text styling for the content (the box itself, its border and the arrow are set here). */
    className?: string;
    /** Above ordinary content and dialogs (default, see the comment below). A caller that must win over everything —
     *  tooltips, which should never be covered by anything they're explaining — passes a higher one. Set inline, not
     *  via a `z-[...]` class, so it reliably beats whatever the className below adds. */
    zIndex?: number;
    children: ReactNode;
}

export function FloatingCard({ anchor, side: want = 'auto', role = 'tooltip', interactive = false, onMouseEnter, onMouseLeave, className = '', zIndex = 90, children }: Props) {
    const box = useRef<HTMLDivElement>(null);
    const [placed, setPlaced] = useState<Placed | null>(null);

    // The box is measured (out of sight) before it is placed, since where it goes depends on how big it is. Run after
    // every render, but only a different answer is kept, so it settles at once.
    useLayoutEffect(() => {
        if (!box.current) return;
        const next = place(anchor, { w: box.current.offsetWidth, h: box.current.offsetHeight }, want);
        setPlaced(prev => (prev && prev.x === next.x && prev.y === next.y && prev.side === next.side && prev.arrow === next.arrow ? prev : next));
    });

    const side = placed?.side ?? 'bottom';
    // The arrow: a square turned 45 degrees, half of it over the box, on the edge that faces the element. Only the two
    // sides of it that point out have a border, so it carries the box's outline (same color as a dialog's) into a point.
    // (The offsets count the box's 2px border: the arrow is placed from inside it, with its middle on the box's outer edge.)
    const arrowStyle: React.CSSProperties = side === 'top' || side === 'bottom'
        ? { left: (placed?.arrow ?? 12) - 7, [side === 'bottom' ? 'top' : 'bottom']: -7 }
        : { top: (placed?.arrow ?? 10) - 7, [side === 'right' ? 'left' : 'right']: -7 };
    const arrowBorder = { bottom: 'border-t-2 border-l-2', top: 'border-b-2 border-r-2', right: 'border-b-2 border-l-2', left: 'border-t-2 border-r-2' }[side];

    return createPortal(
        <div
            ref={box}
            role={role}
            // Default z-index (90): above ordinary page content, but below a dialog (z-100/200) — opening one (an
            // "Open" button on the card itself, say) must cover the card, not sit under it. The title bar (z-300) and
            // the menus that open from it (z-250-320) stay above it too by default. A caller can ask for higher (see
            // `zIndex` above) to win over all of that instead.
            style={{ left: placed?.x ?? 0, top: placed?.y ?? 0, zIndex, visibility: placed ? 'visible' : 'hidden' }}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            {...(interactive ? { 'data-keep-open': '' } : {})}
            className={`fixed ${interactive ? 'pointer-events-auto' : 'pointer-events-none'} rounded-lg bg-[#272727] border-2 border-[#303030] shadow-2xl select-none ${className}`}
        >
            {/* The strip across the gap to the element, so the pointer stays on the card on its way over. */}
            {interactive && <span aria-hidden className={`absolute ${BRIDGE[side]}`} />}
            <span aria-hidden style={arrowStyle} className={`absolute w-2.5 h-2.5 rotate-45 bg-[#272727] border-[#303030] ${arrowBorder}`} />
            {/* Above the arrow's half that is inside the box. */}
            <div className="relative">{children}</div>
        </div>,
        document.body,
    );
}
