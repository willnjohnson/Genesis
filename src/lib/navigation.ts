import { useEffect, useRef } from 'react';

// Leaving for another part of the app (another section, a Library search, a Drive, a video opening in the sidebar)
// closes the windows that were open over the page you left: a term's definition, a biography. They belong to that page,
// and one left open would sit over the new one. App announces it (see goToLibrarySearch / goToLibraryDrive /
// doSelectVideo, and any change of section); each such window closes itself with useCloseOnNavigate.

const NAVIGATED_EVENT = 'kinesis:navigated';

/** Called by App whenever it takes the user somewhere else. */
export function announceNavigation() {
    window.dispatchEvent(new Event(NAVIGATED_EVENT));
}

/** Calls `close` (while `open`) when the app goes somewhere else. */
export function useCloseOnNavigate(open: boolean, close: () => void) {
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        if (!open) return;
        const onNavigate = () => closeRef.current();
        window.addEventListener(NAVIGATED_EVENT, onNavigate);
        return () => window.removeEventListener(NAVIGATED_EVENT, onNavigate);
    }, [open]);
}
