import { Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface CheckboxOption {
    value: string;
    label: string;
    /** Shown on hover. */
    hint?: string;
    /** Small text at the right of the row, e.g. a count. */
    detail?: string;
    /** Shown dimmed and can't be changed (for an option that depends on another one). */
    disabled?: boolean;
}

interface Props {
    options: CheckboxOption[];
    /** The values that are ticked. */
    selected: string[];
    onChange: (next: string[]) => void;
    /** What the closed button says, so the choice is readable without opening the list. */
    summary: string;
    disabled?: boolean;
    /** Adds All / None at the top of the list. */
    allNone?: boolean;
    /** The side the list prefers to open on. It flips to the other side when there isn't room. */
    placement?: "down" | "up";
}

const LIST_MAX_HEIGHT = 240;
const EDGE_GAP = 8;

interface ListPosition {
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

/** A dropdown of checkboxes, the same idea as the Glossary's drive picker: the closed button shows a
 *  summary and clicking outside or pressing Escape closes the list. The list is drawn on the page
 *  itself (not inside whatever contains the button), so a dialog or scroll area can't cut it off. */
export function CheckboxDropdown({ options, selected, onChange, summary, disabled, allNone, placement = "down" }: Props) {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<ListPosition | null>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Where the list goes: under (or over) the button, as wide as it, flipped when the preferred
    // side is too short, and never taller than the room there is.
    const place = () => {
        const rect = boxRef.current?.getBoundingClientRect();
        if (!rect) return;
        const below = window.innerHeight - rect.bottom - EDGE_GAP;
        const above = rect.top - EDGE_GAP;
        const enough = Math.min(LIST_MAX_HEIGHT, 160);
        const preferred = placement === "up" ? above : below;
        const other = placement === "up" ? below : above;
        const up = (placement === "up") !== (preferred < enough && other > preferred);
        setPosition({
            left: rect.left,
            width: rect.width,
            ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
            maxHeight: Math.max(96, Math.min(LIST_MAX_HEIGHT, up ? above : below)),
        });
    };

    useLayoutEffect(() => {
        if (!open) return;
        place();
        // Follow the button when the page or any scroll area around it moves or resizes.
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, placement]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (!boxRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                // Close just the list, not the dialog behind it.
                e.stopPropagation();
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [open]);

    const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
    // All / None leave the disabled ones as they are.
    const changeable = options.filter(o => !o.disabled).map(o => o.value);
    const setAll = (on: boolean) => onChange([...selected.filter(v => !changeable.includes(v)), ...(on ? changeable : [])]);
    const linkBtn = "hover:text-white disabled:opacity-40 disabled:hover:text-[#aaaaaa] cursor-pointer disabled:cursor-default";

    return (
        <div ref={boxRef} className="relative">
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen(o => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className="w-full flex items-center justify-between gap-2 bg-[#222222] border border-[#383838] hover:border-[#505050] rounded-md px-2 py-1.5 text-xs text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
            >
                <span className="truncate">{summary}</span>
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-[#aaaaaa] transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && position && createPortal(
                <div
                    ref={listRef}
                    role="listbox"
                    aria-multiselectable="true"
                    style={{ position: "fixed", left: position.left, width: position.width, top: position.top, bottom: position.bottom, maxHeight: position.maxHeight }}
                    className="z-[100] overflow-y-auto bg-[#141414] border border-[#383838] rounded-md py-1 shadow-xl"
                >
                    {allNone && (
                        <div className="flex items-center justify-end gap-3 px-3 py-1 text-[11px] text-[#aaaaaa] border-b border-[#2a2a2a] mb-1">
                            <button type="button" disabled={changeable.every(v => selected.includes(v))} className={linkBtn} onClick={() => setAll(true)}>All</button>
                            <button type="button" disabled={!changeable.some(v => selected.includes(v))} className={linkBtn} onClick={() => setAll(false)}>None</button>
                        </div>
                    )}
                    {options.map(o => {
                        const on = selected.includes(o.value);
                        return (
                            <button
                                key={o.value}
                                type="button"
                                role="option"
                                aria-selected={on}
                                aria-disabled={o.disabled}
                                title={o.hint}
                                onClick={() => { if (!o.disabled) toggle(o.value); }}
                                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left text-gray-200 transition-colors ${o.disabled ? "opacity-40 cursor-default" : "hover:bg-[#222222] cursor-pointer"}`}
                            >
                                <span className={`w-3.5 h-3.5 shrink-0 rounded border flex items-center justify-center ${on ? "bg-[var(--k-accent)] border-[var(--k-accent)]" : "border-[#555]"}`}>
                                    {on && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
                                </span>
                                <span className="min-w-0 truncate">{o.label}</span>
                                {o.detail && <span className="ml-auto shrink-0 text-[11px] text-[#666666]">{o.detail}</span>}
                            </button>
                        );
                    })}
                </div>,
                document.body,
            )}
        </div>
    );
}
