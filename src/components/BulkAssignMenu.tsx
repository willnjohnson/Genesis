import { useState, useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { getWdbsSuggestions, decodeWdbs } from '../api';
import { BRAND } from '../branding';

interface BulkAssignMenuProps {
    x: number;
    y: number;
    count: number;
    onAssign: (wdbs: string) => void;
    onClose: () => void;
    assigning?: boolean;
    error?: string | null;
}

/**
 * Small popover opened by right-clicking a video card in Bulk Assign Mode (see App.tsx) — lets
 * the user type or pick an existing Warp Drive category and apply it to every currently-selected
 * video in one action. Closes on outside-click or Escape, same pattern SearchBar.tsx uses for
 * its own history dropdown.
 */
export function BulkAssignMenu({ x, y, count, onAssign, onClose, assigning = false, error }: BulkAssignMenuProps) {
    const [input, setInput] = useState('');
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        getWdbsSuggestions().then(paths => setSuggestions(paths.map(decodeWdbs).filter(Boolean))).catch(() => {});
    }, []);

    useEffect(() => {
        inputRef.current?.focus();
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
    const MENU_WIDTH = 288;
    const MENU_HEIGHT = 160;
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 12);

    return (
        <div
            ref={containerRef}
            style={{ left, top, width: MENU_WIDTH }}
            className="fixed z-[200] bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-3 animate-in fade-in zoom-in-95 duration-150"
            onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
                if (e.key === 'Enter') onAssign(input.trim());
            }}
        >
            <datalist id="bulk-assign-wdbs-suggestions">
                {suggestions.map(s => <option key={s} value={s} />)}
            </datalist>
            <div className="text-xs font-bold text-white mb-2">
                Assign {count} video{count === 1 ? '' : 's'} to {BRAND.driveLabel}
            </div>
            <div className="flex items-center gap-1.5">
                <input
                    ref={inputRef}
                    type="text"
                    list="bulk-assign-wdbs-suggestions"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder=":UAP-GERB-VVV"
                    disabled={assigning}
                    className="flex-1 min-w-0 bg-[#121212] border border-[#333] focus:border-red-600/50 outline-none rounded-md px-2 py-1.5 text-[11px] text-white placeholder-[#555] font-mono transition-colors disabled:opacity-50"
                />
                <button
                    onClick={() => onAssign(input.trim())}
                    disabled={assigning}
                    title="Assign"
                    className="text-green-500 hover:text-green-400 transition-colors cursor-pointer p-1.5 disabled:opacity-50 shrink-0"
                >
                    <Check className="w-4 h-4" />
                </button>
                <button
                    onClick={onClose}
                    disabled={assigning}
                    title="Cancel"
                    className="text-[#aaaaaa] hover:text-white transition-colors cursor-pointer p-1.5 disabled:opacity-50 shrink-0"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
            <p className="text-[10px] text-[#666] mt-1.5">Leave blank to clear back to unassigned.</p>
            {error && (
                <div className="mt-2 text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5">
                    {error}
                </div>
            )}
        </div>
    );
}
