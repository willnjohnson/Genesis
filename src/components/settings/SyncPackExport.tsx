import { Package } from "lucide-react";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BRAND } from "../../branding";
import { useWorkspace } from "../../hooks/useWorkspace";
import { workspaceFileStem, type WorkspaceLabels } from "../../lib/workspace";
import { parentDir } from "../../lib/utils";
import { getSetting, setSetting, selectPackSavePath, exportSyncPack, type SyncPackOptions, type SyncPackExportSummary } from "../../api";

// The folder of the last export, so the Save As dialog opens where the user left off.
const PACK_PATH_SETTING_KEY = "syncPackExportPath";

const optionLabels = (labels: WorkspaceLabels): { key: keyof SyncPackOptions; label: string; hint?: string }[] => [
    { key: "videos", label: `${labels.aliasLibrary} videos`, hint: "Titles, summaries, tags and category assignments." },
    { key: "transcripts", label: "Include transcripts", hint: "The bulk of the file size. Leave off for a much smaller pack." },
    { key: "taxonomy", label: `${labels.aliasDriveName} categories`, hint: "The category tree with aliases and icons." },
    { key: "glossary", label: labels.aliasGlossary },
    { key: "biographies", label: labels.aliasBiography },
    { key: "prompts", label: "Custom summary prompts" },
    { key: "settings", label: "Settings and feature flags", hint: "Never includes API keys, tokens or folder paths." },
];

// Default Save As name: compressed, and stamped so repeated exports don't collide.
function defaultPackName(workspaceName: string): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${BRAND.name}_${workspaceFileStem(workspaceName)}_sync_pack_${stamp}.jsonl.gz`;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SyncPackExport() {
    const { labels } = useWorkspace();
    const [folderPath, setFolderPath] = useState<string | null>(null);
    const [options, setOptions] = useState<SyncPackOptions>({
        taxonomy: true, videos: true, transcripts: true, glossary: true,
        biographies: true, prompts: true, settings: true,
    });
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [summary, setSummary] = useState<SyncPackExportSummary | null>(null);

    useEffect(() => {
        getSetting(PACK_PATH_SETTING_KEY).then(setFolderPath).catch(() => {});
    }, []);

    useEffect(() => {
        const unlisten = listen("sync_pack_progress", (event) => setStatus(event.payload as string));
        return () => { unlisten.then(fn => fn()); };
    }, []);

    // A Save As dialog: the user picks the folder and file name in one step, and the export runs as
    // soon as they confirm. A .gz name is compressed, .jsonl is plain. Cancelling does nothing.
    const handleExport = async () => {
        setError(null);
        const file = await selectPackSavePath(defaultPackName(labels.workspaceName), folderPath);
        if (!file) return;
        const folder = parentDir(file);
        setFolderPath(folder);
        setSetting(PACK_PATH_SETTING_KEY, folder).catch(() => {});
        setLoading(true);
        setSummary(null);
        setStatus("Starting export...");
        try {
            setSummary(await exportSyncPack(file, options));
        } catch (err) {
            setError(String(err));
        } finally {
            setStatus(null);
            setLoading(false);
        }
    };

    // A pack with none of the content kinds and no settings would be an empty file.
    const anything = options.videos || options.taxonomy || options.glossary || options.biographies || options.prompts || options.settings;

    return (
        <div>
            <p className="text-[11px] text-[#aaaaaa] leading-relaxed mb-4">
                Saves your data as a portable sync pack (JSON lines) that another install, or a sync server admin, can import.
                Your API keys and access tokens are never included.
            </p>

            <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                    {optionLabels(labels).map(({ key, label, hint }) => (
                        <label
                            key={key}
                            className={`flex items-start gap-2 text-xs cursor-pointer ${key === "transcripts" && !options.videos ? "opacity-40" : ""}`}
                            title={hint}
                        >
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={options[key]}
                                disabled={loading || (key === "transcripts" && !options.videos)}
                                onChange={(e) => setOptions(prev => ({ ...prev, [key]: e.target.checked }))}
                            />
                            <span>{label}</span>
                        </label>
                    ))}
                </div>

                <button
                    onClick={handleExport}
                    disabled={loading || !anything}
                    className="w-full bg-red-600 text-white hover:bg-red-500 px-4 py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                    <Package className="w-4 h-4" />
                    Export sync pack
                </button>
            </div>

            {status && (
                <div className="mt-4 p-2.5 bg-red-600/10 border border-red-600/20 rounded-lg flex items-center gap-2">
                    <div className="w-2.5 h-2.5 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
                    <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">{status}</span>
                </div>
            )}
            {error && (
                <div className="mt-4 p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-xs break-words">{error}</div>
            )}
            {summary && (
                <div className="mt-4 p-3 bg-green-900/10 border border-green-500/30 rounded-lg text-green-400 text-xs leading-relaxed break-words">
                    Exported {(summary.counts.video ?? 0).toLocaleString()} videos, {(summary.counts.wdbs ?? 0).toLocaleString()} categories,{" "}
                    {(summary.counts.glossary ?? 0).toLocaleString()} glossary terms, {(summary.counts.biography ?? 0).toLocaleString()} bios
                    and {summary.settings} settings ({formatBytes(summary.bytes)}) to {summary.path}.
                </div>
            )}
        </div>
    );
}
