import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown, Layers } from "lucide-react";
import { getWorkspaceStatus, openWorkspace, type WorkspaceStatus } from "../../api";
import { useFlags } from "../../hooks/useFlags";
import { WorkspaceLauncher } from "./WorkspaceLauncher";
import { errText, reloadApp } from "./helpers";

interface Props {
    /**
     * "name": the workspace's name under the app title, with a chevron; the menu drops below it.
     * "rail": a full-width bar stuck to the bottom of the vertical rail, which has no room for the name; the menu opens to its right.
     */
    variant: "name" | "rail";
    /** The workspace's name, for the "name" variant. */
    name?: string;
}

// Only the few most recent ones: the full list is the "Workspaces" screen.
const MAX_LISTED = 6;

/**
 * The quick switcher, attached to what it changes: click the workspace's name (or, in the vertical
 * layout, a full-width bar at the very bottom of the rail) to drop the most recent workspaces, with a
 * "Workspaces" entry at the bottom for the full picker (create, import, open).
 */
export function WorkspaceSwitcher({ variant, name }: Props) {
    const { flags } = useFlags();
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<WorkspaceStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [switching, setSwitching] = useState<string | null>(null);
    const [picker, setPicker] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    // Where the menu goes, worked out from the button when it opens (it's drawn on the page, not in the header).
    const [at, setAt] = useState<React.CSSProperties>({});

    // Read fresh each time it's opened: the list changes as workspaces are used, renamed and removed.
    const toggle = () => {
        if (open) { setOpen(false); return; }
        setError(null);
        const r = box.current?.getBoundingClientRect();
        if (r) {
            setAt(variant === "name"
                ? { top: r.bottom + 6, left: r.left }
                : { left: r.right + 8, bottom: window.innerHeight - r.bottom + 8 });
        }
        setOpen(true);
        getWorkspaceStatus().then(setStatus).catch(e => setError(errText(e)));
    };

    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => {
            const t = e.target as Node;
            if (!box.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
        };
        const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", away);
        document.addEventListener("keydown", escape);
        return () => {
            document.removeEventListener("mousedown", away);
            document.removeEventListener("keydown", escape);
        };
    }, [open]);

    // A DB owner can lock the workspace in place (see lib/flags.ts): the name stays, as plain text.
    if (!flags.allowChangeDbLocation) {
        return variant === "name" ? <span className="text-xs text-gray-500 -mt-0.5">{name}</span> : null;
    }

    const choose = async (folder: string) => {
        setError(null);
        setSwitching(folder);
        try {
            await openWorkspace(folder);
            reloadApp();
        } catch (e) {
            setError(errText(e));
            setSwitching(null);
        }
    };

    const buttonClass = variant === "name"
        ? "flex items-center gap-1 text-xs leading-4 text-gray-500 hover:text-white transition-colors cursor-pointer"
        : "w-full h-6 flex items-center justify-center border-t border-[#272727] text-gray-400 hover:text-white hover:bg-[#272727] transition-colors cursor-pointer";
    const recents = (status?.recents ?? []).slice(0, MAX_LISTED);

    return (
        <div className={variant === "name" ? "relative self-start -mt-0.5" : "relative w-full"} ref={box}>
            <button onClick={toggle} className={buttonClass} title="Switch workspace" aria-haspopup="menu" aria-expanded={open}>
                {variant === "name" && <span className="truncate max-w-64">{name}</span>}
                <ChevronsUpDown className={variant === "name" ? "w-3 h-3 shrink-0" : "w-3.5 h-3.5"} />
            </button>

            {open && createPortal(
                <div ref={menu} role="menu" style={at} className="fixed w-64 bg-[#272727] border border-[#3f3f3f] rounded-lg shadow-xl z-[60] overflow-hidden">
                    {error && <div className="px-4 py-2 text-[11px] text-red-400 break-words border-b border-[#3f3f3f]">{error}</div>}
                    {!status && !error && <div className="px-4 py-3 text-xs text-gray-500">Loading...</div>}
                    {recents.map(w => (
                        <button
                            key={w.folder}
                            role="menuitem"
                            disabled={!w.available || switching !== null}
                            onClick={() => (w.current ? setOpen(false) : choose(w.folder))}
                            title={w.available ? w.path : `${w.path} (not found)`}
                            className={`w-full text-left px-4 py-2 flex items-center gap-2 text-sm hover:bg-[#3f3f3f] disabled:hover:bg-transparent ${w.available ? "cursor-pointer" : "cursor-default"} ${w.available ? (w.current ? "text-white font-bold" : "text-gray-300") : "text-gray-600"}`}
                        >
                            <span className="flex-1 min-w-0 truncate">{w.name}</span>
                            {w.current && <Check className="w-4 h-4 shrink-0" />}
                            {!w.available && <span className="text-[10px] uppercase tracking-wider shrink-0">Not found</span>}
                        </button>
                    ))}
                    <button
                        role="menuitem"
                        onClick={() => { setOpen(false); setPicker(true); }}
                        className="w-full text-left px-4 py-2 flex items-center gap-2 text-sm text-gray-300 hover:bg-[#3f3f3f] cursor-pointer border-t border-[#3f3f3f]"
                    >
                        <Layers className="w-4 h-4 shrink-0" />
                        Workspaces
                    </button>
                </div>,
                document.body,
            )}

            {/* Like the menu, on the page itself rather than inside the header, whose stacking would put it under other layers. */}
            {picker && status && createPortal(<WorkspaceLauncher status={status} onClose={() => setPicker(false)} />, document.body)}
        </div>
    );
}
