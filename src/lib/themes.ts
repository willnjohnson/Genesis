import { getSetting, setSetting } from '../api';

// Text/icons sitting on a solid, colored (non-white/near-white) fill — a button, a selected row,
// a chip — are always light, in every theme, full stop. No per-theme contrast computation: an
// earlier version of this picked dark text for Solarized's blue accent because it measured a hair
// better under strict WCAG luminance math, which was wrong in practice (dark-on-saturated-color
// reads worse than the numbers suggest). White unconditionally is simpler and matches the rule.
const TEXT_ON_ACCENT = '#ffffff';

// The Theme system: a small, human-friendly palette (`ThemeColors`) that both built-in themes and
// user-imported JSON files provide, expanded at runtime into the much larger set of raw CSS custom
// properties (`RAW_TOKEN_KEYS`) that index.css actually reads. Two tiers, not one, because Dark and
// Light need to stay pixel-identical to the hand-tuned values Kinesis already shipped (which don't
// reduce cleanly to ~12 semantic slots), while a theme a user hand-writes or imports should only
// ever need to fill in a handful of recognizable fields, not dozens of near-duplicate grays.

// The small, public palette — what BUILTIN_THEMES (other than dark/light) and an imported JSON file
// provide. Every value is a CSS color (hex, rgb()/rgba(), etc.).
export interface ThemeColors {
    bg: string;             // page background
    surface: string;        // panel/card background
    surfaceAlt: string;     // a second, slightly different panel shade (tooltips, dropdowns)
    surfaceRaised: string;  // hover/raised surfaces (buttons, active rows)
    border: string;         // default border color
    borderStrong: string;   // a more visible border (dividers, focused inputs)
    text: string;           // primary text
    textMuted: string;      // secondary/dim text
    accent: string;         // brand/primary accent (buttons, selection)
    accentHover: string;
    danger: string;         // destructive actions, errors
    success: string;        // confirmations
    warning: string;        // caution/hint indicators (shortcut hints, bookmarked markers, ...)
}

export interface Theme {
    name: string;           // stable id, stored in the `theme` setting and as the React key
    label: string;          // shown in the picker
    scheme: 'dark' | 'light'; // drives `color-scheme` for native scrollbars/form controls
    colors: ThemeColors;    // always present — used for the picker's swatch preview even for dark/light
    builtin?: boolean;      // hides the delete affordance in ThemeTab
}

// The full set of raw CSS custom properties index.css's per-class overrides consume. Dark/Light
// supply every one of these directly (RAW_TOKENS_DARK/LIGHT below) to stay pixel-identical to the
// values index.css originally hardcoded; every other theme has its (much larger) set of levels
// derived from the small ThemeColors palette by deriveRawTokens.
interface RawTokens { [cssVarName: string]: string }

