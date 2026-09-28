import whatsNew from '../data/whats-new.md?raw';

const SEEN_KEY = 'kinesis:whats-new-seen';

export interface WhatsNewEntry {
    /** e.g. "v0.5.0" (with the leading "v"), or "" if a section's heading didn't have one. */
    version: string;
    /** The heading line's text, e.g. "Changelog (v0.5.0)" — shown as-is nowhere; version is pulled out of it. */
    heading: string;
    /** Everything under the heading, up to (not including) the next "# " heading. */
    body: string;
}

/** Splits the file into one entry per top-level ("# ") heading, newest first (however they're
 *  ordered in the file — publishing a new version means adding its own "# " section above the
 *  previous one, never editing an old one in place, so old notes stay exactly as they were shown). */
function parseWhatsNew(raw: string): WhatsNewEntry[] {
    return raw
        .split(/\r?\n(?=#\s)/)
        .map(section => {
            // Greedy (.+), and the newline after it required, not optional — a lazy heading capture
            // with an optional newline collapses to matching just the heading's first character
            // (the rest of the pattern is satisfiable at that point too), which quietly truncates
            // every heading to one letter.
            const m = section.match(/^#\s+(.+)\r?\n([\s\S]*)$/);
            const heading = m?.[1] ?? '';
            const body = (m?.[2] ?? section).trim();
            return { version: heading.match(/v\d[\w.]*/)?.[0] ?? '', heading, body };
        })
        .filter(e => e.heading || e.body);
}

export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = parseWhatsNew(whatsNew);

/** The newest entry's version. Publishing new notes means adding a new "# " section above the rest
 *  (changing what this resolves to), which is what makes the unread dot come back. */
export const WHATS_NEW_VERSION = WHATS_NEW_ENTRIES[0]?.version ?? '';

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
