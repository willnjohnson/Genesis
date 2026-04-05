import { Database, Settings } from "lucide-react";
import { type DbDetails } from "../../api";

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
    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-4">Storage Management</h3>
                <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="bg-[#121212] border border-[#303030] p-4 rounded-xl">
                        <span className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-1">Videos Stored</span>
                        <span className="text-xl font-bold text-white">{dbDetails.video_count}</span>
                    </div>
                    <div className="bg-[#121212] border border-[#303030] p-4 rounded-xl">
                        <span className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-1">Search History</span>
                        <span className="text-xl font-bold text-white">{dbDetails.history_count}</span>
                    </div>
                    <div className="bg-[#121212] border border-[#303030] p-4 rounded-xl">
                        <span className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-1">Database Size</span>
                        <span className="text-xl font-bold text-white">{formatSize(dbDetails.size_bytes)}</span>
                    </div>
                </div>
                <div className="space-y-3">
                    <div>
                        <span className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-2">Location</span>
                        <code className="block w-full bg-black/40 border border-[#303030] p-3 rounded-lg text-[11px] text-[#888888] break-all select-all font-mono">
                            {dbDetails.path}
                        </code>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={onOpen}
                            disabled={loading}
                            className="flex-1 bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white px-4 py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer mt-4 disabled:opacity-50"
                        >
                            <Database className="w-4 h-4" />
                            Open DB Location
                        </button>
                        <button
                            onClick={onChangeLocation}
                            disabled={loading}
                            className="flex-1 bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white px-4 py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer mt-4 disabled:opacity-50"
                        >
                            <Settings className="w-4 h-4" />
                            Change DB Path
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
