import { X, Settings, Key, HardDrive, Layers, Monitor, History, Cpu, Palette, FileDown, RefreshCw } from "lucide-react";
import { useState, useEffect } from "react";
import {
    getApiKey, getKeyStatus, getDbDetails, getDisplaySettings, setDisplaySettings,
    getSearchHistory, clearHistoryBeforeDate, deleteHistoryEntry, clearAllHistory,
    getSetting, setSetting, openDbLocation, selectFolder, setDbPath,
    type DbDetails, type DisplaySettings, type HistoryEntry, type KeyStatus
} from "../api";
import { ApiKeyTab, type ApiSection } from "./settings/ApiKeyTab";
import { DatabaseTab } from "./settings/DatabaseTab";
import { WorkspaceTab } from "./settings/WorkspaceTab";
import { DisplayTab } from "./settings/DisplayTab";
import { ThemeTab } from "./settings/ThemeTab";
import { HistoryTab } from "./settings/HistoryTab";
import { PluginsTab } from "./settings/PluginsTab";
import { ExportTab } from "./settings/ExportTab";
import { SyncTab } from "./settings/SyncTab";
import { useFlags } from "../hooks/useFlags";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onStatusChange: (status: boolean) => void;
    onThemeChange?: (theme: string) => void;
    onVideoListModeChange: (mode: 'grid' | 'compact') => void;
    currentVideoListMode: 'grid' | 'compact';
    onNavigationOrientationChange: (orientation: 'horizontal' | 'vertical') => void;
    currentNavigationOrientation: 'horizontal' | 'vertical';
    onPluginsChange?: () => void;
    /** A sync (or pack import) finished: content, enforced settings or the license may have changed. */
    onSyncComplete?: () => void;
    showSummarizeOllama?: boolean;
    showSummarizeVenice?: boolean;
    showSynthesizeVenice?: boolean;
    showSynthesizePixabay?: boolean;
    showSynthesizeUpload?: boolean;
}

type Tab = 'api' | 'db' | 'workspace' | 'display' | 'theme' | 'history' | 'plugins' | 'sync' | 'export';

const TAB_CONFIG: { id: Tab; label: string; Icon: React.ElementType; badge?: string }[] = [
    { id: 'api',     label: 'API Key',  Icon: Key },
    { id: 'db',      label: 'Database', Icon: HardDrive },
    { id: 'workspace', label: 'Workspace', Icon: Layers },
    { id: 'display', label: 'Display',  Icon: Monitor },
    { id: 'theme',   label: 'Theme',    Icon: Palette },
    { id: 'history', label: 'History',  Icon: History },
    { id: 'plugins', label: 'Plugins',  Icon: Cpu },
    { id: 'sync',    label: 'Sync',     Icon: RefreshCw, badge: 'BETA' },
    { id: 'export',  label: 'Export',   Icon: FileDown },
];

