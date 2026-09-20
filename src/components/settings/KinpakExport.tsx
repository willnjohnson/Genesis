import { Package } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BRAND } from "../../branding";
import { useWorkspace } from "../../hooks/useWorkspace";
import { workspaceFileStem, type WorkspaceLabels } from "../../lib/workspace";
import { formatBytes, parentDir } from "../../lib/utils";
import { getSetting, setSetting, selectKinpakSavePath, type KinpakOptions } from "../../api";
import { getKinpakExportState, startKinpakExport, subscribeKinpakExport } from "../../lib/kinpak-export";
import { ErrorBox, ProgressLine } from "../workspace/shared";
import { settingsPrimaryBtn } from "./buttons";

// The folder of the last export, so the Save As dialog opens where the user left off.
const PACK_PATH_SETTING_KEY = "syncPackExportPath";

const optionLabels = (labels: WorkspaceLabels): { key: keyof KinpakOptions; label: string; hint?: string }[] => [
    { key: "videos", label: `${labels.aliasLibrary} videos`, hint: "Titles, summaries, tags and category assignments." },
    { key: "transcripts", label: "Include transcripts", hint: "The bulk of the file size. Leave off for a much smaller file." },
    { key: "taxonomy", label: `${labels.aliasDriveName} categories`, hint: "The category tree with aliases and icons." },
    { key: "glossary", label: labels.aliasGlossary },
    { key: "biographies", label: labels.aliasBiography },
    { key: "prompts", label: "Custom summary prompts" },
    { key: "notes", label: "Video notes" },
    { key: "attachments", label: "Attachments", hint: "Files attached to videos. They make the file as large as they are; there's no limit." },
    { key: "history", label: `${labels.aliasSearch} history` },
    { key: "workspace", label: "Workspace name and section names", hint: "The workspace's name and the names you gave Search, Library, Drive and so on." },
    { key: "settings", label: "Settings and feature flags", hint: "Never includes API keys, tokens, sync-server details or folder paths." },
];

// Options that only mean something alongside the videos they belong to.
const NEEDS_VIDEOS: (keyof KinpakOptions)[] = ["transcripts", "notes", "attachments"];

// Default Save As name, stamped so repeated exports don't collide.
function defaultKinpakName(workspaceName: string): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${BRAND.name}_${workspaceFileStem(workspaceName)}_${stamp}.kinpak`;
}

export function KinpakExport() {
    const { labels } = useWorkspace();
    const [folderPath, setFolderPath] = useState<string | null>(null);
    const [options, setOptions] = useState<KinpakOptions>({
        taxonomy: true, videos: true, transcripts: true, glossary: true, biographies: true, prompts: true,
        settings: true, workspace: true, history: true, notes: true, attachments: true,
    });
    // The export's state lives outside this component, so it's still here (running, or how it ended)
    // after leaving Settings and coming back.
    const exportState = useSyncExternalStore(subscribeKinpakExport, getKinpakExportState);
    const { running: loading, progress, summary, error } = exportState;

    useEffect(() => {
        getSetting(PACK_PATH_SETTING_KEY).then(setFolderPath).catch(() => {});
    }, []);

    // A Save As dialog: the user picks the folder and file name in one step, and the export runs as
    // soon as they confirm. Cancelling does nothing.
    const handleExport = async () => {
        const file = await selectKinpakSavePath(defaultKinpakName(labels.workspaceName), folderPath);
        if (!file) return;
        const folder = parentDir(file);
        setFolderPath(folder);
        setSetting(PACK_PATH_SETTING_KEY, folder).catch(() => {});
        void startKinpakExport(file, options);
    };

    // A kinpak with nothing ticked would be an empty file.
    const anything = Object.entries(options).some(([key, on]) => on && key !== "transcripts");

    return (
        <div>
            <p className="text-[11px] text-[#aaaaaa] leading-relaxed mb-4">
                Saves this workspace as a single .kinpak file you can share or keep as a backup. Whoever opens it gets their own copy, set up the way
                yours is. Your API keys and access tokens are never included.
            </p>

            <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                    {optionLabels(labels).map(({ key, label, hint }) => {
                        const dependent = NEEDS_VIDEOS.includes(key) && !options.videos;
                        return (
                            <label key={key} className={`flex items-start gap-2 text-xs cursor-pointer ${dependent ? "opacity-40" : ""}`} title={hint}>
                                <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={options[key] && !dependent}
                                    disabled={loading || dependent}
                                    onChange={(e) => setOptions(prev => ({ ...prev, [key]: e.target.checked }))}
                                />
                                <span>{label}</span>
                            </label>
                        );
                    })}
                </div>

                <button
                    onClick={handleExport}
                    disabled={loading || !anything}
                    className={`w-full ${settingsPrimaryBtn}`}
                >
                    <Package className="w-3.5 h-3.5" />
                    Export Kinpak
                </button>
            </div>

            {loading && (
                <div className="mt-4 space-y-1.5">
                    <ProgressLine message={progress ?? "Starting export..."} variant="runner" />
                    <p className="text-[11px] text-[#666666] leading-relaxed">
                        Writing {exportState.file}. It keeps going if you close Settings, and you'll get a message here when it's done.
                        Don't close Kinesis until then.
                    </p>
                </div>
            )}
            {error && <div className="mt-4"><ErrorBox>{error}</ErrorBox></div>}
            {summary && (
                <div className="mt-4 p-3 bg-green-900/10 border border-green-500/30 rounded-lg text-green-400 text-xs leading-relaxed break-words">
                    Exported {(summary.counts.video ?? 0).toLocaleString()} videos, {(summary.counts.wdbs ?? 0).toLocaleString()} categories,{" "}
                    {(summary.counts.glossary ?? 0).toLocaleString()} glossary terms, {(summary.counts.biography ?? 0).toLocaleString()} bios,{" "}
                    {(summary.counts.attachment ?? 0).toLocaleString()} attachments and {summary.settings} settings ({formatBytes(summary.bytes)}) to {summary.path}.
                </div>
            )}
        </div>
    );
}
