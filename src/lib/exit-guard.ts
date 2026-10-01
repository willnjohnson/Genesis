import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// The page's side of leaving the app (see src-tauri/src/exit_guard.rs): closing the window or the tray's "Quit" asks
// here first. With nothing unsaved it answers at once and the app exits; with an unsaved edit the page asks the user
// (the Sidebar's Save / Discard / Cancel) and answers once they've chosen.

/** Asks the user about an unsaved edit, if there is one: returns false when there's nothing to ask about (exit now),
 *  or true after starting to ask, calling `allow` or `cancel` once the user has chosen. */
type ExitGuard = (allow: () => void, cancel: () => void) => boolean;

let guard: ExitGuard | null = null;

/** Set by whatever can hold an unsaved edit (App, for the Sidebar); null to clear it. */
export function setExitGuard(next: ExitGuard | null) {
    guard = next;
}

/** Listens for exit requests. In the main window only, and whether or not a workspace is open (the launcher has
 *  nothing to save, and answers straight away). */
export function installExitListener() {
    const allow = () => { void invoke('exit_allow'); };
    const cancel = () => { void invoke('exit_cancel'); };
    void listen('kinesis://exit-requested', () => {
        let asking = false;
        try {
            asking = guard?.(allow, cancel) ?? false;
        } catch (e) {
            console.error('exit guard failed', e);
        }
        if (asking) void invoke('exit_hold');
        else allow();
    }).catch(() => { /* not in the app (a plain browser): nothing to guard */ });
}
