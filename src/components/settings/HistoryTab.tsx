import { History, Clock, Trash2, X } from "lucide-react";
import { type HistoryEntry } from "../../api";
import { decodeHtmlEntities } from "../../lib/utils";

interface Props {
    entries: HistoryEntry[];
    onDeleteEntry: (id: number) => void;
    onClearDate: (date: string) => void;
    onClearAll: () => void;
}

export function HistoryTab({ entries, onDeleteEntry, onClearDate, onClearAll }: Props) {
    // Group by date (YYYY-MM-DD)
    const grouped: Record<string, HistoryEntry[]> = {};
    entries.forEach(e => {
        const date = e.searchedAt.split(' ')[0];
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(e);
    });
    const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-base font-bold mb-1">Search History</h3>
                    <p className="text-xs text-[#aaaaaa]">
                        {entries.length} saved searches across {dates.length} day(s)
                    </p>
                </div>
                {entries.length > 0 && (
                    <button
                        onClick={onClearAll}
                        className="bg-red-600 hover:bg-red-500 text-white px-4 py-2.5 rounded-lg font-bold text-xs transition-colors cursor-pointer flex items-center gap-2"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        Clear All
                    </button>
                )}
            </div>

            {entries.length === 0 ? (
                <div className="text-center py-16 text-[#555]">
                    <History className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm font-medium">No search history yet.</p>
                    <p className="text-xs mt-1">Searches you make will appear here.</p>
                </div>
            ) : (
                <div className="max-h-[340px] overflow-y-auto pr-1 space-y-6">
                    {dates.map(date => (
                        <div key={date}>
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <Clock className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
                                    <span className="text-[11px] font-bold text-gray-400 dark:text-[#555] uppercase tracking-widest">
                                        {new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
                                            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
                                        })}
                                    </span>
                                </div>
                                <button
                                    onClick={() => onClearDate(date)}
                                    className="text-[10px] font-bold text-gray-400 dark:text-[#555] hover:text-red-500 transition-colors cursor-pointer flex items-center gap-1"
                                >
                                    <Trash2 className="w-3 h-3" />
                                    Clear day
                                </button>
                            </div>
                            <div className="bg-gray-50 dark:bg-[#141414] border border-gray-200 dark:border-[#222] rounded-xl overflow-hidden divide-y divide-gray-100 dark:divide-[#1e1e1e]">
                                {grouped[date].map(entry => (
                                    <div key={entry.id} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-gray-100 dark:hover:bg-white/[0.02] transition-colors">
                                        <Clock className="w-3 h-3 text-gray-300 dark:text-[#444] shrink-0" />
                                        <span className="flex-1 text-sm text-gray-600 dark:text-[#aaaaaa] truncate">{decodeHtmlEntities(entry.search_query)}</span>
                                        <span className="text-[10px] text-gray-400 dark:text-[#444] shrink-0">
                                            {entry.searchedAt.split(' ')[1]?.slice(0, 5) ?? ''}
                                        </span>
                                        <button
                                            onClick={() => onDeleteEntry(entry.id)}
                                            className="p-1 hover:text-red-500 text-gray-300 dark:text-[#444] transition-all cursor-pointer shrink-0"
                                            title="Remove"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