// Named directly after the Tailwind class each one replaces (`bg-121212` <- `.bg-[#121212]`)
// rather than a semantic elevation scale — with 20+ distinct background shades alone, per-class
// naming is what's actually verifiable against the old override block, which is the point of this
// being a mechanical port. A handful of the old file's rules are deliberately NOT represented here
// at all (`.prose` colors, bare `code`/`input`/`select`) — see index.css's own comment where those
// are kept as literal, unconverted `:root:not(.dark)` rules instead, and why.
const RAW_TOKEN_KEYS = [
    'bg', 'bg-121212', 'bg-141414', 'bg-1a1a1a', 'bg-202020', 'bg-222222', 'bg-272727', 'bg-2a2a2a',
    'bg-303030', 'bg-333333', 'bg-3f3f3f', 'bg-444444',
    'overlay-black-20', 'overlay-black-40', 'overlay-black-60', 'overlay-black-70', 'overlay-black-80',
    'bg-gray-900-50', 'bg-gray-800', 'bg-white-5',
    // Text
    'text-white', 'text-aaaaaa', 'text-888888', 'text-gray-200', 'text-gray-300', 'text-gray-400',
    'text-gray-500', 'text-gray-600', 'text-gray-700', 'text-gray-800', 'text-gray-900',
    // Borders
    'border-303030', 'border-333', 'border-333333', 'border-383838', 'border-404040', 'border-444',
    'border-505050', 'border-gray-700', 'border-gray-800', 'border-white-5',
    // Hover backgrounds/borders
    'hover-bg-333333', 'hover-bg-3f3f3f', 'hover-bg-444', 'hover-bg-444444', 'hover-bg-272727', 'hover-bg-2a2a2a', 'hover-bg-202020',
    'hover-bg-gray-700', 'hover-text-white', 'hover-border-505050', 'hover-border-555555',
    // Brand / semantic colors. `text-on-accent` is deliberately separate from `text-white` above:
    // `text-white` means "primary text on the page/surface background" (flips dark<->light per
    // theme), while `text-on-accent` means "text sitting on top of a solid accent-colored button/
    // row" (a selected WdbsTreePanel row, the Drive/Bulk-Assign toggle buttons, a Delete
    // confirmation button, ...) — those need to stay legible against the *accent* color specifically,
    // regardless of what the page background is doing, so they can't share Tailwind's `text-white`
    // class with ordinary page text without one of the two contexts rendering unreadable.
    'accent', 'accent-hover', 'success', 'success-hover', 'info', 'info-hover', 'purple', 'text-on-accent',
    // Danger surfaces (Sidebar delete button, etc.)
    'danger-surface', 'danger-text', 'danger-surface-hover',
    // Misc
    'warning', 'scrollbar-thumb', 'scrollbar-thumb-hover',
] as const;

// The exact values index.css hardcoded before this system existed — dark from each Tailwind
// class's own literal hex, light from the old `:root:not(.dark)` override block — so switching to
// Dark/Light after this change looks exactly like it did before it.
//
// `accent-hover`/`success-hover`/`info-hover`'s dark values are Tailwind's own red-500/green-500/
// blue-500 (NOT the same as `accent`/`success`/`info`, and NOT literally what the old file's
// `.bg-red-600:hover` rule said either): a `.bg-red-600:hover` selector matches on the *pseudo-
// class*, independent of whatever other classes an element has, so it already won the cascade
// over each button's own separate `hover:bg-red-500`/`hover:bg-red-700` class in every mode where
// it applied — the old file only gated it to `:not(.dark)`, so dark mode had no competing rule and
// fell through to each button's own `hover:bg-red-*` class, i.e. Tailwind's stock hover shade.
// Making the rule unconditional here means it now needs an explicit dark value that matches what
// was actually showing before, not the (different) `accent` base color.
const TW_RED_500 = '#ef4444', TW_GREEN_500 = '#22c55e', TW_BLUE_500 = '#3b82f6';
const RAW_TOKENS_DARK: RawTokens = {
    bg: '#0f0f0f',
    'bg-121212': '#121212', 'bg-141414': '#141414', 'bg-1a1a1a': '#1a1a1a', 'bg-202020': '#202020',
    'bg-222222': '#222222', 'bg-272727': '#272727', 'bg-2a2a2a': '#2a2a2a', 'bg-303030': '#303030',
    'bg-333333': '#333333', 'bg-3f3f3f': '#3f3f3f', 'bg-444444': '#444444',
    'overlay-black-20': 'rgba(0,0,0,0.2)', 'overlay-black-40': 'rgba(0,0,0,0.4)',
    'overlay-black-60': 'rgba(0,0,0,0.6)', 'overlay-black-70': 'rgba(0,0,0,0.7)', 'overlay-black-80': 'rgba(0,0,0,0.8)',
    'bg-gray-900-50': 'rgba(17,24,39,0.5)', 'bg-gray-800': '#1f2937', 'bg-white-5': 'rgba(255,255,255,0.05)',
    'text-white': '#ffffff', 'text-aaaaaa': '#aaaaaa', 'text-888888': '#888888',
    'text-gray-200': '#e5e7eb', 'text-gray-300': '#d1d5db', 'text-gray-400': '#9ca3af', 'text-gray-500': '#6b7280',
    'text-gray-600': '#4b5563', 'text-gray-700': '#374151', 'text-gray-800': '#1f2937', 'text-gray-900': '#111827',
    'border-303030': '#303030', 'border-333': '#333333', 'border-333333': '#333333', 'border-383838': '#383838',
    'border-404040': '#404040', 'border-444': '#444444', 'border-505050': '#505050',
    'border-gray-700': '#374151', 'border-gray-800': '#1f2937', 'border-white-5': 'rgba(255,255,255,0.05)',
    'hover-bg-333333': '#333333', 'hover-bg-3f3f3f': '#3f3f3f', 'hover-bg-444': '#444444', 'hover-bg-444444': '#444444',
    'hover-bg-272727': '#272727', 'hover-bg-2a2a2a': '#2a2a2a', 'hover-bg-202020': '#202020', 'hover-bg-gray-700': '#374151',
    'hover-text-white': '#ffffff', 'hover-border-505050': '#505050', 'hover-border-555555': '#555555',
    accent: '#dc2626', 'accent-hover': TW_RED_500, success: '#16a34a', 'success-hover': TW_GREEN_500,
    info: '#2563eb', 'info-hover': TW_BLUE_500, purple: '#9333ea', 'text-on-accent': TEXT_ON_ACCENT,
    'danger-surface': 'rgba(127,29,29,0.1)', 'danger-text': '#ef4444', 'danger-surface-hover': 'rgba(127,29,29,0.2)',
    warning: '#fb923c', 'scrollbar-thumb': '#717171', 'scrollbar-thumb-hover': '#aaaaaa',
};

