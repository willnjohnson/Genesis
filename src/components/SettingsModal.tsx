import { X, Settings, Key, HardDrive, Monitor, History, Cpu } from "lucide-react";
import { useState, useEffect } from "react";
import { BRAND } from '../branding';
import {
    getApiKey, getDbDetails, getDisplaySettings, setDisplaySettings,
    getSearchHistory, clearHistoryBeforeDate, deleteHistoryEntry, clearAllHistory,
    getSetting, setSetting, openDbLocation, selectFolder, setDbPath,
    type DbDetails, type DisplaySettings, type HistoryEntry
} from "../api";
import { ApiKeyTab } from "./settings/ApiKeyTab";
import { DatabaseTab } from "./settings/DatabaseTab";
import { DisplayTab } from "./settings/DisplayTab";
import { HistoryTab } from "./settings/HistoryTab";
import { PluginsTab } from "./settings/PluginsTab";

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
    showSummarizeOllama?: boolean;
    showSummarizeVenice?: boolean;
    showSynthesizeVenice?: boolean;
    showSynthesizePixabay?: boolean;
    showSynthesizeUpload?: boolean;
}

type Tab = 'api' | 'db' | 'display' | 'history' | 'plugins';

const TAB_CONFIG: { id: Tab; label: string; Icon: React.ElementType }[] = [
    { id: 'api',     label: 'API Key',  Icon: Key },
    { id: 'db',      label: 'Database', Icon: HardDrive },
    { id: 'display', label: 'Display',  Icon: Monitor },
    { id: 'history', label: 'History',  Icon: History },
    { id: 'plugins', label: 'Plugins',  Icon: Cpu },
];

export function SettingsModal({
    isOpen, onClose, onStatusChange, onThemeChange,
    onVideoListModeChange, currentVideoListMode,
    onNavigationOrientationChange, currentNavigationOrientation, onPluginsChange,
    showSummarizeOllama = true, showSummarizeVenice = true,
    showSynthesizeVenice = true, showSynthesizePixabay = true, showSynthesizeUpload = true
}: Props) {
    const [activeTab, setActiveTab] = useState<Tab>('api');
    const [hasApiKey, setHasApiKey] = useState(false);
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
        ]).then(([key, db, display, hist, summarizeEnabled, photoEnabled]) => {
            setHasApiKey(!!key);
            setDbDetails(db);
            setDisplaySettingsState(display);
            setHistory(hist);
            setPlugins(prev => prev.map(p => {
                if (p.id === 'summarize') return { ...p, enabled: summarizeEnabled === 'true' };
                if (p.id === 'photosynthesis') return { ...p, enabled: photoEnabled === 'true' };
                return p;
            }));
        }).catch(console.error).finally(() => setLoading(false));
    }, [isOpen]);

    if (!isOpen) return null;

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
                const newPath = await setDbPath(folder);
                localStorage.setItem(BRAND.storageKey, newPath);
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
                        {TAB_CONFIG.map(({ id, label, Icon }) => (
                            <button
                                key={id}
                                onClick={() => setActiveTab(id)}
                                className={`w-full px-6 py-3 text-left flex items-center gap-3 transition-colors text-sm font-semibold cursor-pointer ${activeTab === id
                                    ? 'bg-[#303030] text-white border-l-4 border-red-600'
                                    : 'text-[#aaaaaa] hover:bg-[#202020] border-l-4 border-transparent'}`}
                            >
                                <Icon className="w-4 h-4" />
                                {label}
                            </button>
                        ))}
                    </div>

                    {/* Content */}
                    <div className="flex-1 p-8 overflow-y-auto bg-[#0f0f0f]">
                        {loading && activeTab !== 'plugins' && (
                            <div className="text-center text-[#555] text-xs py-8">Loading...</div>
                        )}

                        {!loading && activeTab === 'api' && (
                            <ApiKeyTab
                                hasKey={hasApiKey}
                                onKeyChange={(val) => { setHasApiKey(val); onStatusChange(val); }}
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
                        {!loading && activeTab === 'display' && (
                            <DisplayTab
                                settings={displaySettings}
                                currentVideoListMode={currentVideoListMode}
                                currentNavigationOrientation={currentNavigationOrientation}
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
                            />
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
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
