import { useEffect, useRef, useState, type RefObject } from 'react';
import { BottomBar } from './BottomBar';

/** A true bottom panel of clickable letters — fixed to the viewport, not part of the content
 *  pane's own scroll, so it's always there regardless of scroll position (same idea, and the same
 *  h-6 strip look, as WorkspaceSwitcher's "rail" variant at the bottom of the vertical nav rail).
 *  Renders its content inside the shared BottomBar shell (also used by VideoList.tsx's Search/
 *  Library bar) rather than owning its own fixed positioning. Only shows letters that actually
 *  have something filed under them
 *  (`available`, already sorted — both callers already compute this for their own section headers)
 *  rather than the full alphabet with gaps for the rest, which read as broken/sparse more than it
 *  read as a real index. Always renders, even with nothing to jump to (e.g. a drive filter with no
 *  terms) — just the label and an empty row — rather than popping in and out and shifting the
 *  reserved space (see pb-10 in GlossaryView/BiographyView) under it as a filter changes.
 *  `idPrefix` must match whatever prefixes the group headings' own `id`s (kept per-view so two of
 *  these never collide, even though only one view is ever mounted at once). `scrollContainerRef`
 *  is App.tsx's one scrollable content pane — the letter for whatever section is currently at the
 *  top of ITS scroll (not the window's — the whole page no longer scrolls) is underlined, updated
 *  as the user scrolls past each section's heading, not just right after a jump-to click. */
export function AlphabetJumpNav({ idPrefix, available, scrollContainerRef }: { idPrefix: string; available: string[]; scrollContainerRef: RefObject<HTMLDivElement | null> }) {
    const [active, setActive] = useState<string | null>(null);
    // A click's own intent wins over the geometric scan for a moment afterward: a short trailing
    // section (little or no content below it but the reserved bottom padding) can't be scrolled
    // any further than the pane's max scroll allows, so its heading may never reach the
    // measurement line the scan below uses — without this, clicking it (or a similarly-short
    // letter right before it, which lands at that same clamped scroll position) could leave an
    // earlier letter underlined, or worse, always jump straight to the last one regardless of
    // which was actually clicked. Cleared on the next genuine (non-jump) scroll.
    const pinnedUntil = useRef(0);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (available.length === 0 || !container) {
            setActive(null);
            return;
        }
        // The active section is the last heading (in document order, which `available` already
        // matches) whose top has scrolled up to or past this line, measured from the pane's own
        // top edge (not the viewport's — with the header no longer scrolling away, the pane can
        // start anywhere on screen depending on nav orientation) — i.e. whichever section's
        // content actually occupies the top of the pane right now.
        const LINE = 100;
        let queued = false;
        const update = () => {
            queued = false;
            if (performance.now() < pinnedUntil.current) return;
            const containerTop = container.getBoundingClientRect().top;
            let current = available[0];
            for (const char of available) {
                const el = document.getElementById(`${idPrefix}-${char}`);
                if (el && el.getBoundingClientRect().top - containerTop <= LINE) current = char;
                else break;
            }
            setActive(current);
        };
        const onScroll = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(update);
        };
        update();
        container.addEventListener('scroll', onScroll, { passive: true });
        // Layout reflow (column count, row heights) is viewport-width-driven, not pane-width-driven
        // — see VideoList.tsx's useColumnCount — so this stays on window.
        window.addEventListener('resize', onScroll);
        return () => {
            container.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
        };
    }, [idPrefix, available, scrollContainerRef]);

    const jumpTo = (char: string) => {
        setActive(char);
        // scrollIntoView below is instant (behavior: 'auto'), not animated, but still fires
        // scroll/resize events the effect above would otherwise immediately act on — pin briefly
        // so this explicit click, not a geometric guess, decides who's underlined right after it.
        pinnedUntil.current = performance.now() + 400;
        // The first letter is a true back-to-top.
        if (char === available[0]) {
            scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
            return;
        }
        // Scrolls whatever the nearest actual scrolling ancestor is — the content pane, now that
        // the heading lives inside it — so this needs no change for the container-scroll switch.
        document.getElementById(`${idPrefix}-${char}`)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    };

    return (
        <BottomBar>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-gray-500 mr-2">Jump to:</span>
            {/* No flex-wrap: BottomBar's fixed h-6 + overflow-hidden would clip a wrapped second
                row entirely rather than showing it, which is worse than the (rare — this is
                bounded by the alphabet) case of the row itself running out of room. */}
            <div className="flex items-center overflow-hidden">
                {available.map(char => (
                    <button
                        key={char}
                        type="button"
                        onClick={() => jumpTo(char)}
                        className={`px-1.5 py-0.5 text-[11px] transition-colors cursor-pointer ${
                            char === active ? 'text-white underline underline-offset-2' : 'text-gray-400 hover:text-white hover:bg-[#272727]'
                        }`}
                    >
                        {char}
                    </button>
                ))}
            </div>
        </BottomBar>
    );
}