// The old `:root:not(.dark)` override block's target values, carried over 1:1. A few genuine
// duplicate/conflicting rules existed in the old file for identical selectors (`.bg-[#1a1a1a]`,
// `.bg-[#303030]`, `.border-[#333]`, `.text-gray-300`, `.text-gray-500` were each declared twice
// with the same value — harmless; `.hover\:bg-[#272727]:hover` and `.text-gray-200` were each
// declared twice with *different* values — `#dddddd` then `#bbbbbb` for the former, `#222222`
// then `#333333` for the latter — CSS cascade order meant the later rule silently won everywhere
// that class was used, so `#bbbbbb`/`#333333` (below) is what light mode has actually been
// rendering, not `#dddddd`/`#222222`).
const RAW_TOKENS_LIGHT: RawTokens = {
    bg: '#ffffff',
    'bg-121212': '#f5f5f5', 'bg-141414': '#f0f0f0', 'bg-1a1a1a': '#f0f0f0', 'bg-202020': '#e5e5e5',
    'bg-222222': '#ebebeb', 'bg-272727': '#e8e8e8', 'bg-2a2a2a': '#e0e0e0', 'bg-303030': '#e0e0e0',
    'bg-333333': '#d5d5d5', 'bg-3f3f3f': '#d5d5d5', 'bg-444444': '#cccccc',
    'overlay-black-20': '#f5f5f5', 'overlay-black-40': 'rgba(0,0,0,0.05)',
    'overlay-black-60': 'rgba(0,0,0,0.08)', 'overlay-black-70': 'rgba(0,0,0,0.4)', 'overlay-black-80': 'rgba(0,0,0,0.45)',
    'bg-gray-900-50': '#e8e8e8', 'bg-gray-800': '#d5d5d5', 'bg-white-5': '#f9f9f9',
    'text-white': '#1a1a1a', 'text-aaaaaa': '#5c5c5c', 'text-888888': '#555555',
    'text-gray-200': '#333333', 'text-gray-300': '#333333', 'text-gray-400': '#555555', 'text-gray-500': '#666666',
    'text-gray-600': '#555555', 'text-gray-700': '#444444', 'text-gray-800': '#222222', 'text-gray-900': '#1a1a1a',
    'border-303030': '#d8d8d8', 'border-333': '#cccccc', 'border-333333': '#dddddd', 'border-383838': '#cccccc',
    'border-404040': '#cccccc', 'border-444': '#bbbbbb', 'border-505050': '#999999',
    'border-gray-700': '#cccccc', 'border-gray-800': '#bbbbbb', 'border-white-5': '#e5e5e5',
    'hover-bg-333333': '#d0d0d0', 'hover-bg-3f3f3f': '#d0d0d0', 'hover-bg-444': '#cccccc', 'hover-bg-444444': '#d5d5d5',
    'hover-bg-272727': '#bbbbbb', 'hover-bg-2a2a2a': '#e5e5e5', 'hover-bg-202020': '#d5d5d5', 'hover-bg-gray-700': '#cccccc',
    'hover-text-white': '#000000', 'hover-border-505050': '#999999', 'hover-border-555555': '#777777',
    accent: '#cc0000', 'accent-hover': '#aa0000', success: '#16a34a', 'success-hover': '#15803d',
    info: '#2563eb', 'info-hover': '#1d4ed8', purple: '#9333ea', 'text-on-accent': TEXT_ON_ACCENT,
    'danger-surface': '#ffebee', 'danger-text': '#cc0000', 'danger-surface-hover': '#ffcdd2',
    warning: '#c2410c', 'scrollbar-thumb': '#cccccc', 'scrollbar-thumb-hover': '#999999',
};

