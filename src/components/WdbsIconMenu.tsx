import { useEffect, useRef, useState } from 'react';
import { Ban, Search } from 'lucide-react';
import { WDBS_ICON_OPTIONS } from '../lib/wdbs-icons';
import { handlePlainContextMenu } from '../lib/markdown-editor';

interface WdbsIconMenuProps {
    x: number;
    y: number;
    segment: string;
    currentIcon: string | null;
    onSelect: (icon: string) => void;
    onClose: () => void;
    saving?: boolean;
    error?: string | null;
}

/**
 * Small popover opened by right-clicking a Warp Drive taxonomy node in WdbsTreePanel — lets the
 * user pick one of a fixed set of icons (or clear it) to show to the left of that node's segment
 * name in the tree, stored as tblWDBS.WDIcon (see api.ts's setWdbsIcon). Unlike WdbsAliasMenu, a
 * click commits immediately — there's nothing to type, so a separate Save step would just be an
 * extra click, and the popover stays open so several can be tried in a row (closed by clicking outside or
 * Escape). Mirrors the same popover positioning/outside-click/Escape pattern. A list (not a grid), with a
 * filter box above it: typing narrows it by name, Enter takes the first match.
 */
export function WdbsIconMenu({ x, y, segment, currentIcon, onSelect, onClose, saving = false, error }: WdbsIconMenuProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [filter, setFilter] = useState('');

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Capped rather than sized to fit every icon exactly — the picker (WDBS_ICON_OPTIONS) keeps
    // growing, and a fixed-to-content height would need bumping again each time. Past the cap the
    // list scrolls internally instead. Same height cap as WdbsColorMenu, whose lists these rows match.
    const MENU_WIDTH = 224;
    const MAX_MENU_HEIGHT = 420;
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const top = Math.min(y, window.innerHeight - MAX_MENU_HEIGHT - 12);

    const query = filter.trim().toLowerCase();
    const matches = query ? WDBS_ICON_OPTIONS.filter(o => o.label.toLowerCase().includes(query)) : WDBS_ICON_OPTIONS;

    const rowClass = (on: boolean) =>
        `flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${on ? 'bg-red-600 text-white' : 'bg-[#121212] text-gray-400 hover:text-white hover:bg-[#272727]'}`;

    return (
        <div
            ref={containerRef}
            style={{ left, top, width: MENU_WIDTH, maxHeight: MAX_MENU_HEIGHT }}
            className="fixed z-[200] bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-3 animate-in fade-in zoom-in-95 duration-150 flex flex-col"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        >
            <div className="text-xs font-bold text-white mb-2 truncate shrink-0">
                Icon for {segment}
            </div>
            <div className="relative mb-2 shrink-0">
                <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                    autoFocus
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onContextMenu={handlePlainContextMenu}
                    onKeyDown={(e) => {
                        // Enter takes the first icon still listed.
                        if (e.key === 'Enter' && matches.length > 0 && !saving) {
                            e.preventDefault();
                            onSelect(matches[0].key);
                        }
                    }}
                    placeholder="Filter icons"
                    className="w-full bg-[#121212] border border-[#333] focus:border-red-600/50 outline-none rounded-md pl-8 pr-2 py-1.5 text-xs text-white placeholder-[#555]"
                />
            </div>
            <div className="flex flex-col gap-1 overflow-y-auto custom-scrollbar pr-0.5 min-h-0">
                {/* None only while nothing is typed: it isn't an icon, so a filter never matches it. */}
                {!query && (
                    <button onClick={() => onSelect('')} disabled={saving} className={rowClass(!currentIcon)}>
                        <Ban className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">None</span>
                    </button>
                )}
                {matches.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-gray-500 italic">No matching icons</div>
                )}
                {matches.map(({ key, label, Icon }) => (
                    <button key={key} onClick={() => onSelect(key)} disabled={saving} className={rowClass(currentIcon === key)}>
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{label}</span>
                    </button>
                ))}
            </div>
            {error && (
                <div className="mt-2 text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5 shrink-0">
                    {error}
                </div>
            )}
        </div>
    );
}
