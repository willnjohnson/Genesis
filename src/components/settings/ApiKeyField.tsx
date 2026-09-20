import { AlertCircle, Check } from "lucide-react";
import { useState } from "react";

interface Props {
    hasKey: boolean;
    placeholder: string;
    /** Stores the key. Throwing shows the message under the field. The caller updates `hasKey` on success. */
    onSave: (key: string) => Promise<void>;
    onRemove: () => Promise<void>;
}

const message = (e: unknown, fallback: string) => (typeof e === "string" ? e : (e as { message?: string })?.message ?? fallback);

/** One provider's key row: a password box and Submit, or "API Key is Active" and Deactivate. */
export function ApiKeyField({ hasKey, placeholder, onSave, onRemove }: Props) {
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async () => {
        const key = input.trim();
        if (!key) return;
        setLoading(true);
        setError(null);
        try {
            await onSave(key);
            setInput("");
        } catch (e) {
            console.error("Failed to save API key:", e);
            setError(message(e, "Unknown error saving API key."));
        } finally {
            setLoading(false);
        }
    };

    const remove = async () => {
        setLoading(true);
        setError(null);
        try {
            await onRemove();
        } catch (e) {
            console.error("Failed to remove API key:", e);
            setError(message(e, "Unknown error removing API key."));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div>
            {hasKey ? (
                <div className="flex gap-3 items-center">
                    <div className="flex-1 bg-green-500/10 border border-green-500/30 text-green-400 px-3 py-2 rounded-lg flex items-center gap-2 text-[11px] font-medium">
                        <Check className="w-3.5 h-3.5" />
                        API Key is Active
                    </div>
                    <button
                        onClick={remove}
                        disabled={loading}
                        className="bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white px-4 py-2 rounded-lg font-semibold text-[11px] transition-colors cursor-pointer disabled:opacity-50"
                    >
                        Deactivate
                    </button>
                </div>
            ) : (
                <div className="flex gap-2">
                    <input
                        type="password"
                        placeholder={placeholder}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
                        className="flex-1 bg-[#121212] border border-[#303030] hover:border-[#505050] focus:border-red-600/50 outline-none rounded-lg px-3 py-2 text-[11px] text-white placeholder-[#505050] transition-colors"
                    />
                    <button
                        onClick={save}
                        disabled={loading || !input.trim()}
                        className="bg-red-600 hover:bg-red-500 text-white disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded-lg font-bold text-[11px] transition-colors cursor-pointer"
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
    );
}
