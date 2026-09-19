// Customized display names: the workspace's own name and the aliases for Search, Library, Drive, ...
// They live in the `workspace_labels` table (see src-tauri/src/db/workspace.rs); a name that was
// never set uses the default below. The keys, defaults and limits MUST match `LABELS` in that file
// (a Rust test compares the two).

// One `{ key, default, max, ... },` per line. Keep this block simple: the Rust test parses it.
export const LABEL_DEFS = [
    { key: 'workspaceName', default: 'New Workspace', max: 64, title: 'Workspace name', hint: 'Shown in exports and file names.' },
    { key: 'aliasDriveName', default: 'Drive', max: 18, title: 'Drive', hint: 'The category tree, e.g. Directory.' },
    { key: 'aliasSearch', default: 'Search', max: 18, title: 'Search', hint: 'e.g. Lookup.' },
    { key: 'aliasLibrary', default: 'Library', max: 18, title: 'Library', hint: 'Saved videos, e.g. Lab.' },
    { key: 'aliasGlossary', default: 'Glossary', max: 18, title: 'Glossary', hint: 'e.g. Thesaurus.' },
    { key: 'aliasBiography', default: 'Biography', max: 18, title: 'Biography', hint: 'The section name, e.g. Creators.' },
    { key: 'aliasBiographyItem', default: 'Person', max: 18, title: 'Biography entry', hint: 'One entry, e.g. Creator.' },
    { key: 'aliasDriveLink', default: 'Link', max: 18, title: 'Drive link', hint: 'A video also filed elsewhere, e.g. Main Ref.' },
    { key: 'aliasDriveSymlink', default: 'Symlink', max: 18, title: 'Drive symlink', hint: 'e.g. Alt Ref.' },
] as const;

export type LabelKey = typeof LABEL_DEFS[number]['key'];
export type WorkspaceLabels = Record<LabelKey, string>;

export const DEFAULT_LABELS = Object.fromEntries(LABEL_DEFS.map(d => [d.key, d.default])) as WorkspaceLabels;

/** The workspace name as a file-name fragment: spaces become underscores ("My Research" ->
 *  "My_Research"). Safe because names are letters, digits and spaces only. */
export function workspaceFileStem(name: string): string {
    return name.trim().replace(/ +/g, '_');
}

export const MAX_WORKSPACE_NAME_LEN = 64;
export const MAX_ALIAS_LEN = 18;

/** Same rule as the backend: trims, collapses spaces, letters/digits/spaces only. Returns the cleaned name or an error. */
export function checkLabel(raw: string, max: number): { value: string; error: null } | { value: null; error: string } {
    const value = raw.trim().split(/\s+/).filter(Boolean).join(' ');
    const bad = value.match(/[^A-Za-z0-9 ]/);
    if (bad) return { value: null, error: `Only letters, numbers and spaces are allowed (found '${bad[0]}').` };
    if (value.length > max) return { value: null, error: `Must be ${max} characters or fewer.` };
    return { value, error: null };
}

/** Fills defaults for anything the backend didn't return (or returned empty). */
export function withDefaults(raw: Record<string, string | null | undefined> | null | undefined): WorkspaceLabels {
    const out = { ...DEFAULT_LABELS };
    for (const { key } of LABEL_DEFS) {
        const v = raw?.[key];
        if (v && v.trim()) out[key] = v;
    }
    return out;
}
