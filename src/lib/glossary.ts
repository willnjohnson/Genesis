import type { GlossaryTerm } from '../api';

/** Which definition of `term` to show when a term has several (one per set of Drives): the one
 *  filed under a Drive in `preferredDrives` (a video's Drives, or the Drive being browsed), else the
 *  uncategorized one, else the first. */
export function resolveEntry(entries: readonly GlossaryTerm[], term: string, preferredDrives: readonly string[] = []): GlossaryTerm | undefined {
    const rows = entries.filter(e => e.term === term);
    if (rows.length <= 1) return rows[0];
    const preferred = new Set(preferredDrives.map(d => d.toLowerCase()));
    return rows.find(r => r.drives.some(d => preferred.has(d.toLowerCase())))
        ?? rows.find(r => r.drives.length === 0)
        ?? rows[0];
}

/** name -> true when it's a Standard Term (any Drive's row has a definition), false for a Quick Tag
 *  (every row empty). A name is one thing everywhere, whichever Drive's row you look at. */
export function termKinds(entries: readonly GlossaryTerm[]): Map<string, boolean> {
    const kinds = new Map<string, boolean>();
    for (const e of entries) {
        kinds.set(e.term, (kinds.get(e.term) ?? false) || e.definition.trim() !== '');
    }
    return kinds;
}
