import type { ApiSection } from '../components/settings/ApiKeyTab';

/** The pages of the Settings window (SettingsModal.tsx's tabs). */
export type SettingsTabId = 'api' | 'db' | 'workspace' | 'display' | 'theme' | 'history' | 'plugins' | 'sync' | 'export';

/** One thing the command palette can take you to in Settings. */
export interface SettingsEntry {
    label: string;
    tab: SettingsTabId;
    /** For the API Key tab: which provider's page. */
    apiSection?: ApiSection;
    /** Words that should find it, beyond its name and its tab's. Distinctive ones only: a word like
     *  "choose" or "show" would match nearly everything, so none of those are here. */
    keywords: string;
}

export const TAB_LABELS: Record<SettingsTabId, string> = {
    api: 'API Key',
    db: 'Database',
    workspace: 'Workspace',
    display: 'Display',
    theme: 'Theme',
    history: 'History',
    plugins: 'Plugins',
    sync: 'Sync',
    export: 'Export',
};

/** The tab itself first, then the particular settings on it that people go looking for. */
export const SETTINGS_ENTRIES: SettingsEntry[] = [
    // API Key
    { label: 'YouTube API key', tab: 'api', apiSection: 'youtube', keywords: 'youtube data api key google quota' },
    { label: 'Venice AI API key', tab: 'api', apiSection: 'venice', keywords: 'venice ai api key balance funding credit' },
    { label: 'Pixabay API key', tab: 'api', apiSection: 'pixabay', keywords: 'pixabay api key stock photos images' },

    // Database
    { label: 'Database', tab: 'db', keywords: 'storage size disk sqlite backup stats' },
    { label: 'Database location', tab: 'db', keywords: 'move folder path external drive open folder' },

    // Workspace
    { label: 'Workspace', tab: 'workspace', keywords: 'workspace name' },
    { label: 'Rename workspace', tab: 'workspace', keywords: 'rename workspace name' },
    { label: 'Section names', tab: 'workspace', keywords: 'aliases alias rename search library glossary biography drive names labels' },
    { label: 'Permissions', tab: 'workspace', keywords: 'permissions read-only editing locked flags' },
    { label: 'Confirm before deleting', tab: 'workspace', keywords: 'confirm confirmation delete deleting warning safety permissions trash' },

    // Display
    { label: 'Display', tab: 'display', keywords: 'appearance' },
    { label: 'Window resolution', tab: 'display', keywords: 'window resolution size dimensions' },
    { label: 'Full screen', tab: 'display', keywords: 'fullscreen full screen monitor' },
    { label: 'Sort controls', tab: 'display', keywords: 'sort controls accessibility buttons heading' },
    { label: 'Video list layout', tab: 'display', keywords: 'layout grid compact list' },
    { label: 'Keep running in the tray', tab: 'display', keywords: 'tray close minimize background notification area icon quick save popup' },
    { label: 'Navigation orientation', tab: 'display', keywords: 'orientation navigation horizontal vertical rail' },

    // Theme
    { label: 'Theme', tab: 'theme', keywords: 'colors colours dark light accent palette custom theme' },

    // History
    { label: 'Search history', tab: 'history', keywords: 'history clear keep searches' },

    // Plugins
    { label: 'Plugins', tab: 'plugins', keywords: 'plugins extensions' },
    { label: 'AI summaries', tab: 'plugins', keywords: 'summarize summary ollama venice local cloud model' },
    { label: 'Custom prompt', tab: 'plugins', keywords: 'prompt template custom prompt' },
    { label: 'Clear transcript after summarizing', tab: 'plugins', keywords: 'transcript n/a clear summarizing free space' },
    { label: 'Photosynthesis', tab: 'plugins', keywords: 'photosynthesis transcript editing images' },

    // Sync (its tab is only offered in development builds; see SettingsModal.tsx)
    { label: 'Sync', tab: 'sync', keywords: 'sync server token license connect' },

    // Export
    { label: 'Export', tab: 'export', keywords: 'export' },
    { label: 'Obsidian export', tab: 'export', keywords: 'obsidian vault markdown notes' },
    { label: 'Kinpak', tab: 'export', keywords: 'kinpak share pack import file' },
];
