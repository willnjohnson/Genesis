import type { WdbsColorKey } from '../api';

// One entry per WDBS_COLOR_KEYS value (api.ts) — keep both in sync with db::WDBS_COLORS on the
// Rust side. `label` is what WdbsColorMenu's picker shows; `cssVar` is the theme-aware custom
// property (index.css) that resolves to a light-scheme shade under a light theme and a
// dark-scheme shade under a dark one — see that file's own comment for why the shade lives there
// and not here or in the database.
export const WDBS_COLOR_OPTIONS: { key: WdbsColorKey; label: string; cssVar: string }[] = [
    { key: 'red', label: 'Red', cssVar: '--k-drive-red' },
    { key: 'yellow', label: 'Yellow', cssVar: '--k-drive-yellow' },
    { key: 'green', label: 'Green', cssVar: '--k-drive-green' },
    { key: 'aqua', label: 'Aqua', cssVar: '--k-drive-aqua' },
    { key: 'magenta', label: 'Magenta', cssVar: '--k-drive-magenta' },
    { key: 'slate_gray', label: 'Slate Gray', cssVar: '--k-drive-slate-gray' },
    { key: 'charcoal', label: 'Charcoal', cssVar: '--k-drive-charcoal' },
];

const CSS_VAR_BY_KEY = new Map(WDBS_COLOR_OPTIONS.map(opt => [opt.key, opt.cssVar]));

// `null`/unrecognized (e.g. a value from a since-removed choice) both mean "no underline" — same
// fallback db::wdbs.rs's get_wdbs_tree already applies server-side. Returns a `var(...)` CSS value
// ready to drop straight into a style, not a raw hex — the actual shade is resolved by the browser
// at paint time from whichever theme is currently active (see index.css).
export function getWdbsColorValue(color: string | null | undefined): string | undefined {
    const cssVar = color ? CSS_VAR_BY_KEY.get(color as WdbsColorKey) : undefined;
    return cssVar ? `var(${cssVar})` : undefined;
}
