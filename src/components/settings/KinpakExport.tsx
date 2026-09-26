import { Package } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BRAND } from "../../branding";
import { useWorkspace } from "../../hooks/useWorkspace";
import { workspaceFileStem, type WorkspaceLabels } from "../../lib/workspace";
import { formatBytes, parentDir } from "../../lib/utils";
import { getSetting, setSetting, selectKinpakSavePath, DEFAULT_DRIVE_SCOPE, type KinpakOptions } from "../../api";
import { getKinpakExportState, startKinpakExport, subscribeKinpakExport } from "../../lib/kinpak-export";
import { ErrorBox, ProgressLine } from "../workspace/shared";
import { settingsPrimaryBtn } from "./buttons";
import { DriveScopePicker } from "./DriveScopePicker";
import { CheckboxDropdown } from "../CheckboxDropdown";

// The folder of the last export, so the Save As dialog opens where the user left off.
const PACK_PATH_SETTING_KEY = "syncPackExportPath";

// The on/off options; which Drives to include is handled by its own picker.
type ToggleKey = Exclude<keyof KinpakOptions, "drives">;

// `more` options are the less common ones, tucked into a collapsed section so the screen stays short.
const optionLabels = (labels: WorkspaceLabels): { key: ToggleKey; label: string; hint?: string; more?: boolean }[] => [
    { key: "videos", label: `${labels.aliasLibrary} videos`, hint: "Titles, summaries, tags and category assignments." },
    { key: "transcripts", label: "Include transcripts", hint: "The bulk of the file size. Leave off for a much smaller file." },
    { key: "taxonomy", label: `${labels.aliasDriveName} categories`, hint: "The category tree with aliases and icons." },
    { key: "glossary", label: labels.aliasGlossary },
    { key: "biographies", label: labels.aliasBiography },
    { key: "prompts", label: "Custom summary prompts", more: true },
    { key: "sequences", label: "Sequences", hint: "Which order videos play in, per Drive.", more: true },
    { key: "notes", label: "Video notes", more: true },
    { key: "attachments", label: "Attachments", hint: "Files attached to videos. They make the file as large as they are; there's no limit.", more: true },
    { key: "history", label: `${labels.aliasSearch} history`, more: true },
    { key: "workspace", label: "Workspace name and section names", hint: "The workspace's name and the names you gave Search, Library, Drive and so on.", more: true },
    { key: "settings", label: "Settings and feature flags", hint: "Never includes API keys, tokens, sync-server details or folder paths.", more: true },
];

// Options that only mean something alongside the videos they belong to.
const NEEDS_VIDEOS: ToggleKey[] = ["transcripts", "notes", "attachments", "sequences"];

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
        sequences: true, settings: true, workspace: true, history: true, notes: true, attachments: true,
        drives: DEFAULT_DRIVE_SCOPE,
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
    const anything = Object.entries(options).some(([key, on]) => on && key !== "transcripts" && key !== "drives");

    const items = optionLabels(labels);
    const moreItems = items.filter(i => i.more);
    // Options that only mean something alongside the videos they belong to are off while videos are.
    const isOn = (key: ToggleKey) => options[key] && !(NEEDS_VIDEOS.includes(key) && !options.videos);
    const moreOn = moreItems.filter(i => isOn(i.key)).length;

    const renderOptions = (list: typeof moreItems) => (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            {list.map(({ key, label, hint }) => {
                const dependent = NEEDS_VIDEOS.includes(key) && !options.videos;
                return (
                    <label key={key} className={`flex items-start gap-2 text-xs cursor-pointer ${dependent ? "opacity-40" : ""}`} title={hint}>
                        <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={isOn(key)}
                            disabled={loading || dependent}
                            onChange={(e) => setOptions(prev => ({ ...prev, [key]: e.target.checked }))}
                        />
                        <span>{label}</span>
                    </label>
                );
            })}
        </div>
    );

    return (
        <div>
            <p className="text-[11px] text-[#aaaaaa] leading-relaxed mb-4">
                Saves this workspace as a single .kinpak file you can share or keep as a backup. Whoever opens it gets their own copy, set up the way
                yours is. Your API keys and access tokens are never included.
            </p>

            <div className="space-y-3">
                {renderOptions(items.filter(i => !i.more))}

                <div className="space-y-1">
                    <span className="block text-[11px] text-[#aaaaaa]">Also include</span>
                    <CheckboxDropdown
                        options={moreItems.map(i => ({ value: i.key, label: i.label, hint: i.hint, disabled: NEEDS_VIDEOS.includes(i.key) && !options.videos }))}
                        selected={moreItems.filter(i => isOn(i.key)).map(i => i.key)}
                        onChange={(next) => setOptions(prev => {
                            const updated = { ...prev };
                            for (const i of moreItems) if (!(NEEDS_VIDEOS.includes(i.key) && !prev.videos)) updated[i.key] = next.includes(i.key);
                            return updated;
                        })}
                        summary={moreOn === moreItems.length ? `All ${moreItems.length}` : moreOn === 0 ? "None" : `${moreOn} of ${moreItems.length}`}
                        disabled={loading}
                        allNone
                    />
                </div>

                <DriveScopePicker
                    value={options.drives}
                    onChange={(drives) => setOptions(prev => ({ ...prev, drives }))}
                    disabled={loading}
                    videos={options.videos}
                    glossary={options.glossary}
                    textLinks
                />

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
                    <ProgressLine message={progress ?? "Starting export..."} />
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
                    {(summary.counts.drive_sequence ?? 0).toLocaleString()} sequence entries, {(summary.counts.attachment ?? 0).toLocaleString()} attachments and{" "}
                    {summary.settings} settings ({formatBytes(summary.bytes)}) to {summary.path}.
                </div>
            )}
        </div>
    );
}
