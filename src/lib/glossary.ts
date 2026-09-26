import type { GlossaryTerm } from '../api';

/** A term name with its ASCII capitalization folded. Names ignore case, the way the Glossary table's own
 *  `COLLATE NOCASE` key does (which folds ASCII letters only), so a link or tag that spells a term differently
 *  still finds it. */
export function foldName(name: string): string {
    return name.replace(/[A-Z]/g, c => c.toLowerCase());
}

/** Which definition of `term` to show when a term has several (one per set of Drives): the one
 *  filed under a Drive in `preferredDrives` (a video's Drives, or the Drive being browsed), else the
 *  uncategorized one, else the first. */
export function resolveEntry(entries: readonly GlossaryTerm[], term: string, preferredDrives: readonly string[] = []): GlossaryTerm | undefined {
    const wanted = foldName(term);
    const rows = entries.filter(e => foldName(e.term) === wanted);
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
