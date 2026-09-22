import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

// A collapsed-by-default group in the export screens: the title, a one-line summary of what's chosen
// inside (so nothing is hidden), and the controls when opened. Keeps the screens short.
export function ExportSection({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="border border-[#2f2f2f] rounded-lg">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-white cursor-pointer"
            >
                {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
                <span>{title}</span>
                <span className="ml-auto pl-3 text-[11px] font-normal text-[#aaaaaa] truncate">{summary}</span>
            </button>
            {open && <div className="px-3 pb-3 pt-1 space-y-3">{children}</div>}
        </div>
    );
}

// A labelled dropdown row, for the follow-up choices (one line each instead of a stack of radio buttons).
export function ChoiceField<T extends string>({ label, value, options, onChange, disabled }: {
    label: string;
    value: T;
    options: { value: T; label: string }[];
    onChange: (next: T) => void;
    disabled?: boolean;
}) {
    return (
        <label className="block space-y-1">
            <span className="block text-[11px] text-[#aaaaaa]">{label}</span>
            <select
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value as T)}
                className="w-full bg-[#222222] border border-[#383838] rounded-md px-2 py-1.5 text-xs text-white cursor-pointer disabled:opacity-50 disabled:cursor-default"
            >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        </label>
    );
}
