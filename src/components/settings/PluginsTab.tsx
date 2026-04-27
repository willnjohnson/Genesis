import { Cpu, Check, Save, Terminal, Lightbulb } from "lucide-react";
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import {
    setSetting,
    checkOllama, checkModelPulled, pullModel, deleteModel, installOllama,
    getOllamaPrompt, setOllamaPrompt as saveOllamaPrompt,
    getVeniceApiKey, getVenicePrompt, setVenicePrompt as saveVenicePromptCmd,
} from "../../api";

// ─── Shared sub-components ───────────────────────────────────────────────────

function PromptEditor({
    label,
    value,
    onChange,
    onSave,
    dirty,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    onSave: () => void;
    dirty: boolean;
}) {
    return (
        <div>
            <label className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-2">{label}</label>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="Create a synopsis of this video transcript with pretty format."
                className="w-full h-80 bg-[#1a1a1a] border border-[#303030] text-sm text-white rounded-lg px-3 py-2.5 outline-none hover:bg-[#202020] transition-colors resize-y font-mono text-[11px]"
            />
            <div className="flex items-center justify-between mt-2">
                {dirty && (
                    <button
                        onClick={onSave}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-[10px] font-bold transition-colors cursor-pointer"
                    >
                        <Save className="w-3 h-3" />
                        Save
                    </button>
                )}
            </div>
        </div>
    );
}

function DefaultBadge() {
    return (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/10 border border-green-500/30 text-green-400 rounded-md text-[10px] font-bold">
            <Check className="w-3 h-3" />
            Default
        </div>
    );
}

