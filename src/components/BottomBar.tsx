import { useEffect, type ReactNode } from 'react';

/** The fixed footer strip shared by every view — Glossary/Biography's A-Z jump nav
 *  (AlphabetJumpNav.tsx) and Search/Library's title/sort/filter bar (VideoList.tsx) both render
 *  their own content inside this shell rather than each owning their own fixed positioning, so
 *  the height/z-index/rail-clearance math lives in exactly one place. Below the vertical nav
 *  rail's own z-40 so the rail (opaque, same background) draws over the portion of this bar that
 *  would otherwise sit underneath it; `--k-rail-width` (set once in App.tsx from
 *  navigationOrientation) pads the content clear of that same region directly, so it doesn't
 *  start partly hidden behind it.
 *
 *  Publishes its own fixed h-6 height into `--k-bottom-bar-height` while mounted — App.tsx's
 *  scroll-to-top/Summarize-all buttons and its root scroll padding read that to stay clear of
 *  whichever bar is currently showing — and resets it to 0 on unmount, so switching to a view
 *  with no bar (there always is one, currently, but this stays correct even if that changes)
 *  doesn't leave those consumers permanently offset by a bar that's no longer there. */
export function BottomBar({ children }: { children: ReactNode }) {
    useEffect(() => {
        document.documentElement.style.setProperty('--k-bottom-bar-height', '1.5rem');
        return () => { document.documentElement.style.setProperty('--k-bottom-bar-height', '0px'); };
    }, []);

    return (
        <div
            // No horizontal scrollbar, ever: content that doesn't fit truncates (each child that
            // can afford to give up space needs its own min-w-0 + truncate — see VideoList.tsx's
            // driveChip/title for the actual truncating pieces; sort/filter stay shrink-0 since
            // clipping an interactive button instead of a text label would be worse). `@container`
            // lets descendants (VideoList.tsx's button labels) key off THIS bar's own rendered
            // width via `@`-prefixed variants, rather than the viewport's — the viewport can be
            // wide while the bar itself has little room left (nav rail + an open Drive panel
            // already spoken for), which is exactly the gap that let buttons get clipped before
            // ever shrinking to icon-only.
            className="@container fixed inset-x-0 bottom-0 z-30 h-6 flex items-center overflow-hidden bg-[#0f0f0f] border-t border-[#272727] pr-4"
            style={{ paddingLeft: 'calc(var(--k-rail-width, 0px) + 1rem)' }}
        >
            {children}
        </div>
    );
}
