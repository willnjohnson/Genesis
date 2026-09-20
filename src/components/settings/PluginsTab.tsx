import { Cpu, ArrowRight, FolderTree } from "lucide-react";
import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
    setSetting, getSetting,
    checkOllama, checkModelPulled, pullModel, deleteModel, installOllama,
    getOllamaPrompt, setOllamaPrompt as saveOllamaPrompt,
    getKeyStatus,
} from "../../api";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useLockedSettings, LOCKED_TITLE } from "../../hooks/useLockedSettings";
import { useFlags } from "../../hooks/useFlags";
import { PromptEditor, DefaultBadge, TooltipLightbulb } from "./pluginShared";
import { settingsPrimaryBtn, settingsSecondaryBtn } from "./buttons";

// ─── Local (Ollama) sub-tab ─────────────────────────────────────────────────

interface OllamaProps {
    summarizeProvider: string;
    onSetDefault: () => void;
}

function OllamaSubTab({ summarizeProvider, onSetDefault }: OllamaProps) {
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [isInstalled, setIsInstalled] = useState(false);
    const [isPulled, setIsPulled] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [dirty, setDirty] = useState(false);
    // A DB owner can take away installing Ollama and pulling or removing its model.
    const { flags } = useFlags();

    useEffect(() => {
        getOllamaPrompt().then(setPrompt);
        checkOllama().then(running => {
            setIsInstalled(running);
            if (running) checkModelPulled().then(setIsPulled);
        });
    }, []);

    // Listen for plugin progress events
    useEffect(() => {
        const unlisten = listen("plugin_progress", (event) => setStatus(event.payload as string));
        return () => { unlisten.then(fn => fn()); };
    }, []);

    const handleInstallOrPull = async () => {
        setLoading(true);
        setStatus("Checking Ollama...");
        try {
            const running = await checkOllama();
            if (!running) {
                await installOllama();
                setStatus("Waiting for Ollama to start...");
                let retry = 0;
                while (retry < 60) {
                    await new Promise(r => setTimeout(r, 2000));
                    if (await checkOllama()) break;
                    retry++;
                }
                setIsInstalled(true);
            }
            await pullModel();
            setIsPulled(true);
            setStatus(null);
        } catch (err) {
            setStatus(String(err));
        } finally {
            setLoading(false);
        }
    };

    const handleRemoveModel = async () => {
        if (!window.confirm("Are you sure you want to remove the local model files?")) return;
        setLoading(true);
        setStatus("Removing model...");
        try {
            await deleteModel();
            setIsPulled(false);
            setStatus(null);
        } catch (err) {
            setStatus(String(err));
        } finally {
            setLoading(false);
        }
    };

    const handleSavePrompt = async () => {
        await saveOllamaPrompt(prompt);
        setDirty(false);
    };

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-left-2 duration-300">
            {/* Engine status */}
            <div className="bg-black/20 p-4 rounded-lg border border-[#303030]">
                <span className="text-xs font-bold text-white block mb-3">Ollama Engine</span>
                <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[#aaaaaa]">
                        {!isInstalled ? 'Not Installed' : isPulled ? 'Installed & Ready' : 'Model not downloaded'}
                    </span>
                    <div className="flex items-center gap-2">
                        {flags.allowOllamaSetup && (!isPulled ? (
                            <button
                                onClick={handleInstallOrPull}
                                disabled={loading}
                                className={settingsPrimaryBtn}
                            >
                                Pull Model
                            </button>
                        ) : (
                            <button
                                onClick={handleRemoveModel}
                                disabled={loading}
                                className={settingsPrimaryBtn}
                            >
                                Remove Model
                            </button>
                        ))}
                        {summarizeProvider === 'local'
                            ? <DefaultBadge />
                            : (
                                <button
                                    onClick={onSetDefault}
                                    className={settingsSecondaryBtn}
                                >
                                    Make Default
                                </button>
                            )
                        }
                    </div>
                </div>
            </div>

            {/* Progress */}
            {status && (
                <div className="p-2.5 bg-red-600/10 border border-red-600/20 rounded-lg flex items-center gap-2">
                    <div className="w-2.5 h-2.5 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
                    <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">{status}</span>
                </div>
            )}

            {/* Prompt */}
            <PromptEditor
                label="Local Prompt Template (Default)"
                value={prompt}
                onChange={(v) => { setPrompt(v); setDirty(true); }}
                onSave={handleSavePrompt}
                dirty={dirty}
            />
        </div>
    );
}

