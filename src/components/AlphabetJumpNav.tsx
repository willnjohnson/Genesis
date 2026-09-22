import { useEffect, useRef, useState } from 'react';

/** A true bottom panel of clickable letters — fixed to the viewport, not part of the page's own
 *  scroll, so it's always there regardless of scroll position (same idea, and the same h-6 strip
 *  look, as WorkspaceSwitcher's "rail" variant at the bottom of the vertical nav rail). Below the
 *  rail's own z-40 so the rail (opaque, same background) draws over the portion of this bar that
 *  would otherwise sit underneath it; `--k-rail-width` (set once in App.tsx from
 *  navigationOrientation) pads the letters clear of that same region directly, so they don't start
 *  partly hidden behind it. Only shows letters that actually have something filed under them
 *  (`available`, already sorted — both callers already compute this for their own section headers)
 *  rather than the full alphabet with gaps for the rest, which read as broken/sparse more than it
 *  read as a real index. Always renders, even with nothing to jump to (e.g. a drive filter with no
 *  terms) — just the label and an empty row — rather than popping in and out and shifting the
 *  reserved space (see pb-10 in GlossaryView/BiographyView) under it as a filter changes.
 *  `idPrefix` must match whatever prefixes the group headings' own `id`s (kept per-view so two of
 *  these never collide, even though only one view is ever mounted at once). The letter for whatever
 *  section is currently at the top of the (window-level) scroll is underlined, updated as the user
 *  scrolls past each section's heading — not just right after a jump-to click. */
export function AlphabetJumpNav({ idPrefix, available }: { idPrefix: string; available: string[] }) {
    const [active, setActive] = useState<string | null>(null);
    // A click's own intent wins over the geometric scan for a moment afterward: a short trailing
    // section (little or no content below it but the reserved bottom padding) can't be scrolled
    // any further than the page's max scroll allows, so its heading may never reach the
    // measurement line the scan below uses — without this, clicking it (or a similarly-short
    // letter right before it, which lands at that same clamped scroll position) could leave an
    // earlier letter underlined, or worse, always jump straight to the last one regardless of
    // which was actually clicked. Cleared on the next genuine (non-jump) scroll.
    const pinnedUntil = useRef(0);

    useEffect(() => {
        if (available.length === 0) {
            setActive(null);
            return;
        }
        // The active section is the last heading (in document order, which `available` already
        // matches) whose top has scrolled up to or past this line — i.e. whichever section's
        // content actually occupies the top of the screen right now.
        const LINE = 100;
        let queued = false;
        const update = () => {
            queued = false;
            if (performance.now() < pinnedUntil.current) return;
            let current = available[0];
            for (const char of available) {
                const el = document.getElementById(`${idPrefix}-${char}`);
                if (el && el.getBoundingClientRect().top <= LINE) current = char;
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
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        return () => {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
        };
    }, [idPrefix, available]);

    const jumpTo = (char: string) => {
        setActive(char);
        // scrollIntoView below is instant (behavior: 'auto'), not animated, but still fires
        // scroll/resize events the effect above would otherwise immediately act on — pin briefly
        // so this explicit click, not a geometric guess, decides who's underlined right after it.
        pinnedUntil.current = performance.now() + 400;
        // The first letter is a true back-to-top: scrollIntoView on its own heading would still
        // leave the title/search bar above it scrolled past, since that content sits above the
        // first section rather than above the whole page.
        if (char === available[0]) {
            window.scrollTo({ top: 0, behavior: 'auto' });
            return;
        }
        document.getElementById(`${idPrefix}-${char}`)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    };

    return (
        <div
            className="fixed inset-x-0 bottom-0 z-30 h-6 flex items-center bg-[#0f0f0f] border-t border-[#272727] pr-4"
            style={{ paddingLeft: 'calc(var(--k-rail-width, 0px) + 1rem)' }}
        >
            <span className="shrink-0 whitespace-nowrap text-[11px] uppercase tracking-wider text-gray-500 mr-2">Jump to:</span>
            <div className="flex flex-wrap items-center">
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
        </div>
    );
}
