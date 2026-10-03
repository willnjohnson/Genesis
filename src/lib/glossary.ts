import type { GlossaryTerm } from '../api';

/** A term name with its ASCII capitalization folded. Names ignore case, the way the Glossary table's own
 *  `COLLATE NOCASE` key does (which folds ASCII letters only), so a link or tag that spells a term differently
 *  still finds it. */
export function foldName(name: string): string {
    return name.replace(/[A-Z]/g, c => c.toLowerCase());
}

/** The Quick Tags every workspace has, in the order the Glossary lists them (its "Essential" section). The same names as
 *  src-tauri/src/db/glossary.rs's BUILT_IN_TAGS, which makes sure they exist and refuses to delete or rename them. */
export const BUILT_IN_TAGS = ['Watch Later', 'Favorite', 'Revisit', 'Key Source', 'Follow Up'] as const;

/** Whether an entry is one of the BUILT_IN_TAGS: a Quick Tag (no definition, no Drives) by one of those names, any case. */
export function isBuiltInTag(entry: GlossaryTerm): boolean {
    return entry.definition.trim() === '' && entry.drives.length === 0 && BUILT_IN_TAGS.some(t => foldName(t) === foldName(entry.term.trim()));
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