export function SettingsModal({
    isOpen, onClose, onStatusChange, onThemeChange,
    onVideoListModeChange, currentVideoListMode,
    onNavigationOrientationChange, currentNavigationOrientation, onPluginsChange, onSyncComplete,
    showSummarizeOllama = true, showSummarizeVenice = true,
    showSynthesizeVenice = true, showSynthesizePixabay = true, showSynthesizeUpload = true
}: Props) {
    const { flags } = useFlags();
    // Tabs a DB owner has hidden are left out (see lib/flags.ts for how they depend on each other).
    // Sync is still in development, so it only shows in dev mode, never in a built app.
    const visibleTabs = TAB_CONFIG.filter(t => flags.tabVisible[t.id] && (import.meta.env.DEV || t.id !== 'sync'));
    const [activeTab, setActiveTab] = useState<Tab>('api');
    // If the tab on screen is hidden (a flag changed, or the first tab was never available), move
    // to the first one that is.
    useEffect(() => {
        if (!visibleTabs.some(t => t.id === activeTab) && visibleTabs.length > 0) setActiveTab(visibleTabs[0].id);
    }, [activeTab, visibleTabs]);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
    const [dbDetails, setDbDetails] = useState<DbDetails | null>(null);
    const [displaySettings, setDisplaySettingsState] = useState<DisplaySettings>({
        resolution: '1440x900', fullscreen: false, theme: 'dark', videoListMode: 'grid', navigationOrientation: 'horizontal'
    });
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [plugins, setPlugins] = useState([
        { id: 'summarize', name: 'Summarize Transcripts', enabled: false, description: 'Adds AI-powered summarization for transcripts using Local (Ollama) or Cloud (Venice) models.' },
        { id: 'photosynthesis', name: 'Photosynthesis', enabled: false, description: 'Enables markdown editing and photo tools (AI generation and local upload).' }
    ]);
    const [loading, setLoading] = useState(false);
    // Bumped after a sync so the values below (key status, plugin flags, display settings, which a
    // server may have changed) are re-read from the database.
    const [reloadTick, setReloadTick] = useState(0);
    // Which page of the API Key tab is showing; Plugins can send you straight to one.
    const [apiSection, setApiSection] = useState<ApiSection>('youtube');

    useEffect(() => {
        if (!isOpen) return;
        setLoading(true);
        Promise.all([
            getApiKey(),
            getDbDetails(),
            getDisplaySettings(),
            getSearchHistory(100),
            getSetting('plugin_summarize_enabled'),
            getSetting('plugin_photosynthesis_enabled'),
            getKeyStatus().catch(() => null),
        ]).then(([key, db, display, hist, summarizeEnabled, photoEnabled, keys]) => {
            setHasApiKey(!!key);
            setKeyStatus(keys);
            setDbDetails(db);
            setDisplaySettingsState(display);
            setHistory(hist);
            setPlugins(prev => prev.map(p => {
                if (p.id === 'summarize') return { ...p, enabled: summarizeEnabled === 'true' };
                if (p.id === 'photosynthesis') return { ...p, enabled: photoEnabled === 'true' };
                return p;
            }));
        }).catch(console.error).finally(() => setLoading(false));
    }, [isOpen, reloadTick]);

    if (!isOpen) return null;

    // Venice AI and Pixabay get an API Key page only while a plugin that can use them is on (and its part
    // of the plugin hasn't been turned off by a DB owner).
    const pluginOn = (id: string) => plugins.find(p => p.id === id)?.enabled ?? false;
    const showVeniceKey = (pluginOn('summarize') && showSummarizeVenice) || (pluginOn('photosynthesis') && showSynthesizeVenice);
    const showPixabayKey = pluginOn('photosynthesis') && showSynthesizePixabay;

    const handleUpdateDisplay = async (updates: Partial<DisplaySettings>) => {
        const newSettings = { ...displaySettings, ...updates };
        setDisplaySettingsState(newSettings);
        try {
            await setDisplaySettings(newSettings);
            if (updates.videoListMode) onVideoListModeChange(updates.videoListMode);
            if (updates.navigationOrientation) onNavigationOrientationChange(updates.navigationOrientation);
            if (updates.theme) onThemeChange?.(updates.theme);
        } catch (e) {
            console.error("Failed to apply display settings", e);
        }
    };

    const handleChangeDbLocation = async () => {
        setLoading(true);
        try {
            const folder = await selectFolder();
            if (folder) {
                await setDbPath(folder);
                setDbDetails(await getDbDetails());
            }
        } catch (e: any) {
            alert(`Error: ${e.message || e}`);
        } finally {
            setLoading(false);
        }
    };

    const handleTogglePlugin = async (id: string, newState: boolean) => {
        setLoading(true);
        try {
            await setSetting(`plugin_${id}_enabled`, newState.toString());
            setPlugins(prev => prev.map(p => p.id === id ? { ...p, enabled: newState } : p));
            onPluginsChange?.();
        } finally {
            setLoading(false);
        }
    };

    return (
        <div
            className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-2xl min-h-[450px] max-h-[85vh] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Settings className="w-5 h-5 text-gray-400" />
                        <h2 className="text-lg font-bold">Settings</h2>
                    </div>
                    <button onClick={onClose} className="text-[#aaaaaa] hover:text-white transition-colors cursor-pointer">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    {/* Sidebar */}
                    <div className="w-48 border-r border-[#303030] bg-white/5 py-4">
                        {visibleTabs.map(({ id, label, Icon, badge }) => (
                            <button
                                key={id}
                                onClick={() => setActiveTab(id)}
                                className={`w-full px-6 py-3 text-left flex items-center gap-3 transition-colors text-sm font-semibold cursor-pointer ${activeTab === id
                                    ? 'bg-[#303030] text-white border-l-4 border-red-600'
                                    : 'text-[#aaaaaa] hover:bg-[#202020] border-l-4 border-transparent'}`}
                            >
                                <Icon className="w-4 h-4" />
                                <span className="flex-1">{label}</span>
                                {badge && (
                                    // Right-aligned in the row, in the theme's accent color with light text. Set
                                    // through the theme variables directly (not the bg-red-600 class, which
                                    // changes color on hover) so it never changes color when hovered.
                                    <span
                                        className="shrink-0 px-2 py-1 rounded-[4px] text-[11px] font-bold tracking-wider leading-none"
                                        style={{ backgroundColor: 'var(--k-accent)', color: 'var(--k-text-on-accent)' }}
                                    >
                                        {badge}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Content. min-w-0: a flex item's default min-width is its content's natural width, not
                        0 — without this, this pane refuses to shrink below that as the window narrows and
                        pushes itself (and the modal) wider instead. overflow-x-hidden backs that up: with
                        only overflow-y set, the CSS spec computes overflow-x as auto too (never `visible`),
                        so anything that still doesn't shrink in time (a long unbreakable path, say) would
                        otherwise open a horizontal scrollbar of its own rather than just being clipped. */}
                    <div className="flex-1 min-w-0 p-8 overflow-y-auto overflow-x-hidden bg-[#0f0f0f]">
                        {loading && activeTab !== 'plugins' && activeTab !== 'sync' && (
                            <div className="text-center text-[#555] text-xs py-8">Loading...</div>
                        )}

                        {!loading && activeTab === 'api' && (
                            <ApiKeyTab
                                section={apiSection}
                                onSectionChange={setApiSection}
                                showVenice={showVeniceKey}
                                showPixabay={showPixabayKey}
                                hasKey={hasApiKey}
                                licensedBy={keyStatus?.youtube.licensed ? keyStatus.server_name || 'your sync server' : null}
                                // The app-wide "has API access" flag stays true when a license covers a removed own key.
                                onKeyChange={(val) => { setHasApiKey(val); onStatusChange(val || !!keyStatus?.youtube.licensed); }}
                            />
                        )}
                        {!loading && activeTab === 'db' && dbDetails && (
                            <DatabaseTab
                                dbDetails={dbDetails}
                                onOpen={openDbLocation}
                                onChangeLocation={handleChangeDbLocation}
                                loading={loading}
                            />
                        )}
                        {!loading && activeTab === 'workspace' && <WorkspaceTab />}
                        {!loading && activeTab === 'display' && (
                            <DisplayTab
                                settings={displaySettings}
                                currentVideoListMode={currentVideoListMode}
                                currentNavigationOrientation={currentNavigationOrientation}
                                onUpdate={handleUpdateDisplay}
                            />
                        )}
                        {!loading && activeTab === 'theme' && (
                            <ThemeTab
                                settings={displaySettings}
                                onUpdate={handleUpdateDisplay}
                            />
                        )}
                        {!loading && activeTab === 'history' && (
                            <HistoryTab
                                entries={history}
                                onDeleteEntry={async (id) => {
                                    await deleteHistoryEntry(id);
                                    setHistory(prev => prev.filter(e => e.id !== id));
                                }}
                                onClearDate={async (date) => {
                                    await clearHistoryBeforeDate(date);
                                    setHistory(prev => prev.filter(e => e.searchedAt.split(' ')[0] !== date));
                                }}
                                onClearAll={async () => {
                                    await clearAllHistory();
                                    setHistory([]);
                                }}
                                onRetentionChange={async () => {
                                    // The list is trimmed as it's read, so this reflects the new period.
                                    setHistory(await getSearchHistory(100));
                                }}
                            />
                        )}
                        {/* Like Plugins, keeps its own state across reloads, so it isn't behind the loading guard. */}
                        {activeTab === 'sync' && (
                            <SyncTab
                                onSyncComplete={() => {
                                    setReloadTick(t => t + 1);
                                    onSyncComplete?.();
                                }}
                            />
                        )}
                        {!loading && activeTab === 'export' && (
                            <ExportTab />
                        )}
                        {activeTab === 'plugins' && (
                            <PluginsTab
                                plugins={plugins.filter(p => {
                                    if (p.id === 'summarize') return showSummarizeOllama || showSummarizeVenice;
                                    if (p.id === 'photosynthesis') return showSynthesizeVenice || showSynthesizePixabay || showSynthesizeUpload;
                                    return true;
                                })}
                                onTogglePlugin={handleTogglePlugin}
                                loading={loading}
                                showSummarizeOllama={showSummarizeOllama}
                                showSummarizeVenice={showSummarizeVenice}
                                onOpenVeniceSettings={flags.tabVisible.api ? () => { setApiSection('venice'); setActiveTab('api'); } : undefined}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
