import { useState, useEffect, useRef } from 'react';
import { Check, ListPlus, X } from 'lucide-react';
import { getWdbsSuggestions, decodeWdbs } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';
import { handleWdbsInputChange } from '../lib/wdbs-input';

interface BulkAssignMenuProps {
    x: number;
    y: number;
    count: number;
    onAssign: (wdbs: string) => void;
    /** Drive assignment is only offered when the DB owner allows editing Drives (allowEditWDBS). */
    canAssignDrive: boolean;
    /** Adding to a Drive's sequence is only offered when sequences are on and editable. */
    canAddToSequence: boolean;
    /** The Drive picked in the Library's Drive panel (display path), offered as the sequence to add to. */
    defaultSequenceDrive: string;
    onAddToSequence: (drive: string) => void;
    onClose: () => void;
    assigning?: boolean;
    error?: string | null;
}

/**
 * Small popover opened by right-clicking a video card in Bulk Assign Mode (see App.tsx) — lets
 * the user type or pick an existing Drive category and apply it to every currently-selected
 * video in one action, and/or add the selection to a Drive's sequence (in the order shown in the
 * grid). Closes on outside-click or Escape, same pattern SearchBar.tsx uses for its own history
 * dropdown.
 */
export function BulkAssignMenu({
    x, y, count, onAssign, canAssignDrive, canAddToSequence, defaultSequenceDrive, onAddToSequence,
    onClose, assigning = false, error,
}: BulkAssignMenuProps) {
    const { labels } = useWorkspace();
    const [input, setInput] = useState('');
    const [sequenceDrive, setSequenceDrive] = useState(defaultSequenceDrive);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const sequenceInputRef = useRef<HTMLInputElement>(null);
    const noun = `video${count === 1 ? '' : 's'}`;

    useEffect(() => {
        getWdbsSuggestions().then(paths => setSuggestions(paths.map(decodeWdbs).filter(Boolean))).catch(() => {});
    }, []);

    useEffect(() => {
        (canAssignDrive ? inputRef : sequenceInputRef).current?.focus();
    }, [canAssignDrive]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Keeps the popover on-screen regardless of where the right-click landed. Wider than it used to
    // be (288px): a Drive path or sequence path can run long, and the old width cramped it as you typed.
    const MENU_WIDTH = 384;
    const MENU_HEIGHT = 40 + (canAssignDrive ? 120 : 0) + (canAddToSequence ? 130 : 0);
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 12);

    const inputClass = 'flex-1 min-w-0 bg-[#121212] border border-[#333] focus:border-red-600/50 outline-none rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] font-mono transition-colors disabled:opacity-50';

    return (
        <div
            ref={containerRef}
            style={{ left, top, width: MENU_WIDTH }}
            className="fixed z-[200] bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-3 animate-in fade-in zoom-in-95 duration-150"
            onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
            }}
        >
            <datalist id="bulk-assign-wdbs-suggestions">
                {suggestions.map(s => <option key={s} value={s} />)}
            </datalist>

            {canAssignDrive && (
                <>
                    <div className="text-xs font-bold text-white mb-2">
                        Assign {count} {noun} to {labels.aliasDriveName}
                    </div>
                    <div className="flex items-center gap-1.5">
                        <input
                            ref={inputRef}
                            type="text"
                            list="bulk-assign-wdbs-suggestions"
                            value={input}
                            onChange={(e) => handleWdbsInputChange(e, setInput)}
                            onKeyDown={(e) => { if (e.key === 'Enter') onAssign(input.trim()); }}
                            placeholder=":CS-ML-REINF"
                            disabled={assigning}
                            className={inputClass}
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
                </>
            )}

            {canAddToSequence && (
                <div className={canAssignDrive ? 'mt-3 pt-3 border-t border-[#333]' : ''}>
                    <div className="text-xs font-bold text-white mb-2">
                        Add {count} {noun} to a sequence
                    </div>
                    <div className="flex items-center gap-1.5">
                        <input
                            ref={sequenceInputRef}
                            type="text"
                            list="bulk-assign-wdbs-suggestions"
                            value={sequenceDrive}
                            onChange={(e) => handleWdbsInputChange(e, setSequenceDrive)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && sequenceDrive.trim()) onAddToSequence(sequenceDrive.trim()); }}
                            placeholder=":CS-DSA"
                            disabled={assigning}
                            className={inputClass}
                        />
                        <button
                            onClick={() => onAddToSequence(sequenceDrive.trim())}
                            disabled={assigning || !sequenceDrive.trim()}
                            title="Add to this Drive's sequence"
                            className="text-green-500 hover:text-green-400 transition-colors cursor-pointer p-1.5 disabled:opacity-50 shrink-0"
                        >
                            <ListPlus className="w-4 h-4" />
                        </button>
                        {!canAssignDrive && (
                            <button
                                onClick={onClose}
                                disabled={assigning}
                                title="Cancel"
                                className="text-[#aaaaaa] hover:text-white transition-colors cursor-pointer p-1.5 disabled:opacity-50 shrink-0"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                    <p className="text-[10px] text-[#666] mt-1.5">Added in the order shown. Ones already in it are skipped.</p>
                </div>
            )}

            {error && (
                <div className="mt-2 text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5">
                    {error}
                </div>
            )}
        </div>
    );
}
