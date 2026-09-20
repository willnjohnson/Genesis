import { Check } from "lucide-react";
import { useState } from "react";
import { setApiKey as saveApiKeyCmd, removeApiKey as removeApiKeyCmd } from "../../api";
import { ApiKeyField } from "./ApiKeyField";
import { PixabayApiPanel } from "./PixabayApiPanel";
import { VeniceApiPanel } from "./VeniceApiPanel";

export type ApiSection = "youtube" | "venice" | "pixabay";

const SECTION_LABELS: Record<ApiSection, string> = {
    youtube: "YouTube Data API",
    venice: "Venice AI",
    pixabay: "Pixabay",
};

interface Props {
    hasKey: boolean;
    /** Name of the sync server whose license covers the YouTube API, when there is one. */
    licensedBy?: string | null;
    onKeyChange: (hasKey: boolean) => void;
    /** Which page is showing. Venice AI and Pixabay are only offered while a plugin that uses them is on. */
    section: ApiSection;
    onSectionChange: (section: ApiSection) => void;
    showVenice: boolean;
    showPixabay: boolean;
}

function YouTubePanel({ hasKey: initialHasKey, licensedBy, onKeyChange }: Pick<Props, "hasKey" | "licensedBy" | "onKeyChange">) {
    const [hasKey, setHasKey] = useState(initialHasKey);

    return (
        <div>
            <h3 className="text-base font-bold mb-1">YouTube Data API</h3>
            <p className="text-xs text-[#aaaaaa] mb-4">
                Optional. Improves search quality and fills in channel subscriber counts.
            </p>

            {licensedBy && (
                <div className="mb-4 flex items-start gap-2 text-blue-300 bg-blue-900/10 border border-blue-500/30 rounded-lg px-3 py-2.5 text-xs leading-relaxed">
                    <Check className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                        Covered by {licensedBy}'s license, so you don't need your own key.
                        {hasKey ? " Your own key is used instead unless the server requires its license." : " You can still add your own key if you prefer."}
                    </span>
                </div>
            )}

            <ApiKeyField
                hasKey={hasKey}
                placeholder="Paste your YouTube API key"
                onSave={async (key) => { await saveApiKeyCmd(key); setHasKey(true); onKeyChange(true); }}
                onRemove={async () => { await removeApiKeyCmd(); setHasKey(false); onKeyChange(false); }}
            />
        </div>
    );
}

export function ApiKeyTab({ hasKey, licensedBy, onKeyChange, section, onSectionChange, showVenice, showPixabay }: Props) {
    const sections: ApiSection[] = ["youtube", ...(showVenice ? ["venice" as const] : []), ...(showPixabay ? ["pixabay" as const] : [])];
    // A page whose plugin has been turned off falls back to YouTube's.
    const current: ApiSection = sections.includes(section) ? section : "youtube";

    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            {/* With only YouTube's page there's nothing to switch between. */}
            {sections.length > 1 && (
                <div className="flex items-center gap-4">
                    {sections.map(id => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => onSectionChange(id)}
                            className={`pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${current === id ? "text-white" : "text-[#666666] hover:text-[#aaaaaa]"}`}
                        >
                            {SECTION_LABELS[id]}
                            {current === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                        </button>
                    ))}
                </div>
            )}

            {current === "youtube" && <YouTubePanel hasKey={hasKey} licensedBy={licensedBy} onKeyChange={onKeyChange} />}
            {current === "venice" && <VeniceApiPanel />}
            {current === "pixabay" && <PixabayApiPanel />}
        </div>
    );
}
