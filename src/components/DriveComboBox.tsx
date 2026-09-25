import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { handleWdbsInputChange } from '../lib/wdbs-input';

interface DriveComboBoxProps {
    value: string;
    onValueChange: (v: string) => void;
    /** Every existing Drive path (display form), shown under "Auto-Complete", narrowed by `value`. */
    suggestions: string[];
    /** Drives this video's channel already appears in elsewhere (display form) — always shown in
     *  full under "Suggested", regardless of `value`, so it stays visible as a fixed set of
     *  "here's where this channel usually goes" options while typing anything else. Left out of
     *  Auto-Complete so nothing is listed twice. */
    suggestedDrives: string[];
    onEnter?: () => void;
    onEscape?: () => void;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    className?: string;
}

// How tall the dropdown tries to be — tall enough to actually show a bunch of entries at once,
// not just 3-4 — clamped down to whatever room is actually available above/below the input.
const PREFERRED_MAX_HEIGHT = 384;
const MIN_USABLE_HEIGHT = 120;
const VIEWPORT_MARGIN = 6;

/** A Warp Drive text input with a two-section dropdown: Suggested (this video's channel's other
 *  Drives, from getHandleDrives) above Auto-Complete (every existing Drive path, from
 *  getWdbsSuggestions, narrowed by what's typed). Replaces a plain `<input list="...">` datalist,
 *  which can't render the two as separate labeled groups — typing still sanitizes exactly as
 *  before (handleWdbsInputChange), this only adds the dropdown UI on top.
 *
 *  The dropdown itself is portaled to document.body and positioned from the input's own
 *  getBoundingClientRect rather than living in normal flow: this field is used inside the Edit
 *  Warp modal's scrollable body (SequenceDock.tsx), whose `overflow-y-auto`/`max-h-[70vh]` would
 *  otherwise clip an in-flow dropdown no matter its z-index. Repositions (and flips to open
 *  upward) on scroll/resize while open. */
export function DriveComboBox({ value, onValueChange, suggestions, suggestedDrives, onEnter, onEscape, placeholder, disabled, autoFocus, className }: DriveComboBoxProps) {
    const [open, setOpen] = useState(false);
    const [highlighted, setHighlighted] = useState(0);
    const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const upper = value.toUpperCase();
    const suggestedSet = new Set(suggestedDrives);
    const autoFiltered = suggestions
        .filter(s => (!upper || s.toUpperCase().includes(upper)) && !suggestedSet.has(s))
        .sort()
        .slice(0, 30);
    const flat = [...suggestedDrives, ...autoFiltered];

    useLayoutEffect(() => { setHighlighted(0); }, [value, open]);

    useLayoutEffect(() => {
        if (!open) return;
        const updatePosition = () => {
            const el = inputRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
            const spaceAbove = rect.top - VIEWPORT_MARGIN;
            const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
            const maxHeight = Math.max(Math.min(PREFERRED_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow), MIN_USABLE_HEIGHT);
            setDropdownStyle({
                position: 'fixed',
                left: rect.left,
                width: rect.width,
                maxHeight,
                ...(openUp ? { bottom: window.innerHeight - rect.top + VIEWPORT_MARGIN } : { top: rect.bottom + VIEWPORT_MARGIN }),
            });
        };
        updatePosition();
        // `true` (capture) so this also fires for a scroll inside the Edit Warp modal's own
        // scrollable body, not just the window itself.
        window.addEventListener('scroll', updatePosition, true);
        window.addEventListener('resize', updatePosition);
        return () => {
            window.removeEventListener('scroll', updatePosition, true);
            window.removeEventListener('resize', updatePosition);
        };
    }, [open]);

    const select = (v: string) => {
        onValueChange(v);
        setOpen(false);
        inputRef.current?.focus();
    };

    const row = (s: string, idx: number, key: string) => (
        <div
            key={key}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => select(s)}
            onMouseEnter={() => setHighlighted(idx)}
            className={`px-3 py-1.5 text-sm font-mono truncate cursor-pointer ${highlighted === idx ? 'bg-[#272727] text-white' : 'text-gray-200 hover:bg-[#272727]'}`}
        >
            {s}
        </div>
    );

    return (
        <div className="relative flex-1 min-w-0">
            <input
                ref={inputRef}
                type="text"
                autoFocus={autoFocus}
                value={value}
                disabled={disabled}
                placeholder={placeholder}
                onFocus={() => setOpen(true)}
                // Delayed so a list item's onClick still fires before the dropdown unmounts underneath it.
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onChange={(e) => handleWdbsInputChange(e, onValueChange)}
                onKeyDown={(e) => {
                    if (open && flat.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                        e.preventDefault();
                        const delta = e.key === 'ArrowDown' ? 1 : -1;
                        setHighlighted(h => (h + delta + flat.length) % flat.length);
                        return;
                    }
                    if (e.key === 'Enter') {
                        if (open && flat.length > 0) {
                            e.preventDefault();
                            select(flat[highlighted]);
                            return;
                        }
                        onEnter?.();
                        return;
                    }
                    if (e.key === 'Escape') {
                        if (open) { e.stopPropagation(); setOpen(false); return; }
                        onEscape?.();
                    }
                }}
                className={`w-full ${className ?? ''}`}
            />
            {open && flat.length > 0 && dropdownStyle && createPortal(
                <div
                    style={dropdownStyle}
                    className="z-[200] overflow-y-auto bg-[#1a1a1a] border border-[#333] rounded-lg shadow-xl py-1 custom-scrollbar"
                >
                    {suggestedDrives.length > 0 && (
                        <>
                            <div className="px-3 pt-1.5 pb-1 text-[10px] font-bold text-gray-500 uppercase tracking-widest">Suggested</div>
                            {suggestedDrives.map((s, i) => row(s, i, `sg-${s}`))}
                        </>
                    )}
                    {autoFiltered.length > 0 && (
                        <>
                            <div className="px-3 pt-1.5 pb-1 text-[10px] font-bold text-gray-500 uppercase tracking-widest">Auto-Complete</div>
                            {autoFiltered.map((s, i) => row(s, suggestedDrives.length + i, `ac-${s}`))}
                        </>
                    )}
                </div>,
                document.body,
            )}
        </div>
    );
}