// Fans a small, human-friendly palette out to the full raw token set for any theme that isn't Dark
// or Light. Doesn't try to reproduce Kinesis's original ~11-step background scale exactly — a
// themed palette (Dracula, Nord, a custom import) just needs a handful of visually distinct,
// coherent levels, not an exact copy of it.
function deriveRawTokens(colors: ThemeColors): RawTokens {
    return {
        bg: colors.bg,
        'bg-121212': colors.surface, 'bg-141414': colors.surface, 'bg-1a1a1a': colors.surfaceAlt, 'bg-202020': colors.surfaceAlt,
        'bg-222222': colors.surfaceAlt, 'bg-272727': colors.surfaceRaised, 'bg-2a2a2a': colors.surfaceRaised, 'bg-303030': colors.surfaceRaised,
        'bg-333333': colors.borderStrong, 'bg-3f3f3f': colors.borderStrong, 'bg-444444': colors.borderStrong,
        'overlay-black-20': 'rgba(0,0,0,0.2)', 'overlay-black-40': 'rgba(0,0,0,0.4)',
        'overlay-black-60': 'rgba(0,0,0,0.6)', 'overlay-black-70': 'rgba(0,0,0,0.7)', 'overlay-black-80': 'rgba(0,0,0,0.8)',
        'bg-gray-900-50': colors.surfaceAlt, 'bg-gray-800': colors.surfaceRaised, 'bg-white-5': colors.surfaceAlt,
        'text-white': colors.text, 'text-aaaaaa': colors.textMuted, 'text-888888': colors.textMuted,
        'text-gray-200': colors.text, 'text-gray-300': colors.textMuted, 'text-gray-400': colors.textMuted, 'text-gray-500': colors.textMuted,
        'text-gray-600': colors.textMuted, 'text-gray-700': colors.textMuted, 'text-gray-800': colors.text, 'text-gray-900': colors.text,
        'border-303030': colors.border, 'border-333': colors.border, 'border-333333': colors.border, 'border-383838': colors.border,
        'border-404040': colors.border, 'border-444': colors.borderStrong, 'border-505050': colors.borderStrong,
        'border-gray-700': colors.border, 'border-gray-800': colors.borderStrong, 'border-white-5': colors.border,
        'hover-bg-333333': colors.surfaceRaised, 'hover-bg-3f3f3f': colors.surfaceRaised, 'hover-bg-444': colors.surfaceRaised, 'hover-bg-444444': colors.surfaceRaised,
        'hover-bg-272727': colors.surfaceRaised, 'hover-bg-2a2a2a': colors.surfaceRaised, 'hover-bg-202020': colors.surfaceRaised, 'hover-bg-gray-700': colors.surfaceRaised,
        'hover-text-white': colors.text, 'hover-border-505050': colors.borderStrong, 'hover-border-555555': colors.borderStrong,
        accent: colors.accent, 'accent-hover': colors.accentHover, success: colors.success, 'success-hover': colors.success,
        info: colors.accent, 'info-hover': colors.accentHover, purple: colors.accentHover,
        'text-on-accent': TEXT_ON_ACCENT,
        'danger-surface': colors.danger, 'danger-text': colors.danger, 'danger-surface-hover': colors.danger,
        warning: colors.warning, 'scrollbar-thumb': colors.borderStrong, 'scrollbar-thumb-hover': colors.textMuted,
    };
}

