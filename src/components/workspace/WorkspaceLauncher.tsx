import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, ChevronRight, FolderOpen, FolderPlus, HardDrive, PackageOpen, X } from "lucide-react";
import { BRAND } from "../../branding";
import { BrandLogo } from "../BrandLogo";
import { useFlags } from "../../hooks/useFlags";
import {
    forgetWorkspace, getWorkspaceStatus, openExistingWorkspace, openWorkspace, relocateWorkspace, revealWorkspace, selectFolder,
    type WorkspaceInfo, type WorkspaceStatus,
} from "../../api";
import { CreateWorkspacePanel } from "./CreateWorkspacePanel";
import { ImportKinpakPanel } from "./ImportKinpakPanel";
import { LifeBackground } from "./LifeBackground";
import { ErrorBox } from "./shared";
import { errText, reloadApp } from "./helpers";

interface Props {
    status: WorkspaceStatus;
    /** Set when the launcher was opened over a running workspace (Settings > Workspace): adds a way back. */
    onClose?: () => void;
}

type View = "home" | "create" | "import";

/**
 * Where you pick a workspace: on a fresh install, when the most recent one can't be opened, or on
 * demand. Recents on the left (name, with its path underneath), the three ways in on the right.
 */
export function WorkspaceLauncher({ status: initial, onClose }: Props) {
    const [status, setStatus] = useState(initial);
    const [view, setView] = useState<View>("home");
    const [error, setError] = useState<string | null>(initial.notice);
    const [busyFolder, setBusyFolder] = useState<string | null>(null);
    // The entry asking "remove from the list?", so a stray click can't do it.
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
    // A DB owner can take importing away (see lib/flags.ts). Before any workspace is open there are
    // no flags to consult, so a fresh launcher always offers it.
    const { flags } = useFlags();
    const canImport = !status.current || flags.allowSyncImport;

    // Opened over the running app, this covers the page but not the page's own scrollbar (the app is
    // taller than the window), which would show through at the window's edge. Freeze the page's
    // scrolling for as long as the launcher is up.
    useEffect(() => {
        const html = document.documentElement;
        const before = html.style.overflow;
        html.style.overflow = "hidden";
        return () => { html.style.overflow = before; };
    }, []);

    const refresh = useCallback(async () => {
        try { setStatus(await getWorkspaceStatus()); } catch (e) { setError(errText(e)); }
    }, []);

    const open = async (w: WorkspaceInfo) => {
        if (w.current) { onClose?.(); return; }
        setError(null);
        setBusyFolder(w.folder);
        try {
            await openWorkspace(w.folder);
            reloadApp();
        } catch (e) {
            setError(errText(e));
            setBusyFolder(null);
            void refresh();
        }
    };

    const openExisting = async () => {
        setError(null);
        try {
            // Starts in the app's own workspaces folder, where they normally live; the backend falls
            // back to the OS's default location when that folder doesn't exist.
            const folder = await selectFolder(status.defaultLocation);
            if (!folder) return;
            setBusyFolder("*");
            await openExistingWorkspace(folder);
            reloadApp();
        } catch (e) {
            setError(errText(e));
            setBusyFolder(null);
        }
    };

    const locate = async (w: WorkspaceInfo) => {
        setError(null);
        try {
            const folder = await selectFolder(w.path);
            if (!folder) return;
            await relocateWorkspace(w.folder, folder);
            await refresh();
        } catch (e) {
            setError(errText(e));
        }
    };

    const remove = async (w: WorkspaceInfo) => {
        setError(null);
        try {
            await forgetWorkspace(w.folder);
            setConfirmRemove(null);
            await refresh();
        } catch (e) {
            setError(errText(e));
        }
    };

    const actions: { id: View | "open"; title: string; hint: string; button: string; Icon: React.ElementType }[] = [
        { id: "create", title: "Create new workspace", hint: "Start with an empty library.", button: "Create", Icon: FolderPlus },
        ...(canImport ? [{ id: "import" as const, title: "Import Kinpak", hint: "Add a .kinpak file someone shared: it becomes a new workspace, or adds to the one with the same name.", button: "Import", Icon: PackageOpen }] : []),
        { id: "open", title: "Open existing workspace", hint: "Add a folder that already holds a Kinesis database, such as one on an external drive.", button: "Open", Icon: FolderOpen },
    ];

    return (
        <div className="fixed inset-0 z-[70] bg-[#0f0f0f] text-white font-sans select-none flex">
            <aside className="w-80 shrink-0 border-r border-[#303030] bg-white/5 flex flex-col">
                {/* The same lockup as the app's own header (logo, name with the accent on its first three
                    letters, and the workspace name underneath), with "Workspaces" in the subtitle's place. It sits at
                    the same offsets as that header (px-4, pt-4) so the logo doesn't jump when switching. */}
                <div className="px-4 pt-4 pb-2 flex items-center gap-3 border-b border-[#303030]">
                    <BrandLogo />
                    <div className="flex flex-col">
                        <h1 className="text-2xl font-bold tracking-tighter text-white">
                            <span className="text-[var(--k-accent)]">{BRAND.name.substring(0, 3)}</span>{BRAND.name.substring(3)}
                        </h1>
                        <span className="text-xs text-gray-500 -mt-0.5">Workspaces</span>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar py-2">
                    {status.recents.length === 0 && (
                        <p className="px-5 py-4 text-[11px] text-[#666666] leading-relaxed">No workspaces yet. Create one, or import a Kinpak.</p>
                    )}
                    {status.recents.map(w => (
                        <div key={w.folder} className={`group relative px-5 py-3 border-l-4 ${w.current ? "border-red-600 bg-[#303030]" : "border-transparent hover:bg-[#202020]"}`}>
                            <button
                                onClick={() => (w.available ? open(w) : undefined)}
                                disabled={busyFolder !== null}
                                className={`w-full text-left ${w.available ? "cursor-pointer" : "cursor-default"} disabled:opacity-60`}
                                title={w.path}
                            >
                                <div className={`text-sm font-semibold truncate pr-12 ${w.available ? "text-white" : "text-gray-500"}`}>
                                    {w.name}{w.current ? <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-[#aaaaaa]">Open</span> : null}
                                </div>
                                <div className="text-[11px] text-[#888888] truncate">{w.path}</div>
                            </button>

                            {!w.available && (
                                <div className="mt-2 text-[11px] flex items-center gap-2 flex-wrap">
                                    <span className="text-orange-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Not found</span>
                                    <button onClick={() => locate(w)} className="underline text-white cursor-pointer">Locate</button>
                                </div>
                            )}

                            {confirmRemove === w.folder ? (
                                <div className="mt-2 text-[11px] space-y-1.5">
                                    <div className="text-[#aaaaaa]">Remove from this list? The workspace's data isn't deleted.</div>
                                    <div className="flex gap-3">
                                        <button onClick={() => remove(w)} className="text-red-400 underline cursor-pointer">Remove</button>
                                        <button onClick={() => setConfirmRemove(null)} className="text-[#aaaaaa] underline cursor-pointer">Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <div className="absolute right-3 top-3 hidden group-hover:flex items-center gap-1">
                                    {w.available && (
                                        <button onClick={() => revealWorkspace(w.folder).catch(e => setError(errText(e)))} title="Show in folder" className="p-1 text-[#aaaaaa] hover:text-white cursor-pointer">
                                            <HardDrive className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                    {!w.current && (
                                        <button onClick={() => setConfirmRemove(w.folder)} title="Remove from list" className="p-1 text-[#aaaaaa] hover:text-white cursor-pointer">
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
                {onClose && (
                    // The same bar as the workspace switcher in the app's vertical layout: full width, flush
                    // with the bottom edge, 24px tall, with a rule above it.
                    <button
                        onClick={onClose}
                        className="w-full h-6 shrink-0 flex items-center justify-center gap-1.5 border-t border-[#303030] text-xs font-normal text-[#aaaaaa] hover:text-white hover:bg-[#272727] transition-colors cursor-pointer"
                    >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        <span className="truncate">Back to {status.current?.name ?? "the workspace"}</span>
                    </button>
                )}
            </aside>

            {/* The main area only (not the sidebar): Life runs behind it, and its content scrolls over it. */}
            <main className="flex-1 relative overflow-hidden" data-life-surface>
                <LifeBackground />
                {/* The layers over the background are marked, so a click on bare background reaches the game of life. */}
                <div className="absolute inset-0 overflow-y-auto custom-scrollbar" data-life-surface>
                <div className="min-h-full flex items-center justify-center px-10 py-6" data-life-surface>
                    <div className="w-full max-w-xl space-y-6">
                        {view === "home" && (
                            <>
                                <div>
                                    <h1 className="text-5xl leading-none font-bold tracking-tighter text-white">
                                        <span className="text-[var(--k-accent)]">{BRAND.name.substring(0, 3)}</span>{BRAND.name.substring(3)}
                                    </h1>
                                    <p className="text-base text-[#aaaaaa] mt-2">{status.current ? "Switch to another workspace, or add one." : "Choose a workspace to get started."}</p>
                                </div>
                                {error && <ErrorBox>{error}</ErrorBox>}
                                <div className="bg-[#121212] border border-[#303030] rounded-xl divide-y divide-[#303030]">
                                    {actions.map(({ id, title, hint, button, Icon }) => (
                                        <div key={id} className="flex items-center gap-4 p-4">
                                            <Icon className="w-5 h-5 text-[#aaaaaa] shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-bold">{title}</div>
                                                <div className="text-[11px] text-[#888888] leading-relaxed">{hint}</div>
                                            </div>
                                            <button
                                                onClick={() => (id === "open" ? openExisting() : setView(id))}
                                                disabled={busyFolder !== null}
                                                className="shrink-0 bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white px-4 py-2 rounded-xl font-semibold text-sm transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                                            >
                                                {button}
                                                <ChevronRight className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                        {/* The steps after Create / Import sit on a solid card, so their text never blends into the animation behind. */}
                        {view === "create" && (
                            <div className="bg-[#0f0f0f] border border-[#303030] rounded-2xl p-6 shadow-xl">
                                <CreateWorkspacePanel defaultLocation={status.defaultLocation} onBack={() => setView("home")} />
                            </div>
                        )}
                        {view === "import" && (
                            <div className="bg-[#0f0f0f] border border-[#303030] rounded-2xl p-6 shadow-xl">
                                <ImportKinpakPanel defaultLocation={status.defaultLocation} onBack={() => setView("home")} />
                            </div>
                        )}
                    </div>
                </div>
                </div>
            </main>
        </div>
    );
}
