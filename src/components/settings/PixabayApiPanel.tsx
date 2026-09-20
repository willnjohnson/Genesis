import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { getKeyStatus, getPixabayApiKey, setPixabayApiKey, type KeyStatus } from "../../api";
import { ApiKeyField } from "./ApiKeyField";

/** Pixabay: the API key for searching its free stock photos from the image tools. */
export function PixabayApiPanel() {
    const [hasKey, setHasKey] = useState(false);
    const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);

    useEffect(() => {
        getKeyStatus().then(setKeyStatus).catch(() => {});
        getPixabayApiKey().then(k => setHasKey(!!k && k.trim() !== ""));
    }, []);

    return (
        <div>
            <h3 className="text-base font-bold mb-1">Pixabay</h3>
            <p className="text-xs text-[#aaaaaa] mb-4">Lets the image tools search Pixabay's free stock photos.</p>

            {keyStatus?.pixabay.licensed && (
                <div className="mb-4 flex items-start gap-2 text-blue-300 bg-blue-900/10 border border-blue-500/30 rounded-lg px-3 py-2.5 text-xs leading-relaxed">
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                        Covered by {keyStatus.server_name || "your sync server"}'s license, so you don't need your own key.
                        {keyStatus.pixabay.own_key && !keyStatus.pixabay.via_license ? " Your own key is used instead." : ""}
                    </span>
                </div>
            )}

            <ApiKeyField
                hasKey={hasKey}
                placeholder="Paste your Pixabay API key"
                onSave={async (key) => { await setPixabayApiKey(key); setHasKey(true); }}
                onRemove={async () => { await setPixabayApiKey(""); setHasKey(false); }}
            />
        </div>
    );
}
