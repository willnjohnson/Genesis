import { FileDown, Package } from "lucide-react";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BRAND } from "../../branding";
import { getSetting, setSetting, selectVaultPath, exportToObsidian, DEFAULT_DRIVE_SCOPE, type ExportSummary, type ObsidianOptions } from "../../api";
import { parentDir } from "../../lib/utils";
import { workspaceFileStem } from "../../lib/workspace";
import { useFlags } from "../../hooks/useFlags";
import { useWorkspace } from "../../hooks/useWorkspace";
import { KinpakExport } from "./KinpakExport";
import { settingsPrimaryBtn } from "./buttons";
import { DriveScopePicker } from "./DriveScopePicker";
import { ProgressLine } from "../workspace/shared";

const EXPORT_PATH_SETTING_KEY = "obsidianExportPath";
// The Save As dialog opens with a name built from the workspace's, e.g. Kinesis_Metabolic_Warp_Drive_Vault,
// which becomes the vault folder. The export always creates a new folder, so a taken name gets a
// "(2)" suffix instead of being merged into.
const defaultVaultName = (workspaceName: string) => `${BRAND.name}_${workspaceFileStem(workspaceName)}_Vault`;

type ExportView = 'obsidian' | 'sync';

// Same underline-tab styling as the Sidebar's Video Tags / Similar Videos switcher.
const EXPORT_VIEWS: { id: ExportView; label: string; Icon: React.ElementType }[] = [
    { id: 'obsidian', label: 'Export to Obsidian', Icon: FileDown },
    { id: 'sync', label: 'Export Kinpak', Icon: Package },
];

export function ExportTab() {
    const [chosen, setChosen] = useState<ExportView>('obsidian');
    const { flags } = useFlags();
    // Only the exports a DB owner left on. The sync-data export also needs the Sync tab (see lib/flags.ts).
    const views = EXPORT_VIEWS.filter(v => (v.id === 'obsidian' ? flags.exportObsidianVisible : flags.exportSyncDataVisible));
    const view: ExportView = views.some(v => v.id === chosen) ? chosen : (views[0]?.id ?? 'obsidian');
    const setView = setChosen;

    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <h3 className="text-base font-bold">Export</h3>
            <div>
                {/* With a single export left there's nothing to switch between. */}
                {views.length > 1 && (
                <div className="flex items-center gap-4 mb-4">
                    {views.map(({ id, label, Icon }) => (
                        <button
                            key={id}
                            onClick={() => setView(id)}
                            className={`flex items-center gap-1.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${view === id ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                        >
                            <Icon className="w-3.5 h-3.5" />
                            {label}
                            {view === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                        </button>
                    ))}
                </div>
                )}
                {/* The available ones stay mounted (just hidden) so switching tabs doesn't drop a running export's progress. */}
                {flags.exportObsidianVisible && <div className={view === 'obsidian' ? '' : 'hidden'}><ObsidianExport /></div>}
                {flags.exportSyncDataVisible && <div className={view === 'sync' ? '' : 'hidden'}><KinpakExport /></div>}
            </div>
        </div>
    );
}

function ObsidianExport() {
    const { labels } = useWorkspace();
    const [folderPath, setFolderPath] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [summary, setSummary] = useState<ExportSummary | null>(null);
    const [options, setOptions] = useState<ObsidianOptions>({
        videos: true, transcripts: true, glossary: true, biographies: true, drives: DEFAULT_DRIVE_SCOPE,
    });
    // A vault with nothing ticked would be empty.
    const anything = options.videos || options.glossary || options.biographies;

    useEffect(() => {
        getSetting(EXPORT_PATH_SETTING_KEY).then(setFolderPath).catch(() => {});
    }, []);

    useEffect(() => {
        const unlisten = listen("export_progress", (event) => setStatus(event.payload as string));
        return () => { unlisten.then(fn => fn()); };
    }, []);

    // A Save As dialog: the user picks the location and names the vault folder in one step, and the
    // export starts on confirm. It never writes into an existing folder (a taken name gets " (2)").
    // Cancelling does nothing.
    const handleExport = async () => {
        setError(null);
        const vaultPath = await selectVaultPath(defaultVaultName(labels.workspaceName), folderPath);
        if (!vaultPath) return;
        const parent = parentDir(vaultPath);
        setFolderPath(parent);
        setSetting(EXPORT_PATH_SETTING_KEY, parent).catch(() => {});
        setLoading(true);
        setError(null);
        setSummary(null);
        setStatus("Starting export...");
        try {
            const result = await exportToObsidian(vaultPath, options);
            setSummary(result);
            setStatus(null);
        } catch (err) {
            setError(String(err));
            setStatus(null);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div>
            <div>
                <p className="text-[11px] text-[#aaaaaa] leading-relaxed mb-4">
                    Turns your library into a cross-linked Obsidian vault. Everything is included unless you leave it out below.
                </p>

                <div className="space-y-3 mb-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                        {([
                            { key: "videos", label: `${labels.aliasLibrary} videos` },
                            { key: "transcripts", label: "Include transcripts", hint: "The bulk of the vault's size. Leave off for much smaller notes.", needsVideos: true },
                            { key: "glossary", label: labels.aliasGlossary },
                            { key: "biographies", label: labels.aliasBiography },
                        ] as { key: "videos" | "transcripts" | "glossary" | "biographies"; label: string; hint?: string; needsVideos?: boolean }[]).map(({ key, label, hint, needsVideos }) => {
                            const dependent = needsVideos && !options.videos;
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

                    <DriveScopePicker
                        value={options.drives}
                        onChange={(drives) => setOptions(prev => ({ ...prev, drives }))}
                        disabled={loading}
                        videos={options.videos}
                        glossary={options.glossary}
                        textLinks={false}
                    />
                </div>

                <button
                    onClick={handleExport}
                    disabled={loading || !anything}
                    className={`w-full ${settingsPrimaryBtn}`}
                >
                    <FileDown className="w-3.5 h-3.5" />
                    Export to Obsidian
                </button>

                {status && <div className="mt-4"><ProgressLine message={status} variant="runner" /></div>}

                {error && (
                    <div className="mt-4 p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-xs">
                        {error}
                    </div>
                )}

                {summary && (
                    <div className="mt-4 p-3 bg-green-900/10 border border-green-500/30 rounded-lg text-green-400 text-xs leading-relaxed">
                        Exported {summary.videos_exported} videos, {summary.glossary_terms} glossary terms, and{" "}
                        {summary.biographies} creator bios to {summary.folder_path}.
                    </div>
                )}
            </div>
        </div>
    );
}
