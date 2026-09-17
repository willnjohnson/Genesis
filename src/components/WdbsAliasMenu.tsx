import { useState, useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';

interface WdbsAliasMenuProps {
    x: number;
    y: number;
    segment: string;
    initialAlias: string;
    onSave: (alias: string) => void;
    onClose: () => void;
    saving?: boolean;
    error?: string | null;
}

/**
 * Small popover opened by right-clicking a Warp Drive taxonomy node in WdbsTreePanel — lets the
 * user give that node's raw segment (e.g. "JOHN") a more descriptive alias (e.g. "YOUTUBER"),
 * stored as tblWDBS.WDInfo (see api.ts's setWdbsAlias). The alias then shows as a tooltip when
 * hovering the segment in the tree. Mirrors BulkAssignMenu's popover pattern (position clamped
 * on-screen, closes on outside-click/Escape).
 */
export function WdbsAliasMenu({ x, y, segment, initialAlias, onSave, onClose, saving = false, error }: WdbsAliasMenuProps) {
    const [input, setInput] = useState(initialAlias);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Keeps the popover on-screen regardless of where the right-click landed.
    const MENU_WIDTH = 260;
    const MENU_HEIGHT = 130;
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 12);

    return (
        <div
            ref={containerRef}
            style={{ left, top, width: MENU_WIDTH }}
            className="fixed z-[200] bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-3 animate-in fade-in zoom-in-95 duration-150"
            onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
                if (e.key === 'Enter') onSave(input.trim());
            }}
        >
            <div className="text-xs font-bold text-white mb-2 truncate">
                Alias for {segment}
            </div>
            <div className="flex items-center gap-1.5">
                <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={segment}
                    disabled={saving}
                    className="flex-1 min-w-0 bg-[#121212] border border-[#333] focus:border-red-600/50 outline-none rounded-md px-2 py-1.5 text-[11px] text-white placeholder-[#555] transition-colors disabled:opacity-50"
                />
                <button
                    onClick={() => onSave(input.trim())}
                    disabled={saving}
                    title="Save"
                    className="text-green-500 hover:text-green-400 transition-colors cursor-pointer p-1.5 disabled:opacity-50 shrink-0"
                >
                    <Check className="w-4 h-4" />
                </button>
                <button
                    onClick={onClose}
                    disabled={saving}
                    title="Cancel"
                    className="text-[#aaaaaa] hover:text-white transition-colors cursor-pointer p-1.5 disabled:opacity-50 shrink-0"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
            <p className="text-[10px] text-[#666] mt-1.5">Leave blank to clear the alias.</p>
            {error && (
                <div className="mt-2 text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5">
                    {error}
                </div>
            )}
        </div>
    );
}
