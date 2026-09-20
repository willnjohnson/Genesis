import { Database, Settings } from "lucide-react";
import { type DbDetails } from "../../api";
import { useFlags } from "../../hooks/useFlags";
import { useWorkspace } from "../../hooks/useWorkspace";
import { settingsSecondaryBtn } from "./buttons";

interface Props {
    dbDetails: DbDetails;
    onOpen: () => void;
    onChangeLocation: () => void;
    loading: boolean;
}

function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function DatabaseTab({ dbDetails, onOpen, onChangeLocation, loading }: Props) {
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    // What the library holds, two per line. Rows for parts of the app a DB owner has
    // hidden are left out; the database's own size always closes the list, across both columns.
    const rows: { label: string; value: string; detail?: string; wide?: boolean }[] = [
        { label: 'Videos Stored', value: String(dbDetails.video_count) },
        { label: 'Channels', value: String(dbDetails.channel_count) },
        ...(flags.showDrive ? [{ label: 'Drive Nodes', value: String(dbDetails.drive_count) }] : []),
        ...(flags.showGlossary ? [{ label: 'Terms', value: String(dbDetails.glossary_count) }] : []),
        ...(flags.showGlossary && flags.showQuickTags ? [{ label: 'Tags', value: String(dbDetails.quick_tag_count) }] : []),
        ...(flags.showBiography ? [{ label: labels.aliasBiography, value: String(dbDetails.biography_count) }] : []),
        ...(flags.showAttachments ? [{
            label: 'Attachments',
            value: String(dbDetails.attachment_count),
            detail: dbDetails.attachment_count > 0 ? formatSize(dbDetails.attachment_bytes) : undefined,
        }] : []),
        { label: `${labels.aliasSearch} History`, value: String(dbDetails.history_count) },
        { label: 'Database Size', value: formatSize(dbDetails.size_bytes), wide: true },
    ];
    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-3">Storage Management</h3>
                <div className="grid grid-cols-2 gap-2 mb-4">
                    {rows.map(row => (
                        <div key={row.label} className={`flex items-center justify-between gap-3 bg-[#121212] border border-[#303030] px-3 py-2 rounded-lg ${row.wide ? 'col-span-2' : ''}`}>
                            <span className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest truncate">{row.label}</span>
                            <span className="flex items-baseline gap-2">
                                {row.detail && <span className="text-[11px] text-[#777777]">{row.detail}</span>}
                                <span className="text-sm font-bold text-white">{row.value}</span>
                            </span>
                        </div>
                    ))}
                </div>
                <div className="space-y-3">
                    <div>
                        <span className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-2">Location</span>
                        <code className="block w-full bg-black/40 border border-[#303030] p-3 rounded-lg text-[11px] text-[#888888] break-all select-all font-mono">
                            {dbDetails.path}
                        </code>
                    </div>
                    {(flags.allowOpenDbFolder || flags.allowChangeDbLocation) && (
                    <div className="flex gap-2">
                        {flags.allowOpenDbFolder && (
                        <button
                            onClick={onOpen}
                            disabled={loading}
                            className={`flex-1 ${settingsSecondaryBtn} mt-1`}
                        >
                            <Database className="w-3.5 h-3.5" />
                            Open DB Location
                        </button>
                        )}
                        {flags.allowChangeDbLocation && (
                        <button
                            onClick={onChangeLocation}
                            disabled={loading}
                            className={`flex-1 ${settingsSecondaryBtn} mt-1`}
                        >
                            <Settings className="w-3.5 h-3.5" />
                            Change DB Path
                        </button>
                        )}
                    </div>
                    )}
                </div>
            </div>
        </div>
    );
}
