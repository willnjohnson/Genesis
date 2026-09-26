import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const MAX_ENTRIES = 50;
/** The app settles into its starting place (the default section, say) just after launch; that isn't a visit. */
const SETTLE_MS = 2000;

/**
 * Back and forward through the places the user has been, like a browser's history for an app that has no URLs.
 *
 * `current` describes where the user is now (the section, the Drive, the video in the sidebar, the search text in
 * each section). `keyOf` says what makes it a different PLACE: when the key changes, a new entry is added (and
 * anything ahead of the current one is dropped, as in a browser); when only the rest changes (typing in a search
 * box) the current entry is updated in place, so going back doesn't step through keystrokes. `restore` puts the
 * app back at an entry. Restoring is not itself recorded as a new place.
 */
export function useNavHistory<L>(current: L, keyOf: (place: L) => string, restore: (place: L) => void) {
    const entries = useRef<L[]>([]);
    const index = useRef(-1);
    // Set while a restore is under way: the next render is the app arriving at that entry, not the user going somewhere.
    const restoring = useRef<number | null>(null);
    const startedAt = useRef(Date.now());
    const restoreRef = useRef(restore);
    restoreRef.current = restore;
    const [can, setCan] = useState({ back: false, forward: false });
    const publish = () => setCan({ back: index.current > 0, forward: index.current < entries.current.length - 1 });

    // After every render (synchronously, before it is drawn): is this a new place?
    useLayoutEffect(() => {
        if (restoring.current !== null) {
            window.clearTimeout(restoring.current);
            restoring.current = null;
            entries.current[index.current] = current;
            return;
        }
        const here = entries.current[index.current];
        if (here !== undefined && keyOf(here) === keyOf(current)) {
            entries.current[index.current] = current;
            return;
        }
        if (entries.current.length === 1 && Date.now() - startedAt.current < SETTLE_MS) {
            entries.current = [current];
            return;
        }
        entries.current = [...entries.current.slice(0, index.current + 1), current].slice(-MAX_ENTRIES);
        index.current = entries.current.length - 1;
        publish();
    });

    const go = useCallback((delta: number) => {
        const next = index.current + delta;
        if (next < 0 || next >= entries.current.length) return;
        index.current = next;
        // If arriving changes nothing on screen there's no render to consume this, so it also expires by itself.
        restoring.current = window.setTimeout(() => { restoring.current = null; }, 300);
        publish();
        restoreRef.current(entries.current[next]);
    }, []);

    const back = useCallback(() => go(-1), [go]);
    const forward = useCallback(() => go(1), [go]);

    return { back, forward, canBack: can.back, canForward: can.forward };
}