// ─── Cloud (Venice) sub-tab ──────────────────────────────────────────────────

interface VeniceProps {
    summarizeProvider: string;
    onSetDefault: () => void;
    /** Opens API Key > Venice AI, where the key, model and prompt template are set. Absent when that tab is hidden. */
    onOpenVeniceSettings?: () => void;
}

// The key, the model and the prompt template are set under API Key > Venice AI (they're shared with the
// image tools). This tab only says whether cloud summaries are ready, links there, and picks the default.
function VeniceSubTab({ summarizeProvider, onSetDefault, onOpenVeniceSettings }: VeniceProps) {
    const [ready, setReady] = useState<boolean | null>(null);

    useEffect(() => {
        getKeyStatus().then(s => setReady(s.venice.available)).catch(() => setReady(null));
    }, []);

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-right-2 duration-300">
            <div className="bg-black/20 p-4 rounded-lg border border-[#303030]">
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        <span className="text-xs font-bold text-white block mb-1">Venice AI</span>
                        <p className="text-[10px] text-[#aaaaaa] leading-relaxed">
                            {ready === false
                                ? "Needs an API key before it can summarize."
                                : ready === true
                                    ? "Ready. The model and prompt template are set in the API Key settings."
                                    : "The API key, model and prompt template are set in the API Key settings."}
                        </p>
                        {onOpenVeniceSettings && (
                            <button
                                onClick={onOpenVeniceSettings}
                                className="mt-2 inline-flex items-center gap-1 text-[11px] text-[#aaaaaa] hover:text-white underline cursor-pointer"
                            >
                                Venice AI settings
                                <ArrowRight className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                    <div className="shrink-0">
                        {summarizeProvider === 'cloud'
                            ? <DefaultBadge />
                            : (
                                <button
                                    onClick={onSetDefault}
                                    className={settingsSecondaryBtn}
                                >
                                    Make Default
                                </button>
                            )
                        }
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Warp Drive editing toggle ────────────────────────────────────────────────

// Self-contained (loads/saves its own setting directly) rather than threaded through
// SettingsModal's props, mirroring the "Clear Transcript After Summarizing" toggle above.
// Gates the pencil/"Also in" editing controls in Sidebar.tsx's Warp Drive section — off by
// default (see schema.rs's "allowEditWDBS" seed value) since taxonomy edits are eventually meant
// to be restricted to IKLAO Admin Users once the IKLAO Cloud is stood up, but there's no such
// auth yet, so this is how to turn editing on in the meantime.
function WarpDriveSection() {
    const { labels } = useWorkspace();
    const [allowEdit, setAllowEdit] = useState(false);
    const isLocked = useLockedSettings();
    const locked = isLocked('allowEditWDBS');

    useEffect(() => {
        getSetting('allowEditWDBS').then(v => setAllowEdit(v === 'true'));
    }, []);

    const toggle = async () => {
        if (locked) return;
        const next = !allowEdit;
        setAllowEdit(next);
        await setSetting('allowEditWDBS', next.toString());
    };

    return (
        <div className="bg-[#121212] border border-[#303030] rounded-xl p-5 hover:border-[#404040] transition-all">
            <div className="flex items-start justify-between">
                <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                        <div className="p-2 text-gray-400"><FolderTree className="w-4 h-4" /></div>
                        <h4 className="text-sm font-bold text-white">{labels.aliasDriveName} Editing</h4>
                    </div>
                    <p className="text-[11px] text-[#aaaaaa] leading-relaxed max-w-sm">
                        Lets you assign, change, and symlink a saved video's {labels.aliasDriveName} designator from its detail panel. Off by default.
                    </p>
                </div>
                <div className="ml-6 shrink-0">
                    <button
                        onClick={toggle}
                        disabled={locked}
                        title={locked ? LOCKED_TITLE : undefined}
                        className={allowEdit ? settingsSecondaryBtn : settingsPrimaryBtn}
                    >
                        {allowEdit ? 'Disable' : 'Enable'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Plugin card wrapper ──────────────────────────────────────────────────────

interface Plugin {
    id: string;
    name: string;
    enabled: boolean;
    description: string;
}

interface Props {
    plugins: Plugin[];
    onTogglePlugin: (id: string, newState: boolean) => void;
    loading: boolean;
    showSummarizeOllama?: boolean;
    showSummarizeVenice?: boolean;
    /** Jumps to API Key > Venice AI (left out when the API Key tab is hidden). */
    onOpenVeniceSettings?: () => void;
}

export function PluginsTab({ plugins, onTogglePlugin, loading, showSummarizeOllama = true, showSummarizeVenice = true, onOpenVeniceSettings }: Props) {
    const [summarizeTab, setSummarizeTab] = useState<'local' | 'cloud'>('local');
    const [summarizeProvider, setSummarizeProvider] = useState<string>('local');
    const [showCustomPrompt, setShowCustomPrompt] = useState(true);
    const [clearTranscriptOnSummarize, setClearTranscriptOnSummarize] = useState(false);
    const isLocked = useLockedSettings();

    useEffect(() => {
        if (summarizeTab === 'local' && !showSummarizeOllama) {
            if (showSummarizeVenice) setSummarizeTab('cloud');
        } else if (summarizeTab === 'cloud' && !showSummarizeVenice) {
            if (showSummarizeOllama) setSummarizeTab('local');
        }
    }, [summarizeTab, showSummarizeOllama, showSummarizeVenice]);

    useEffect(() => {
        import("../../api").then(({ getSetting }) => {
            getSetting('summarize_provider').then(p => setSummarizeProvider(p || 'local'));
            getSetting('showCustomPrompt').then(v => setShowCustomPrompt(v !== 'false'));
            getSetting('setTranscriptAfterSummarizeToNA').then(v => setClearTranscriptOnSummarize(v === 'true'));
        });
    }, []);

    const setDefault = async (provider: string) => {
        if (isLocked('summarize_provider')) return;
        setSummarizeProvider(provider);
        await setSetting('summarize_provider', provider);
    };

    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-1">Plugins</h3>
                <p className="text-xs text-[#aaaaaa] mb-6">
                    Extend the app with modular functionalities powered by external services.
                </p>
                <div className="space-y-4">
                    <WarpDriveSection />
                    {plugins.map(plugin => (
                        <div key={plugin.id} className="bg-[#121212] border border-[#303030] rounded-xl p-5 hover:border-[#404040] transition-all">
                            <div className="flex items-start justify-between">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                        <div className="p-2 text-gray-400"><Cpu className="w-4 h-4" /></div>
                                        <h4 className="text-sm font-bold text-white">{plugin.name}</h4>
                                    </div>
                                    <p className="text-[11px] text-[#aaaaaa] leading-relaxed max-w-sm mb-4">{plugin.description}</p>
                                </div>
                                <div className="ml-6 shrink-0">
                                    <button
                                        onClick={() => onTogglePlugin(plugin.id, !plugin.enabled)}
                                        disabled={loading || isLocked(`plugin_${plugin.id}_enabled`)}
                                        title={isLocked(`plugin_${plugin.id}_enabled`) ? LOCKED_TITLE : undefined}
                                        className={plugin.enabled ? settingsSecondaryBtn : settingsPrimaryBtn}
                                    >
                                        {plugin.enabled ? 'Disable' : 'Enable'}
                                    </button>
                                </div>
                            </div>

                            {/* Summarize plugin settings */}
                            {plugin.id === 'summarize' && plugin.enabled && (
                                <div className="mt-6 pt-6 border-t border-[#303030]">
                                    {/* Show Custom Prompt Toggle */}
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-bold text-white">Show Custom Prompt in Sidebar</span>
                                            <TooltipLightbulb />
                                        </div>
                                        <button
                                            onClick={async () => {
                                                const newValue = !showCustomPrompt;
                                                setShowCustomPrompt(newValue);
                                                await setSetting('showCustomPrompt', newValue.toString());
                                            }}
                                            disabled={isLocked('showCustomPrompt')}
                                            title={isLocked('showCustomPrompt') ? LOCKED_TITLE : undefined}
                                            className={`w-10 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default ${showCustomPrompt ? 'bg-blue-600' : 'bg-[#333333]'}`}
                                        >
                                            <div className={`w-4 h-4 bg-white rounded-full transition-transform ${showCustomPrompt ? 'translate-x-5' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>

                                    {/* Clear Transcript After Summarizing Toggle */}
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="flex items-center gap-2">
                                            <span
                                                className="text-xs font-bold text-white"
                                                title="When enabled, a video's transcript is replaced with 'N/A' once it has a real AI summary, to free up database space. When disabled, the full transcript is kept."
                                            >
                                                Clear Transcript After Summarizing
                                            </span>
                                        </div>
                                        <button
                                            onClick={async () => {
                                                const newValue = !clearTranscriptOnSummarize;
                                                setClearTranscriptOnSummarize(newValue);
                                                await setSetting('setTranscriptAfterSummarizeToNA', newValue.toString());
                                            }}
                                            disabled={isLocked('setTranscriptAfterSummarizeToNA')}
                                            title={isLocked('setTranscriptAfterSummarizeToNA') ? LOCKED_TITLE : undefined}
                                            className={`w-10 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default ${clearTranscriptOnSummarize ? 'bg-blue-600' : 'bg-[#333333]'}`}
                                        >
                                            <div className={`w-4 h-4 bg-white rounded-full transition-transform ${clearTranscriptOnSummarize ? 'translate-x-5' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>

                                    {/* Sub-tabs */}
                                    <div className="flex gap-4 mb-4 border-b border-[#303030]">
                                        {showSummarizeOllama && (
                                            <button
                                                onClick={() => setSummarizeTab('local')}
                                                className={`pb-2 text-xs font-bold transition-all cursor-pointer relative ${summarizeTab === 'local' ? 'text-white' : 'text-[#555] hover:text-[#aaaaaa]'}`}
                                            >
                                                Local (Ollama)
                                                {summarizeTab === 'local' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                            </button>
                                        )}
                                        {showSummarizeVenice && (
                                            <button
                                                onClick={() => setSummarizeTab('cloud')}
                                                className={`pb-2 text-xs font-bold transition-all cursor-pointer relative ${summarizeTab === 'cloud' ? 'text-white' : 'text-[#555] hover:text-[#aaaaaa]'}`}
                                            >
                                                Cloud (Venice)
                                                {summarizeTab === 'cloud' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                            </button>
                                        )}
                                    </div>

                                    <div className={summarizeTab === 'local' ? 'block' : 'hidden'}>
                                        <OllamaSubTab summarizeProvider={summarizeProvider} onSetDefault={() => setDefault('local')} />
                                    </div>
                                    <div className={summarizeTab === 'cloud' ? 'block' : 'hidden'}>
                                        <VeniceSubTab summarizeProvider={summarizeProvider} onSetDefault={() => setDefault('cloud')} onOpenVeniceSettings={onOpenVeniceSettings} />
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