function TooltipLightbulb() {
    const [isHovered, setIsHovered] = useState(false);
    const [rect, setRect] = useState<DOMRect | null>(null);

    return (
        <div 
            className="relative flex items-center"
            onMouseEnter={(e) => {
                setRect(e.currentTarget.getBoundingClientRect());
                setIsHovered(true);
            }}
            onMouseLeave={() => setIsHovered(false)}
        >
            <Lightbulb className="w-3.5 h-3.5 text-[#666666] hover:text-orange-400 transition-colors cursor-help" />
            {isHovered && rect && createPortal(
                <div 
                    className="fixed z-[999999] w-80 bg-[#1a1a1a] shadow-2xl p-4 rounded-xl border border-[#333] pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-200"
                    style={{ 
                        top: rect.top - 12, 
                        left: rect.left, 
                        transform: 'translateY(-100%)'
                    }}
                >
                    <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-3 border-b border-[#333] pb-2 flex items-center gap-2">
                        <Terminal className="w-3.5 h-3.5" />
                        Supported Variables
                    </h4>
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 gap-1.5 pt-1 text-[11px]">
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${title}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">Video title</span>
                            </code>
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${author}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">Channel name</span>
                            </code>
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${handle}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">Channel handle</span>
                            </code>
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${length_seconds}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">Video length</span>
                            </code>
                            <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                <span>{"${view_count}"}:</span>
                                <span className="text-gray-500 group-hover/code:text-gray-300">View count</span>
                            </code>
                        </div>
                        <p className="text-[10px] text-gray-400 leading-relaxed italic">
                            These variables substitute dynamically when generating a summary from the library.
                        </p>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}

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
                        {!isPulled ? (
                            <button
                                onClick={handleInstallOrPull}
                                disabled={loading}
                                className="px-3 py-1.5 bg-red-600 text-white hover:bg-red-500 rounded-md text-[10px] font-bold transition-all cursor-pointer disabled:opacity-50"
                            >
                                Pull Model
                            </button>
                        ) : (
                            <button
                                onClick={handleRemoveModel}
                                disabled={loading}
                                className="px-3 py-1.5 bg-red-600 text-white hover:bg-red-500 rounded-md text-[10px] font-bold transition-all cursor-pointer disabled:opacity-50"
                            >
                                Remove Model
                            </button>
                        )}
                        {summarizeProvider === 'local'
                            ? <DefaultBadge />
                            : (
                                <button
                                    onClick={onSetDefault}
                                    className="px-3 py-1.5 bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white rounded-md text-[10px] font-semibold transition-colors cursor-pointer"
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
}

function VeniceSubTab({ summarizeProvider, onSetDefault }: VeniceProps) {
    const [loading, setLoading] = useState(false);
    const [hasKey, setHasKey] = useState(false);
    const [keyInput, setKeyInput] = useState('');
    const [prompt, setPrompt] = useState('');
    const [promptDirty, setPromptDirty] = useState(false);

    useEffect(() => {
        getVeniceApiKey().then(k => setHasKey(!!k));
        getVenicePrompt().then(setPrompt);
    }, []);

    const handleSaveKey = async () => {
        const key = keyInput.trim();
        if (!key) return;
        setLoading(true);
        setHasKey(true);
        const original = keyInput;
        setKeyInput('');
        try {
            await setSetting("venice_api_key", key);
        } catch {
            setHasKey(false);
            setKeyInput(original);
            alert("Failed to save Venice API Key.");
        } finally {
            setLoading(false);
        }
    };

    const handleRemoveKey = async () => {
        setLoading(true);
        setHasKey(false);
        try {
            await setSetting("venice_api_key", "");
        } catch {
            setHasKey(true);
            alert("Failed to remove Venice API Key.");
        } finally {
            setLoading(false);
        }
    };

    const handleSavePrompt = async () => {
        await saveVenicePromptCmd(prompt);
        setPromptDirty(false);
    };

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-right-2 duration-300">
            {/* API Key */}
            <div className="bg-black/20 p-4 rounded-lg border border-[#303030]">
                <span className="text-xs font-bold text-white block mb-3">Venice API Key</span>
                <div className="flex items-center justify-between">
                    <div className="flex-1 mr-4">
                        {hasKey
                            ? <span className="text-[10px] text-[#aaaaaa]">Activated &amp; Ready</span>
                            : (
                                <input
                                    type="password"
                                    placeholder="Paste Venice API key..."
                                    value={keyInput}
                                    onChange={(e) => setKeyInput(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && keyInput.trim()) handleSaveKey(); }}
                                    className="w-full bg-[#1a1a1a] border border-[#303030] hover:border-[#505050] outline-none rounded-lg px-3 py-2 text-[11px] text-white placeholder-[#444] transition-colors"
                                />
                            )
                        }
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {hasKey ? (
                            <button
                                onClick={handleRemoveKey}
                                disabled={loading}
                                className="bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white px-3 py-1.5 rounded-md font-semibold text-[10px] transition-colors cursor-pointer disabled:opacity-50"
                            >
                                Deactivate
                            </button>
                        ) : (
                            <button
                                onClick={handleSaveKey}
                                disabled={loading || !keyInput.trim()}
                                className="bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-md font-bold text-[10px] transition-colors cursor-pointer disabled:opacity-50"
                            >
                                Activate
                            </button>
                        )}
                        {summarizeProvider === 'cloud'
                            ? <DefaultBadge />
                            : (
                                <button
                                    onClick={onSetDefault}
                                    className="px-3 py-1.5 bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white rounded-md text-[10px] font-semibold transition-colors cursor-pointer"
                                >
                                    Make Default
                                </button>
                            )
                        }
                    </div>
                </div>
            </div>

            {/* Prompt */}
            <PromptEditor
                label="Cloud Prompt Template (Default)"
                value={prompt}
                onChange={(v) => { setPrompt(v); setPromptDirty(true); }}
                onSave={handleSavePrompt}
                dirty={promptDirty}
            />
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
}

export function PluginsTab({ plugins, onTogglePlugin, loading, showSummarizeOllama = true, showSummarizeVenice = true }: Props) {
    const [summarizeTab, setSummarizeTab] = useState<'local' | 'cloud'>('local');
    const [summarizeProvider, setSummarizeProvider] = useState<string>('local');
    const [showCustomPrompt, setShowCustomPrompt] = useState(true);

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
        });
    }, []);

    const setDefault = async (provider: string) => {
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
                                        disabled={loading}
                                        className={`px-4 py-2.5 rounded-lg font-bold text-xs transition-colors cursor-pointer disabled:opacity-50 ${plugin.enabled ? 'bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white font-semibold' : 'bg-red-600 text-white hover:bg-red-500'}`}
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
                                            className={`w-10 h-5 rounded-full transition-colors cursor-pointer ${showCustomPrompt ? 'bg-blue-600' : 'bg-[#333333]'}`}
                                        >
                                            <div className={`w-4 h-4 bg-white rounded-full transition-transform ${showCustomPrompt ? 'translate-x-5' : 'translate-x-0.5'}`} />
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
                                        <VeniceSubTab summarizeProvider={summarizeProvider} onSetDefault={() => setDefault('cloud')} />
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
