import { Check, AlertCircle } from "lucide-react";
import { useState } from "react";
import { setApiKey as saveApiKeyCmd, removeApiKey as removeApiKeyCmd } from "../../api";

interface Props {
    hasKey: boolean;
    onKeyChange: (hasKey: boolean) => void;
}

export function ApiKeyTab({ hasKey: initialHasKey, onKeyChange }: Props) {
    const [hasKey, setHasKey] = useState(initialHasKey);
    const [apiKeyInput, setApiKeyInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSave = async () => {
        const key = apiKeyInput.trim();
        if (!key) return;
        setLoading(true);
        setError(null);
        try {
            await saveApiKeyCmd(key);
            setHasKey(true);
            setApiKeyInput("");
            onKeyChange(true);
        } catch (e: any) {
            console.error("Failed to save API key:", e);
            setError(typeof e === "string" ? e : e?.message ?? "Unknown error saving API key.");
        } finally {
            setLoading(false);
        }
    };

    const handleRemove = async () => {
        setLoading(true);
        setError(null);
        try {
            await removeApiKeyCmd();
            setHasKey(false);
            onKeyChange(false);
        } catch (e: any) {
            console.error("Failed to remove API key:", e);
            setError(typeof e === "string" ? e : e?.message ?? "Unknown error removing API key.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-1">YouTube Data API</h3>
                <p className="text-xs text-[#aaaaaa] mb-4">
                    Required for fetching high-quality transcripts and searching channel.
                </p>

                {hasKey ? (
                    <div className="flex gap-3 items-center">
                        <div className="flex-1 bg-green-500/10 border border-green-500/30 text-green-400 px-4 py-2.5 rounded-lg flex items-center gap-2 font-medium">
                            <Check className="w-4 h-4" />
                            API Key is Active
                        </div>
                        <button
                            onClick={handleRemove}
                            disabled={loading}
                            className="bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white px-4 py-2.5 rounded-lg font-semibold text-xs transition-colors cursor-pointer disabled:opacity-50"
                        >
                            Deactivate
                        </button>
                    </div>
                ) : (
                    <div className="flex gap-2">
                        <input
                            type="password"
                            placeholder="Paste your YouTube API key..."
                            value={apiKeyInput}
                            onChange={(e) => setApiKeyInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                            className="flex-1 bg-[#121212] border border-[#303030] hover:border-[#505050] focus:border-red-600/50 outline-none rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#505050] transition-colors"
                        />
                        <button
                            onClick={handleSave}
                            disabled={loading || !apiKeyInput.trim()}
                            className="bg-red-600 hover:bg-red-500 text-white disabled:opacity-50 disabled:cursor-not-allowed px-6 py-2.5 rounded-lg font-bold text-xs transition-colors cursor-pointer shadow-lg shadow-red-900/10"
                        >
                            {loading ? "Saving..." : "Submit"}
                        </button>
                    </div>
                )}

                {error && (
                    <div className="mt-3 flex items-start gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span className="text-xs">{error}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