// Approximate ThemeColors read off each palette's own official spec, for the picker's swatch
// preview — verify against the theme's source (draculatheme.com/api, nordtheme.com, etc.) if a
// palette ever looks off, since these were transcribed from memory rather than fetched live.
//
// `textMuted` deliberately is NOT each theme's own "comment" color, even though that's the most
// authentic-looking choice — a real syntax-highlighting theme's comment color is often
// *intentionally* low-contrast against its own background (comments are meant to visually recede),
// which measured under WCAG well below the 4.5:1 this app needs for `textMuted` to stay legible
// everywhere it's actually used here (secondary button/icon labels sitting on `surfaceRaised`, not
// just body text on `bg`). Each value below was computed by blending that authentic comment color
// toward neutral gray until it cleared 4.5:1 against `surfaceRaised`, `surface`, and `bg` alike, so
// it reads as "dimmer than primary text" without ever becoming genuinely hard to read. Solarized's
// `surfaceRaised` needed the same treatment in the other direction (darkened, since even its own
// full-brightness `text` failed contrast against the original value).
const DRACULA: ThemeColors = {
    bg: '#282a36', surface: '#21222c', surfaceAlt: '#343746', surfaceRaised: '#44475a',
    border: '#44475a', borderStrong: '#6272a4', text: '#f8f8f2', textMuted: '#b7b7b4',
    accent: '#bd93f9', accentHover: '#ff79c6', danger: '#ff5555', success: '#50fa7b', warning: '#f1fa8c',
};
const NORD: ThemeColors = {
    bg: '#2e3440', surface: '#3b4252', surfaceAlt: '#434c5e', surfaceRaised: '#4c566a',
    border: '#434c5e', borderStrong: '#4c566a', text: '#eceff4', textMuted: '#d8dee9',
    accent: '#88c0d0', accentHover: '#81a1c1', danger: '#bf616a', success: '#a3be8c', warning: '#ebcb8b',
};
const SOLARIZED_DARK: ThemeColors = {
    bg: '#002b36', surface: '#073642', surfaceAlt: '#0a4551', surfaceRaised: '#0d3a46',
    border: '#586e75', borderStrong: '#657b83', text: '#93a1a1', textMuted: '#92a0a0',
    accent: '#268bd2', accentHover: '#2aa198', danger: '#dc322f', success: '#859900', warning: '#b58900',
};
const MONOKAI: ThemeColors = {
    bg: '#272822', surface: '#2d2e27', surfaceAlt: '#3e3d32', surfaceRaised: '#49483e',
    border: '#49483e', borderStrong: '#75715e', text: '#f8f8f2', textMuted: '#b7b7b4',
    accent: '#66d9ef', accentHover: '#f92672', danger: '#f92672', success: '#a6e22e', warning: '#fd971f',
};
const GRUVBOX: ThemeColors = {
    bg: '#282828', surface: '#32302f', surfaceAlt: '#3c3836', surfaceRaised: '#504945',
    border: '#504945', borderStrong: '#665c54', text: '#ebdbb2', textMuted: '#c4baa0',
    accent: '#d79921', accentHover: '#fe8019', danger: '#fb4934', success: '#b8bb26', warning: '#fabd2f',
};
const ONE_DARK: ThemeColors = {
    bg: '#282c34', surface: '#21252b', surfaceAlt: '#2c313c', surfaceRaised: '#3b4048',
    border: '#3b4048', borderStrong: '#4b5263', text: '#abb2bf', textMuted: '#a5abb6',
    accent: '#61afef', accentHover: '#c678dd', danger: '#e06c75', success: '#98c379', warning: '#e5c07b',
};
const TOKYO_NIGHT: ThemeColors = {
    bg: '#1a1b26', surface: '#1f2335', surfaceAlt: '#24283b', surfaceRaised: '#414868',
    border: '#414868', borderStrong: '#565f89', text: '#c0caf5', textMuted: '#b1b8d9',
    accent: '#7aa2f7', accentHover: '#bb9af7', danger: '#f7768e', success: '#9ece6a', warning: '#e0af68',
};
// Pulled from github.com/Foreglow/foreglow-theme's README color table — the base "Foreglow"
// variant specifically (the repo also ships Afterglow/Alpenglow/Airglow, which aren't included
// here), using its own Background/Bg Alt/Current Line/Selection/Border/Foreground/Foreground Dim/
// Cursor-Accent/Error/Warning/Success rows directly rather than approximated substitutes.
const FOREGLOW: ThemeColors = {
    bg: '#161221', surface: '#1D182A', surfaceAlt: '#281F3D', surfaceRaised: '#3D2556',
    border: '#322C44', borderStrong: '#736699', text: '#E8E3F2', textMuted: '#A49BBF',
    accent: '#F471C8', accentHover: '#CB81E4', danger: '#E46772', success: '#6BC7A8', warning: '#F2A65A',
};

