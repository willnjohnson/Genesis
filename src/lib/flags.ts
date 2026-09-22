// Feature flags: rows in the `Settings` table that a DB owner sets to shape the app for their users
// (hide a tab, turn off editing, ...), either by editing the database or through a sync server's
// policy. The defaults below MUST match `FEATURE_FLAGS` in crates/kinesis-sync-proto/src/settings.rs
// (a Rust test compares the two), and docs/customizing.md describes each flag.
//
// Yes/no flags accept true/false, 1/0, yes/no, on/off in any case; anything missing or unreadable
// means the flag's default, so a typo never flips a flag to a surprising state.

// One `key: default,` per line. Keep this block simple: the Rust test parses it.
export const FLAG_DEFAULTS = {
    // Read-only master switch: forces every content-editing flag below off (see the
    // READ_ONLY_OVERRIDE list and applyRules further down) without touching what's actually
    // stored, so turning it back off restores whatever fine-grained permissions were configured.
    // Doesn't touch app-level settings (workspace rename, sync, DB location, themes, custom
    // prompts) — those aren't "the workspace's data".
    workspaceReadOnly: false,
    // Main views
    showSearch: true,
    showLibrary: true,
    showGlossary: true,
    showBiography: true,
    showDrive: true,
    defaultView: 'search',
    // Library and search results
    showSortControls: true,
    showFilterControls: true,
    showListModeToggle: true,
    hideShortsInSearch: true,
    showSearchHistory: true,
    saveSearchHistory: true,
    allowClearHistory: true,
    // Saving, deleting, bulk actions
    allowSaveToLibrary: true,
    allowSaveAll: true,
    allowDeletionLibrary: true,
    allowSummarizeAll: true,
    // Video detail panel
    showVideoPlayer: true,
    showOpenInYouTube: true,
    showVideoTags: true,
    showSimilarVideos: true,
    showAttachments: true,
    editAttachments: true,
    allowEditTermsAndTags: true,
    allowEditSummary: true,
    allowEditTranscript: true,
    allowEditTranscriptOnNA: true,
    allowEditWDBS: true,
    allowEditDriveLinking: true,
    showSequences: true,
    allowEditSequences: true,
    allowEditVideosInSequenceList: true,
    showCustomPrompt: true,
    setTranscriptAfterSummarizeToNA: false,
    // AI summarize and image tools
    showSummarizeButton: false,
    showSummarizeOllama: true,
    showSummarizeVenice: true,
    showSynthesizeVenice: true,
    showSynthesizePixabay: true,
    showSynthesizeUpload: true,
    // Glossary and biographies
    allowModificationGlossary: true,
    showQuickTags: true,
    showGlossaryDriveFilter: true,
    showGlossarySearchByTag: true,
    showGlossarySearchInLibrary: true,
    allowEditBio: true,
    // Workspace names
    showWorkspaceAdvanced: true,
    allowWorkspaceRename: true,
    // Settings window: the whole thing, each tab, and controls inside them
    showSettings: true,
    showTabApiKey: true,
    showTabDatabase: true,
    showTabDisplay: true,
    showTabTheme: true,
    showTabHistory: true,
    showTabPlugins: true,
    showTabSync: true,
    showTabExport: true,
    showExportObsidian: true,
    showExportSyncData: true,
    allowSyncImport: true,
    allowSyncDisconnect: true,
    allowChangeDbLocation: true,
    allowOpenDbFolder: true,
    allowOllamaSetup: true,
    allowEditPrompts: true,
    allowCustomThemes: true,
} as const;

export type FlagKey = keyof typeof FLAG_DEFAULTS;
export type ViewName = 'search' | 'library' | 'glossary' | 'biography';
export type SettingsTabId = 'api' | 'db' | 'workspace' | 'display' | 'theme' | 'history' | 'plugins' | 'sync' | 'export';

export type Flags = { [K in Exclude<FlagKey, 'defaultView'>]: boolean } & { defaultView: ViewName };

/** Every flag key, for reading them all from the settings table in one call. */
export const FLAG_KEYS = Object.keys(FLAG_DEFAULTS) as FlagKey[];

const VIEW_ORDER: ViewName[] = ['search', 'library', 'glossary', 'biography'];

// Every flag `workspaceReadOnly` forces off — everything that changes the workspace's saved
// content. Also exactly what settings/PermissionsPanel.tsx lists as individually toggleable
// (its "Content editing only" scope), so the two stay in step by construction: this is the one
// place either of them reads from. Deliberately excludes app-level settings (workspace rename,
// sync, DB location, Ollama setup, custom prompts, custom themes).
export const READ_ONLY_OVERRIDE_KEYS: readonly FlagKey[] = [
    'allowClearHistory', 'allowSaveToLibrary', 'allowSaveAll', 'allowDeletionLibrary', 'allowSummarizeAll',
    'editAttachments', 'allowEditTermsAndTags', 'allowEditSummary', 'allowEditTranscript', 'allowEditTranscriptOnNA',
    'allowEditWDBS', 'allowEditDriveLinking', 'allowEditSequences', 'allowEditVideosInSequenceList',
    'allowModificationGlossary', 'allowEditBio',
];

