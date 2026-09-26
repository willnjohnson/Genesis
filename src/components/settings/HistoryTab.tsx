import { useEffect, useState } from "react";
import { Toggle } from "./Toggle";
import { History, Clock, Trash2, X, Settings } from "lucide-react";
import { getSetting, setSetting, type HistoryEntry } from "../../api";
import { decodeHtmlEntities } from "../../lib/utils";
import { parseBool } from "../../lib/flags";
import { useFlags } from "../../hooks/useFlags";
import { useWorkspace } from "../../hooks/useWorkspace";
import { settingsPrimaryBtn } from "./buttons";
import { useLockedSettings, LOCKED_TITLE } from "../../hooks/useLockedSettings";

// Settings keys. `saveSearchHistory` is also a DB-owner flag (see docs/customizing.md): when the owner
// turns it off, or a sync server locks it, the switch below is disabled.
const SAVE_KEY = "saveSearchHistory";
const CLEAR_AFTER_KEY = "searchHistoryClearAfter";

const CLEAR_AFTER_CHOICES: { value: string; label: string }[] = [
    { value: "never", label: "Never" },
    { value: "6m", label: "6 months" },
    { value: "3m", label: "3 months" },
    { value: "1m", label: "1 month" },
];

type HistoryView = "timeline" | "settings";

// Same underline-tab styling as the Export tab's sections and the Sidebar's Video Tags / Similar Videos switcher.
const HISTORY_VIEWS: { id: HistoryView; label: string; Icon: React.ElementType }[] = [
    { id: "timeline", label: "History Timeline", Icon: History },
    { id: "settings", label: "Settings", Icon: Settings },
];

interface Props {
    entries: HistoryEntry[];
    onDeleteEntry: (id: number) => void;
    onClearDate: (date: string) => void;
    onClearAll: () => void;
    /** Called after "clear after" changes, since that can remove entries right away. */
    onRetentionChange?: () => void;
}

export function HistoryTab({ entries, onDeleteEntry, onClearDate, onClearAll, onRetentionChange }: Props) {
    // A DB owner can make history read-only (allowClearHistory = false): no clearing or removing.
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    const canClear = flags.allowClearHistory;
    const isLocked = useLockedSettings();
    const [view, setView] = useState<HistoryView>("timeline");
    const [keepHistory, setKeepHistory] = useState(true);
    const [clearAfter, setClearAfter] = useState("never");

    useEffect(() => {
        let cancelled = false;
        Promise.all([getSetting(SAVE_KEY), getSetting(CLEAR_AFTER_KEY)])
            .then(([save, after]) => {
                if (cancelled) return;
                setKeepHistory(parseBool(save, true));
                setClearAfter(CLEAR_AFTER_CHOICES.some(c => c.value === after) ? (after as string) : "never");
            })
            .catch(() => { /* keep the defaults */ });
        return () => { cancelled = true; };
    }, []);

    const handleKeepChange = async () => {
        const next = !keepHistory;
        setKeepHistory(next);
        try {
            await setSetting(SAVE_KEY, next.toString());
        } catch {
            setKeepHistory(!next);
        }
    };

    const handleClearAfterChange = async (value: string) => {
        const previous = clearAfter;
        setClearAfter(value);
        try {
            await setSetting(CLEAR_AFTER_KEY, value);
            onRetentionChange?.();
        } catch {
            setClearAfter(previous);
        }
    };
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
                    <h3 className="text-base font-bold mb-1">{labels.aliasSearch} History</h3>
                    <p className="text-xs text-[#aaaaaa]">
                        {entries.length} saved searches across {dates.length} day(s)
                        {!keepHistory && " · New searches aren't being saved"}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {view === "timeline" && canClear && entries.length > 0 && (
                        <button
                            onClick={onClearAll}
                            className={settingsPrimaryBtn}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Clear All
                        </button>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-4">
                {HISTORY_VIEWS.map(({ id, label, Icon }) => (
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

            {view === "settings" && (
                <div className="bg-[#121212] border border-[#303030] rounded-xl divide-y divide-[#252525]">
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                        <div>
                            <div className="text-sm font-bold">Keep search history</div>
                            <div className="text-[11px] text-[#aaaaaa]">When off, new searches aren't saved. Entries already saved stay until you clear them.</div>
                        </div>
                        <Toggle
                            on={keepHistory}
                            label="Keep search history"
                            onChange={handleKeepChange}
                            disabled={isLocked(SAVE_KEY)}
                            title={isLocked(SAVE_KEY) ? LOCKED_TITLE : undefined}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                        <div>
                            <div className="text-sm font-bold">Clear history after</div>
                            <div className="text-[11px] text-[#aaaaaa]">Older searches are removed automatically.</div>
                        </div>
                        <select
                            value={clearAfter}
                            onChange={(e) => handleClearAfterChange(e.target.value)}
                            disabled={!canClear || isLocked(CLEAR_AFTER_KEY)}
                            title={isLocked(CLEAR_AFTER_KEY) ? LOCKED_TITLE : undefined}
                            className="bg-[#0f0f0f] border border-[#303030] text-sm text-white rounded-lg px-3 py-1.5 outline-none cursor-pointer hover:bg-[#202020] transition-colors disabled:opacity-50 disabled:cursor-default shrink-0"
                        >
                            {CLEAR_AFTER_CHOICES.map(c => (
                                <option key={c.value} value={c.value}>{c.label}</option>
                            ))}
                        </select>
                    </div>
                </div>
            )}

            {view === "settings" ? null : entries.length === 0 ? (
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
                                    <Clock className="w-3.5 h-3.5 text-[#555]" />
                                    <span className="text-[11px] font-bold text-[#555] uppercase tracking-widest">
                                        {new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
                                            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
                                        })}
                                    </span>
                                </div>
                                {canClear && (
                                <button
                                    onClick={() => onClearDate(date)}
                                    className="text-[10px] font-bold text-[#555] hover:text-red-500 transition-colors cursor-pointer flex items-center gap-1"
                                >
                                    <Trash2 className="w-3 h-3" />
                                    Clear day
                                </button>
                                )}
                            </div>
                            <div className="bg-[#141414] border border-[#222] rounded-xl overflow-hidden divide-y divide-[#1e1e1e]">
                                {grouped[date].map(entry => (
                                    <div key={entry.id} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-white/[0.02] transition-colors">
                                        <Clock className="w-3 h-3 text-[#444] shrink-0" />
                                        <span className="flex-1 text-sm text-[#aaaaaa] truncate">{decodeHtmlEntities(entry.search_query)}</span>
                                        <span className="text-[10px] text-[#444] shrink-0">
                                            {entry.searchedAt.split(' ')[1]?.slice(0, 5) ?? ''}
                                        </span>
                                        {canClear && (
                                        <button
                                            onClick={() => onDeleteEntry(entry.id)}
                                            className="p-1 hover:text-red-500 text-[#444] transition-all cursor-pointer shrink-0"
                                            title="Remove"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                        )}
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
