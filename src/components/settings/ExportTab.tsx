import { FolderOpen, FileDown } from "lucide-react";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BRAND } from "../../branding";
import { getSetting, setSetting, selectFolder, exportToObsidian, type ExportSummary } from "../../api";

const EXPORT_PATH_SETTING_KEY = "obsidianExportPath";
// Both the actual invoke() call and the destination preview below must use this same value, so
// the folder actually created always matches what's shown here.
const EXPORT_CONTAINER_NAME = `${BRAND.name}_Vault`;

export function ExportTab() {
    const [folderPath, setFolderPath] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [summary, setSummary] = useState<ExportSummary | null>(null);

    useEffect(() => {
        getSetting(EXPORT_PATH_SETTING_KEY).then(setFolderPath).catch(() => {});
    }, []);

    useEffect(() => {
        const unlisten = listen("export_progress", (event) => setStatus(event.payload as string));
        return () => { unlisten.then(fn => fn()); };
    }, []);

    const handleChooseFolder = async () => {
        const folder = await selectFolder();
        if (folder) {
            setFolderPath(folder);
            await setSetting(EXPORT_PATH_SETTING_KEY, folder);
        }
    };

    const handleExport = async () => {
        if (!folderPath) return;
        setLoading(true);
        setError(null);
        setSummary(null);
        setStatus("Starting export...");
        try {
            const result = await exportToObsidian(folderPath, EXPORT_CONTAINER_NAME, BRAND.libraryLabel);
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
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-2">Export to Obsidian</h3>
                <p className="text-[11px] text-[#aaaaaa] leading-relaxed mb-4">
                    Transforms your entire library into a cross-linked Obsidian vault.
                </p>

                <div className="space-y-3">
                    <div>
                        <span className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-2">Destination</span>
                        <code className="block w-full bg-black/40 border border-[#303030] p-3 rounded-lg text-[11px] text-[#888888] break-all select-all font-mono">
                            {folderPath ? `${folderPath}\\${EXPORT_CONTAINER_NAME}` : "No folder selected"}
                        </code>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={handleChooseFolder}
                            disabled={loading}
                            className="flex-1 bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white px-4 py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                        >
                            <FolderOpen className="w-4 h-4" />
                            Choose Folder
                        </button>
                        <button
                            onClick={handleExport}
                            disabled={loading || !folderPath}
                            className="flex-1 bg-red-600 text-white hover:bg-red-500 px-4 py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                        >
                            <FileDown className="w-4 h-4" />
                            Export to Obsidian
                        </button>
                    </div>
                </div>

                {status && (
                    <div className="mt-4 p-2.5 bg-red-600/10 border border-red-600/20 rounded-lg flex items-center gap-2">
                        <div className="w-2.5 h-2.5 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
                        <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">{status}</span>
                    </div>
                )}

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
