// Every dialog here (a modal, Settings, the palette, the Workspaces screen, a confirmation) is a full-window
// `fixed inset-0` backdrop that closes when clicked; that is also how Esc closes the topmost one (see App.tsx).
// Backdrops marked `data-nav-ok` (the video sidebar's dimming layer) are not dialogs.

const visibleBackdrops = () =>
    Array.from(document.querySelectorAll<HTMLElement>('div.fixed.inset-0:not(#k-life):not([data-nav-ok])'))
        .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');

export const hasOpenDialog = () => visibleBackdrops().length > 0;

const zIndex = (el: HTMLElement) => Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

/** Closes every open dialog, topmost first, and resolves once they are gone (a few close with a short animation). */
export async function closeOpenDialogs(): Promise<void> {
    const clicked = new Set<HTMLElement>();
    for (let i = 0; i < 8; i++) {
        const open = visibleBackdrops().filter(el => !clicked.has(el));
        if (open.length === 0) break;
        // Highest z-index first; among equals, the one added to the page last.
        const top = open.reduce((best, el) => (zIndex(el) >= zIndex(best) ? el : best));
        clicked.add(top);
        top.click();
        await wait(40);
    }
    // Wait (briefly) for any closing animation to finish.
    for (let i = 0; i < 12 && hasOpenDialog(); i++) await wait(40);
}

/** Wraps an action for a control that sits above the dialogs (the title bar's): with a dialog open, the dialog closes
 *  first and then the action runs; with none open it runs at once. */
export function afterDialogs(action: () => void): () => void {
    return () => {
        if (!hasOpenDialog()) { action(); return; }
        void closeOpenDialogs().then(action);
    };
}