export const BUILTIN_THEMES: Theme[] = [
    { name: 'dark', label: 'Cytokine', scheme: 'dark', builtin: true, colors: {
        bg: RAW_TOKENS_DARK.bg, surface: RAW_TOKENS_DARK['bg-121212'], surfaceAlt: RAW_TOKENS_DARK['bg-1a1a1a'],
        surfaceRaised: RAW_TOKENS_DARK['bg-303030'], border: RAW_TOKENS_DARK['border-303030'], borderStrong: RAW_TOKENS_DARK['border-505050'],
        text: RAW_TOKENS_DARK['text-white'], textMuted: RAW_TOKENS_DARK['text-gray-400'],
        accent: RAW_TOKENS_DARK.accent, accentHover: RAW_TOKENS_DARK['accent-hover'],
        danger: RAW_TOKENS_DARK['danger-text'], success: RAW_TOKENS_DARK.success, warning: RAW_TOKENS_DARK.warning,
    } },
    { name: 'light', label: 'Osteokine', scheme: 'light', builtin: true, colors: {
        bg: RAW_TOKENS_LIGHT.bg, surface: RAW_TOKENS_LIGHT['bg-121212'], surfaceAlt: RAW_TOKENS_LIGHT['bg-1a1a1a'],
        surfaceRaised: RAW_TOKENS_LIGHT['bg-303030'], border: RAW_TOKENS_LIGHT['border-303030'], borderStrong: RAW_TOKENS_LIGHT['border-505050'],
        text: RAW_TOKENS_LIGHT['text-white'], textMuted: RAW_TOKENS_LIGHT['text-gray-400'],
        accent: RAW_TOKENS_LIGHT.accent, accentHover: RAW_TOKENS_LIGHT['accent-hover'],
        danger: RAW_TOKENS_LIGHT['danger-text'], success: RAW_TOKENS_LIGHT.success, warning: RAW_TOKENS_LIGHT.warning,
    } },
    { name: 'dracula', label: 'Dracula', scheme: 'dark', builtin: true, colors: DRACULA },
    { name: 'nord', label: 'Nord', scheme: 'dark', builtin: true, colors: NORD },
    { name: 'solarized', label: 'Solarized', scheme: 'dark', builtin: true, colors: SOLARIZED_DARK },
    { name: 'monokai', label: 'Monokai', scheme: 'dark', builtin: true, colors: MONOKAI },
    { name: 'gruvbox', label: 'Gruvbox', scheme: 'dark', builtin: true, colors: GRUVBOX },
    { name: 'one-dark', label: 'One Dark', scheme: 'dark', builtin: true, colors: ONE_DARK },
    { name: 'tokyo-night', label: 'Tokyo Night', scheme: 'dark', builtin: true, colors: TOKYO_NIGHT },
    { name: 'foreglow', label: 'Foreglow', scheme: 'dark', builtin: true, colors: FOREGLOW },
];

