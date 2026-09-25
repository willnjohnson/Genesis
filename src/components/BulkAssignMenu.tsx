import { useState, useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { getWdbsSuggestions, decodeWdbs } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';
import { handleWdbsInputChange } from '../lib/wdbs-input';

interface BulkAssignMenuProps {
    x: number;
    y: number;
    count: number;
    /** Sets the selection's Drive (blank clears them back to unassigned). `alsoSequence` reflects
     *  the checkbox — only meaningful when canAddToSequence is also true; the caller runs it as a
     *  second step after the assignment succeeds, so "not filed under X" can't happen for it. */
    onAssign: (wdbs: string, alsoSequence: boolean) => void;
    /** Drive assignment is only offered when the DB owner allows editing Drives (allowEditWDBS). */
    canAssignDrive: boolean;
    /** Adding to a Drive's sequence is only offered when sequences are on and editable. */
    canAddToSequence: boolean;
    /** The Drive picked in the Library's Drive panel (display path), used to prefill the field. */
    defaultDrive: string;
    /** Used instead of onAssign when canAssignDrive is false: sequence-only, no assignment step,
     *  so it can only add videos already filed under the typed Drive. */
    onAddToSequence: (drive: string) => void;
    onClose: () => void;
    assigning?: boolean;
    error?: string | null;
}

/**
 * Small popover opened by right-clicking a video card in Bulk Assign Mode (see App.tsx) — lets
 * the user type or pick an existing Drive category and apply it to every currently-selected video
 * in one action. When both Drive assignment and sequence editing are allowed, a single field drives
 * both: assigning and (via a checkbox, checked by default) appending the same videos to that
 * Drive's sequence right after, so the sequence step can never reject them as "not filed under X" —
 * they were just filed there. A DB owner who's allowed sequence editing but not Drive assignment
 * instead gets a sequence-only field, which (like before) can only add videos already filed under
 * the Drive typed. Closes on outside-click or Escape, same pattern SearchBar.tsx uses for its own
 * history dropdown.
 */
export function BulkAssignMenu({
    x, y, count, onAssign, canAssignDrive, canAddToSequence, defaultDrive, onAddToSequence,
    onClose, assigning = false, error,
}: BulkAssignMenuProps) {
    const { labels } = useWorkspace();
    const [input, setInput] = useState(defaultDrive);
    const [alsoSequence, setAlsoSequence] = useState(true);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const noun = `video${count === 1 ? '' : 's'}`;
    const both = canAssignDrive && canAddToSequence;

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

    const submit = () => {
        const value = input.trim();
        if (canAssignDrive) {
            onAssign(value, both && alsoSequence);
        } else if (value) {
            onAddToSequence(value);
        }
    };

    // Keeps the popover on-screen regardless of where the right-click landed. Wider than it used to
    // be (288px): a Drive path can run long, and the old width cramped it as you typed.
    const MENU_WIDTH = 384;
    const MENU_HEIGHT = 130 + (both ? 28 : 0);
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 12);

    const inputClass = 'flex-1 min-w-0 bg-[#121212] border border-[#333] focus:border-red-600/50 outline-none rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] font-mono transition-colors disabled:opacity-50';
    const canSubmit = canAssignDrive || !!input.trim();

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

            <div className="text-xs font-bold text-white mb-2">
                {canAssignDrive
                    ? `Assign ${count} ${noun} to ${labels.aliasDriveName}`
                    : `Add ${count} ${noun} to a sequence`}
            </div>
            <div className="flex items-center gap-1.5">
                <input
                    ref={inputRef}
                    type="text"
                    list="bulk-assign-wdbs-suggestions"
                    value={input}
                    onChange={(e) => handleWdbsInputChange(e, setInput)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submit(); }}
                    placeholder=":CS-ML-REINF"
                    disabled={assigning}
                    className={inputClass}
                />
                <button
                    onClick={submit}
                    disabled={assigning || !canSubmit}
                    title={canAssignDrive ? "Assign" : "Add to this Drive's sequence"}
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

            {both && (
                <label className="flex items-center gap-2 mt-2.5 text-xs text-[#ccc] cursor-pointer">
                    <input
                        type="checkbox"
                        checked={alsoSequence}
                        onChange={(e) => setAlsoSequence(e.target.checked)}
                        disabled={assigning}
                        className="cursor-pointer"
                    />
                    Also add to this {labels.aliasDriveName}'s sequence
                </label>
            )}

            <p className="text-[10px] text-[#666] mt-1.5">
                {canAssignDrive
                    ? both
                        ? "Leave blank to clear back to unassigned (skips sequencing). Sequenced in the order shown; already-included videos are skipped."
                        : "Leave blank to clear back to unassigned."
                    : "Added in the order shown. Ones already in it are skipped."}
            </p>

            {error && (
                <div className="mt-2 text-[10px] text-red-400 bg-red-900/20 border border-red-500/30 rounded-md px-2 py-1.5">
                    {error}
                </div>
            )}
        </div>
    );
}
