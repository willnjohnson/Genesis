import { useEffect, useRef } from 'react';
import { Ban } from 'lucide-react';
import { WDBS_ICON_OPTIONS } from '../lib/wdbs-icons';

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
 * extra click. Mirrors the same popover positioning/outside-click/Escape pattern.
 */
export function WdbsIconMenu({ x, y, segment, currentIcon, onSelect, onClose, saving = false, error }: WdbsIconMenuProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    const MENU_WIDTH = 224;
    const MENU_HEIGHT = 290;
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 12);

    return (
        <div
            ref={containerRef}
            style={{ left, top, width: MENU_WIDTH }}
            className="fixed z-[200] bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-3 animate-in fade-in zoom-in-95 duration-150"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        >
            <div className="text-xs font-bold text-white mb-2 truncate">
                Icon for {segment}
            </div>
            <div className="grid grid-cols-4 gap-1.5">
                <button
                    onClick={() => onSelect('')}
                    disabled={saving}
                    title="None"
                    className={`flex flex-col items-center justify-center gap-1 rounded-lg py-2 text-[9px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${!currentIcon ? 'bg-red-600 text-white' : 'bg-[#121212] text-gray-400 hover:text-white hover:bg-[#272727]'}`}
                >
                    <Ban className="w-4 h-4" />
                    None
                </button>
                {WDBS_ICON_OPTIONS.map(({ key, label, Icon }) => (
                    <button
                        key={key}
                        onClick={() => onSelect(key)}
                        disabled={saving}
                        title={label}
                        className={`flex flex-col items-center justify-center gap-1 rounded-lg py-2 text-[9px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${currentIcon === key ? 'bg-red-600 text-white' : 'bg-[#121212] text-gray-400 hover:text-white hover:bg-[#272727]'}`}
                    >
                        <Icon className="w-4 h-4" />
                        {label}
                    </button>
                ))}
            </div>
            {error && (
                <div className="mt-2 text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5">
                    {error}
                </div>
            )}
        </div>
    );
}