export function parseBool(value: string | null | undefined, fallback: boolean): boolean {
    switch ((value ?? '').trim().toLowerCase()) {
        case 'true': case '1': case 'yes': case 'on': return true;
        case 'false': case '0': case 'no': case 'off': return false;
        default: return fallback;
    }
}

export function parseView(value: string | null | undefined, fallback: ViewName): ViewName {
    const v = (value ?? '').trim().toLowerCase();
    return (VIEW_ORDER as string[]).includes(v) ? (v as ViewName) : fallback;
}

/** Turns raw settings-table values into typed flags (missing or junk values become the default). */
export function parseFlags(raw: Record<string, string | null | undefined>): Flags {
    const out: Record<string, boolean | string> = {};
    for (const key of FLAG_KEYS) {
        const fallback = FLAG_DEFAULTS[key];
        out[key] = key === 'defaultView'
            ? parseView(raw[key], fallback as ViewName)
            : parseBool(raw[key], fallback as boolean);
    }
    return out as Flags;
}

/** What the UI actually shows: the flags plus the rules that tie some of them together. */
export interface ResolvedFlags extends Flags {
    /** Which top-level views can be reached. */
    viewVisible: Record<ViewName, boolean>;
    /** Which Settings tabs are listed. Export needs one of its two exports; Sync-data export needs the Sync tab. */
    tabVisible: Record<SettingsTabId, boolean>;
    exportObsidianVisible: boolean;
    exportSyncDataVisible: boolean;
    /** The gear itself: off when Settings is turned off, or when every tab is hidden. */
    settingsVisible: boolean;
    /** Save All saves to the library, so it needs saving to be allowed. */
    saveAllAllowed: boolean;
    /** Drives can be hidden entirely; the glossary's drive filter and picker follow. */
    glossaryDriveFilterVisible: boolean;
    glossaryDrivePickerVisible: boolean;
    /** The view to show when `wanted` isn't reachable (or nothing was asked for): defaultView, else the first visible one. */
    pickView: (wanted?: ViewName) => ViewName;
}

export function resolveFlags(raw: Record<string, string | null | undefined>): ResolvedFlags {
    return applyRules(parseFlags(raw));
}

export function applyRules(f: Flags): ResolvedFlags {
    const viewVisible: Record<ViewName, boolean> = {
        search: f.showSearch,
        library: f.showLibrary,
        glossary: f.showGlossary,
        biography: f.showBiography,
    };
    const exportObsidianVisible = f.showExportObsidian;
    const exportSyncDataVisible = f.showExportSyncData && f.showTabSync;
    const tabVisible: Record<SettingsTabId, boolean> = {
        api: f.showTabApiKey,
        db: f.showTabDatabase,
        // Always listed: the name itself is never hidden, only locked (allowWorkspaceRename) or,
        // for the Advanced section, hidden (showWorkspaceAdvanced).
        workspace: true,
        display: f.showTabDisplay,
        theme: f.showTabTheme,
        history: f.showTabHistory,
        plugins: f.showTabPlugins,
        sync: f.showTabSync,
        export: f.showTabExport && (exportObsidianVisible || exportSyncDataVisible),
    };
    const pickView = (wanted?: ViewName): ViewName => {
        const preferred = wanted ?? f.defaultView;
        if (viewVisible[preferred]) return preferred;
        return VIEW_ORDER.find(v => viewVisible[v]) ?? 'library';
    };
    // Forces every content-editing flag off without touching what's actually stored in `f` — a
    // Partial so this only ever overrides, never has to repeat the "leave it alone" branch for
    // every key. Built from f (the stored values), not the object below, so it isn't shadowed by
    // whatever those keys already resolved to.
    const readOnlyOverride: Partial<Flags> = f.workspaceReadOnly
        ? Object.fromEntries(READ_ONLY_OVERRIDE_KEYS.map(key => [key, false]))
        : {};
    return {
        ...f,
        viewVisible,
        tabVisible,
        exportObsidianVisible,
        exportSyncDataVisible,
        settingsVisible: f.showSettings && Object.values(tabVisible).some(Boolean),
        // Derived from f (the stored values) like the rest of this object, so it needs its own
        // check: readOnlyOverride can't carry it (saveAllAllowed isn't a stored flag), but it must
        // still go false when Read-only forces allowSaveAll/allowSaveToLibrary off below.
        saveAllAllowed: !f.workspaceReadOnly && f.allowSaveAll && f.allowSaveToLibrary,
        glossaryDriveFilterVisible: f.showDrive && f.showGlossaryDriveFilter,
        glossaryDrivePickerVisible: f.showDrive,
        pickView,
        // Spread last: overrides every content-editing flag above (from `...f`) when Read-only is on.
        ...readOnlyOverride,
    };
}
