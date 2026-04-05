import { Cpu, Check, Save } from "lucide-react";
import { useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
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
                className="w-full h-24 bg-[#1a1a1a] border border-[#303030] text-sm text-white rounded-lg px-3 py-2.5 outline-none hover:bg-[#202020] transition-colors resize-none font-mono text-[11px]"
            />
            <div className="flex items-center justify-between mt-2">
                {dirty && (
                    <button
                        onClick={onSave}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-[10px] font-bold transition-colors cursor-pointer shadow-lg shadow-blue-900/10"
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
                                className="px-3 py-1.5 bg-red-600 text-white hover:bg-red-500 rounded-md text-[10px] font-bold transition-all cursor-pointer disabled:opacity-50 shadow-lg shadow-red-900/10"
                            >
                                Pull Model
                            </button>
                        ) : (
                            <button
                                onClick={handleRemoveModel}
                                disabled={loading}
                                className="px-3 py-1.5 bg-red-600 text-white hover:bg-red-500 rounded-md text-[10px] font-bold transition-all cursor-pointer shadow-lg shadow-red-900/10 disabled:opacity-50"
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
                label="Local Prompt Template"
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
                                className="bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-md font-bold text-[10px] transition-colors cursor-pointer disabled:opacity-50 shadow-lg shadow-red-900/10"
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
                label="Cloud Prompt Template"
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
}

export function PluginsTab({ plugins, onTogglePlugin, loading }: Props) {
    const [summarizeTab, setSummarizeTab] = useState<'local' | 'cloud'>('local');
    const [summarizeProvider, setSummarizeProvider] = useState<string>('local');

    useEffect(() => {
        import("../../api").then(({ getSetting }) => {
            getSetting('summarize_provider').then(p => setSummarizeProvider(p || 'local'));
        });
    }, []);

    const setDefault = async (provider: string) => {
        setSummarizeProvider(provider);
        await setSetting('summarize_provider', provider);
    };

    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-1">External Plugins</h3>
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
                                        className={`px-4 py-2.5 rounded-lg font-bold text-xs transition-colors cursor-pointer disabled:opacity-50 ${plugin.enabled ? 'bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white font-semibold' : 'bg-red-600 text-white hover:bg-red-500 shadow-lg shadow-red-900/10'}`}
                                    >
                                        {plugin.enabled ? 'Disable' : 'Enable'}
                                    </button>
                                </div>
                            </div>

                            {/* Summarize plugin settings */}
                            {plugin.id === 'summarize' && plugin.enabled && (
                                <div className="mt-6 pt-6 border-t border-[#303030]">
                                    {/* Sub-tabs */}
                                    <div className="flex gap-4 mb-4 border-b border-[#303030]">
                                        {(['local', 'cloud'] as const).map(t => (
                                            <button
                                                key={t}
                                                onClick={() => setSummarizeTab(t)}
                                                className={`pb-2 text-xs font-bold transition-all cursor-pointer relative ${summarizeTab === t ? 'text-white' : 'text-[#555] hover:text-[#aaaaaa]'}`}
                                            >
                                                {t === 'local' ? 'Local (Ollama)' : 'Cloud (Venice)'}
                                                {summarizeTab === t && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                                            </button>
                                        ))}
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
