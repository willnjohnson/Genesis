import whatsNew from '../data/whats-new.md?raw';

const SEEN_KEY = 'kinesis:whats-new-seen';

/** The version the notes are for, from their first line ("# Changelog (v0.4.8)"). Publishing new notes means changing
 *  that line, which is what makes the unread dot come back. */
export const WHATS_NEW_VERSION = whatsNew.match(/^#\s+.*?(v\d[\w.]*)/)?.[1] ?? '';

/** Whether the current notes have not been opened yet on this machine. (Local storage: per machine, so switching
 *  workspaces doesn't bring the dot back; if it is ever cleared the dot shows once more, which does no harm.) */
export function hasUnreadWhatsNew(): boolean {
    if (!WHATS_NEW_VERSION) return false;
    try {
        return localStorage.getItem(SEEN_KEY) !== WHATS_NEW_VERSION;
    } catch {
        return false;
    }
}

export function markWhatsNewRead() {
    try {
        localStorage.setItem(SEEN_KEY, WHATS_NEW_VERSION);
    } catch { /* storage blocked: the dot just stays */ }
}