export const DEFAULT_THEME = BUILTIN_THEMES[0];

// Applies a theme by setting every raw CSS custom property on <html>, plus `color-scheme` (native
// scrollbar/form-control rendering). Dark/Light use their exact hardcoded raw tokens; everything
// else is fanned out from its small `colors` palette via deriveRawTokens.
//
// Also keeps toggling the `.dark` class itself (the old, pre-theme-system mechanism) — a handful
// of components (BiographyView, Sidebar/TermDefinitionModal's markdown `prose`, SearchBar's
// history dropdown, HistoryTab) use Tailwind's own `dark:` variant directly rather than one of the
// Tailwind classes the raw-token override rules below cover, so they never picked up the CSS
// variables above. Those are out of scope for re-theming to a *specific* palette in this pass (see
// themes.ts's own module comment) — but they still need `.dark` present for every dark-scheme
// theme (not just literally "Dark") to keep looking the way they always have, rather than
// silently reverting to their light styling under Dracula/Nord/etc.
export function applyTheme(theme: Theme) {
    const root = document.documentElement;
    const raw = theme.name === 'dark' ? RAW_TOKENS_DARK : theme.name === 'light' ? RAW_TOKENS_LIGHT : deriveRawTokens(theme.colors);
    for (const key of RAW_TOKEN_KEYS) {
        root.style.setProperty(`--k-${key}`, raw[key] ?? '');
    }
    root.style.colorScheme = theme.scheme;
    root.classList.toggle('dark', theme.scheme === 'dark');
}

const THEME_COLOR_KEYS: (keyof ThemeColors)[] = [
    'bg', 'surface', 'surfaceAlt', 'surfaceRaised', 'border', 'borderStrong',
    'text', 'textMuted', 'accent', 'accentHover', 'danger', 'success', 'warning',
];

// Validates an imported theme file's shape — every ThemeColors field present as a non-empty
// string, plus a name to show/store it under. Anything else (extra fields, wrong types) is
// ignored/rejected respectively; this doesn't validate that values are *valid* CSS colors, since
// the browser will simply ignore an invalid one when applyTheme sets it (safe failure mode).
export function parseThemeJson(raw: string, fallbackName: string): Theme | { error: string } {
    let data: any;
    try {
        data = JSON.parse(raw);
    } catch {
        return { error: 'That file is not valid JSON.' };
    }
    if (!data || typeof data !== 'object') {
        return { error: 'Expected a JSON object with theme colors.' };
    }
    const colorsSource = typeof data.colors === 'object' && data.colors !== null ? data.colors : data;
    const colors = {} as ThemeColors;
    for (const key of THEME_COLOR_KEYS) {
        const value = colorsSource[key];
        if (typeof value !== 'string' || !value.trim()) {
            return { error: `Missing or invalid "${key}" color.` };
        }
        colors[key] = value.trim();
    }
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName;
    const scheme: 'dark' | 'light' = data.scheme === 'light' ? 'light' : 'dark';
    return { name: `custom:${name}`, label: name, scheme, colors };
}

export function isThemeError(result: Theme | { error: string }): result is { error: string } {
    return 'error' in result;
}

const CUSTOM_THEMES_SETTING_KEY = 'customThemes';

// Persists the user's imported themes as one JSON-array string in the generic settings table
// (see api.ts's getSetting/setSetting) — no dedicated backend/schema support needed.
export async function loadCustomThemes(): Promise<Theme[]> {
    try {
        const raw = await getSetting(CUSTOM_THEMES_SETTING_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export async function saveCustomThemes(themes: Theme[]): Promise<void> {
    await setSetting(CUSTOM_THEMES_SETTING_KEY, JSON.stringify(themes));
}

// Finds the active theme by name across built-ins and custom themes, falling back to Dark for a
// first launch (no `theme` setting yet) or a since-deleted custom theme.
export function resolveTheme(name: string | undefined | null, customThemes: Theme[]): Theme {
    return BUILTIN_THEMES.find(t => t.name === name) ?? customThemes.find(t => t.name === name) ?? DEFAULT_THEME;
}
