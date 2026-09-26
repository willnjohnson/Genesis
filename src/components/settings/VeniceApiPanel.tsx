import { Check, Info } from "lucide-react";
import { useEffect, useState } from "react";
import {
    getKeyStatus, getSetting, getVeniceApiKey, getVenicePrompt, setSetting,
    setVenicePrompt as saveVenicePromptCmd, type KeyStatus,
} from "../../api";
import { useLockedSettings, LOCKED_TITLE } from "../../hooks/useLockedSettings";
import { DEFAULT_VENICE_MODEL } from "../../lib/venice";
import { ApiKeyField } from "./ApiKeyField";
import { ApiPanelHeading, API_GUIDES } from "./ApiPanelHeading";
import { settingsSecondaryBtn } from "./buttons";
import { PromptEditor, TooltipLightbulb } from "./pluginShared";

/** Venice AI: the API key, which model to use, and the prompt template for cloud summaries. */
export function VeniceApiPanel() {
    const [hasKey, setHasKey] = useState(false);
    const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
    const [prompt, setPrompt] = useState("");
    const [promptDirty, setPromptDirty] = useState(false);
    const [model, setModel] = useState(DEFAULT_VENICE_MODEL);
    const [modelInput, setModelInput] = useState("");
    const [modelSaved, setModelSaved] = useState(false);
    const [modelBusy, setModelBusy] = useState(false);
    const isLocked = useLockedSettings();
    const modelLocked = isLocked("venice_model");

    useEffect(() => {
        getKeyStatus().then(setKeyStatus).catch(() => {});
        getVeniceApiKey().then(k => setHasKey(!!k));
        getVenicePrompt().then(setPrompt);
        getSetting("venice_model").then(m => {
            const resolved = m && m.trim() ? m : DEFAULT_VENICE_MODEL;
            setModel(resolved);
            setModelInput(resolved);
        });
    }, []);

    const saveModel = async () => {
        const next = modelInput.trim() || DEFAULT_VENICE_MODEL;
        setModelBusy(true);
        try {
            await setSetting("venice_model", next);
            setModel(next);
            setModelInput(next);
            setModelSaved(true);
            window.setTimeout(() => setModelSaved(false), 1500);
        } catch {
            alert("Failed to save Venice model.");
        } finally {
            setModelBusy(false);
        }
    };

    const savePrompt = async () => {
        await saveVenicePromptCmd(prompt);
        setPromptDirty(false);
    };

    return (
        <div className="space-y-6">
            <div>
                <ApiPanelHeading
                    title="Venice AI"
                    guideUrl={API_GUIDES.venice.url}
                    costNote={API_GUIDES.venice.costNote}
                />
                <p className="text-xs text-[#aaaaaa] mb-4">Powers cloud summaries and AI image generation.</p>

                {keyStatus?.venice.licensed && (
                    <div className="mb-4 flex items-start gap-2 text-blue-300 bg-blue-900/10 border border-blue-500/30 rounded-lg px-3 py-2.5 text-xs leading-relaxed">
                        <Info className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>
                            Covered by {keyStatus.server_name || "your sync server"}'s license, so you don't need your own key.
                            {keyStatus.venice.own_key && !keyStatus.venice.via_license ? " Your own key is used instead." : ""}
                        </span>
                    </div>
                )}

                <ApiKeyField
                    hasKey={hasKey}
                    placeholder="Paste your Venice API key"
                    onSave={async (key) => { await setSetting("venice_api_key", key); setHasKey(true); }}
                    onRemove={async () => { await setSetting("venice_api_key", ""); setHasKey(false); }}
                />
            </div>

            <div className="bg-black/20 p-4 rounded-lg border border-[#303030]">
                <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs font-bold text-white">Venice Model</span>
                </div>
                <p className="text-[10px] text-[#aaaaaa] mb-3">
                    Venice periodically renames or retires models (e.g. an older GLM release in favor of a newer one). If summaries start failing, check Venice's current model list and update this.
                </p>
                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        placeholder={DEFAULT_VENICE_MODEL}
                        value={modelInput}
                        onChange={(e) => setModelInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !modelLocked) void saveModel(); }}
                        disabled={modelLocked}
                        title={modelLocked ? LOCKED_TITLE : undefined}
                        className="flex-1 bg-[#1a1a1a] border border-[#303030] hover:border-[#505050] outline-none rounded-lg px-3 py-2 text-[11px] text-white placeholder-[#444] transition-colors font-mono disabled:opacity-50"
                    />
                    <button
                        onClick={saveModel}
                        disabled={modelLocked || modelBusy || !modelInput.trim() || modelInput.trim() === model}
                        className={`${settingsSecondaryBtn} shrink-0`}
                    >
                        {modelSaved ? <Check className="w-3.5 h-3.5" /> : "Save"}
                    </button>
                </div>
            </div>

            <PromptEditor
                label="Cloud Prompt Template (Default)"
                value={prompt}
                onChange={(v) => { setPrompt(v); setPromptDirty(true); }}
                onSave={savePrompt}
                dirty={promptDirty}
                hint={<TooltipLightbulb />}
            />
        </div>
    );
}
