import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, ListOrdered, Pencil, X } from 'lucide-react';
import { decodeWdbs, encodeWdbs, getVideoSequences, type DriveSequenceState } from '../../api';
import { driveSegmentLabel } from '../../lib/utils';
import { useWorkspace } from '../../hooks/useWorkspace';
import { SequenceModal } from './SequenceModal';

interface Props {
    videoId: string;
    /** For the sequence list's "add this video" row. */
    videoTitle: string;
    /** The video's home Drive and "Also in" links, storage-encoded. */
    warp: string | undefined;
    wefts: string[];
    /** Curated alias per storage path, for the tooltips. */
    aliases: Record<string, string>;
    /** Off = just the Drive selector, no sequence count or Previous / Next. */
    showSequences: boolean;
    /** Reordering and removing one video at a time (allowEditSequences). */
    canEditSequences: boolean;
    /** Add Videos, Add to the End, Clear Sequence, and "Create Sequence" (allowEditSequences AND
     *  allowEditVideosInSequenceList — the caller combines them, so this can only narrow
     *  canEditSequences further, never exceed it). */
    canAddVideos: boolean;
    /** Shows the pencil that opens `driveEditor` (allowEditWDBS AND allowEditDriveLinking). */
    canEditDrives: boolean;
    /** The Drive picked in the Library's Drive panel (display path), if any: the sequence to follow when it holds this video. */
    driveContext: string | null;
    /** The Drive whose sequence the bar follows across videos; kept by the parent so it survives moving to the next video. */
    activeDrive: string | null;
    setActiveDrive: (drive: string | null) => void;
    onOpenVideo: (videoId: string) => void;
    /** Shows a Drive in the Library. */
    onSelectDrive?: (storagePath: string, label: string) => void;
    /** What the pencil opens: the home Drive and "Also in" editors. */
    driveEditor?: ReactNode;
}

type Group = 'home' | 'also' | 'parent';
interface Entry {
    drive: string;
    group: Group;
    /** Storage form, when this is one of the video's own Drives. */
    storage?: string;
}

const display = (storage: string | undefined | null) => decodeWdbs(storage).toUpperCase();

/** ":A-B-C" -> [":A", ":A-B"] */
function ancestorsOf(path: string): string[] {
    const segments = path.slice(1).split('-');
    return segments.slice(0, -1).map((_, i) => ':' + segments.slice(0, i + 1).join('-'));
}

const GROUP_TITLES: Record<Group, string> = { home: 'Primary Drive', also: 'Also In', parent: 'Parent Drives' };

// The position label's width: room for "999999 of 999999" (16 characters), far more than any real
// sequence needs, so the label's box never changes size.
const SEQUENCE_LABEL_WIDTH = '16ch';

// The bar's content width (px) the navigation row needs at each label level: the count and the
// Previous / Next pair, with their gap. Below the second, only chevrons are shown.
const NAV_FULL_MIN_WIDTH = 400;  // "Previous Video", "Next Video"
const NAV_SHORT_MIN_WIDTH = 330; // "Previous", "Next"

/** The pinned bar at the bottom of the video panel's left side: which Drive the video is being
 *  viewed through (its home, an "Also in" Drive, or a parent that has a sequence) and that Drive's
 *  Previous / Next. Each Drive has its own sequence, so the same video can lead somewhere
 *  different under `:CS` than under `:PYTHON`. Always rendered for a saved video, even with no
 *  sequence, so there's a fixed place to start one. */
export function SequenceDock({
    videoId, videoTitle, warp, wefts, aliases, showSequences, canEditSequences, canAddVideos, canEditDrives, driveContext,
    activeDrive, setActiveDrive, onOpenVideo, onSelectDrive, driveEditor,
}: Props) {
    const { labels } = useWorkspace();
    const [menuOpen, setMenuOpen] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    // The sequence list, opened on the list itself or straight on the picker (to create one).
    const [listOpen, setListOpen] = useState<null | 'list' | 'add'>(null);
    const [nonce, setNonce] = useState(0);
    const menuRef = useRef<HTMLDivElement>(null);

    // How much the Previous / Next buttons say, by how much room there is: "Previous Video" / "Next Video",
    // then "Previous" / "Next", then just the chevron. The pane is resizable (the divider) as well as the window,
    // so this watches the bar's own width instead of using screen breakpoints.
    const rootRef = useRef<HTMLDivElement>(null);
    const [labelMode, setLabelMode] = useState<'full' | 'short' | 'icon'>('full');
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => {
            const width = entry.contentRect.width;
            setLabelMode(width >= NAV_FULL_MIN_WIDTH ? 'full' : width >= NAV_SHORT_MIN_WIDTH ? 'short' : 'icon');
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    const navLabel = (full: string, short: string) => (labelMode === 'full' ? full : labelMode === 'short' ? short : null);

    const home = display(warp);
    const also = wefts.map(display).filter(d => d && d !== home);
    // Every Drive this video could have a sequence under: its own, and everything above them.
    const drivesKey = [home, ...also].join('|');
    const candidates = useMemo(() => {
        const own = drivesKey.split('|').filter(Boolean);
        const out: string[] = [];
        for (const d of [...own, ...own.flatMap(ancestorsOf)]) if (!out.includes(d)) out.push(d);
        return out;
    }, [drivesKey]);

    // Tagged with the video it was fetched for, so a slow answer for the previous video can never
    // be shown (or navigated from) once another one is open.
    const [fetched, setFetched] = useState<{ videoId: string; byDrive: Record<string, DriveSequenceState> } | null>(null);
    useEffect(() => {
        if (!videoId || candidates.length === 0) { setFetched(null); return; }
        let cancelled = false;
        getVideoSequences(videoId, candidates)
            .then(list => { if (!cancelled) setFetched({ videoId, byDrive: Object.fromEntries(list.map(s => [s.drive, s])) }); })
            .catch(() => { if (!cancelled) setFetched(null); });
        return () => { cancelled = true; };
    }, [videoId, candidates, nonce]);
    const byDrive = fetched?.videoId === videoId ? fetched.byDrive : {};
    const refresh = () => setNonce(n => n + 1);

    // Closing the drive menu on an outside click. The editor is a modal now, closed via its own
    // backdrop click or X instead.
    useEffect(() => {
        if (!menuOpen) return;
        const close = (e: MouseEvent) => {
            if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [menuOpen]);

    const entries: Entry[] = [];
    if (home) entries.push({ drive: home, group: 'home', storage: warp });
    wefts.forEach(w => {
        const d = display(w);
        if (d && d !== home && !entries.some(e => e.drive === d)) entries.push({ drive: d, group: 'also', storage: w });
    });
    // A parent Drive is only offered once it has a sequence to be part of.
    candidates.forEach(d => {
        if (!entries.some(e => e.drive === d) && (byDrive[d]?.total ?? 0) > 0) entries.push({ drive: d, group: 'parent' });
    });

    // Which Drive to follow: the one chosen (or last navigated in); else the Library's selected
    // Drive when it holds this video; else the first Drive that does (home first); else the
    // Library's Drive, else the home Drive, so there's always somewhere to start a sequence.
    const isEntry = (d: string | null) => !!d && entries.some(e => e.drive === d);
    const isMember = (d: string | null) => !!d && byDrive[d]?.position != null;
    const currentDrive: string | null =
        (isEntry(activeDrive) ? activeDrive : null)
        ?? (isEntry(driveContext) && isMember(driveContext) ? driveContext : null)
        ?? entries.find(e => isMember(e.drive))?.drive
        ?? (isEntry(driveContext) ? driveContext : null)
        ?? entries[0]?.drive
        ?? null;
    const current = currentDrive ? byDrive[currentDrive] : undefined;
    // Only a video that's in the Drive's sequence has somewhere to go; the buttons are grayed out for
    // any other. The label says where it stands: "3 of 12" in one, "Create" when the Drive has no
    // sequence yet (click to start one), "No Sequence" when the Drive has one this video isn't part of.
    const nav = current?.position != null ? current : null;
    const positionLabel = (s: DriveSequenceState) =>
        s.position != null ? `${s.position} of ${s.total}` : s.total === 0 ? (canAddVideos ? 'Create Sequence' : 'None') : 'No Sequence';
    // The Drive has no sequence at all yet.
    const noSequence = !!current && current.total === 0;
    const currentEntry = entries.find(e => e.drive === currentDrive);
    const aliasOf = (e?: Entry) => (e?.storage ? aliases[e.storage] : undefined);
    const nameOf = (e?: Entry) => aliasOf(e) ?? e?.drive ?? '';

    const go = (id: string | null | undefined) => {
        if (!id || !currentDrive) return;
        setActiveDrive(currentDrive);
        onOpenVideo(id);
    };

    // Previous and Next sit in one bordered box, so they have no border or rounding of their own.
    const navPairButton = 'flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-[#222] hover:bg-[#333] text-gray-200 transition-colors text-[11px] font-bold cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-[#222]';
    // The same width for both, though "Previous Video" is longer than "Next Video", so the pair looks even.
    const pairMinWidth = labelMode === 'full' ? 'min-w-[7.5rem]' : labelMode === 'short' ? 'min-w-[5.25rem]' : 'min-w-[2.25rem]';
    const groupTitle = 'px-3 pt-2 pb-1 text-[9px] font-bold uppercase tracking-wider text-[#666666] select-none';

    return (
        // bg-[#141414]/border-[#303030]: the same "chrome bar" tokens the panel's other header/footer
        // strips use, not a one-off color — those two are what pick up each theme's colors correctly.
        <div ref={rootRef} className="relative shrink-0 border-t border-[#303030] bg-[#141414] px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 text-xs">
                <span className="text-[#666666] uppercase font-bold tracking-wider text-[10px] shrink-0">{labels.aliasDriveLink}:</span>

                <div ref={menuRef} className="relative min-w-0 flex-1">
                    <button
                        onClick={() => setMenuOpen(o => !o)}
                        disabled={entries.length === 0}
                        title={currentEntry ? (aliasOf(currentEntry) ?? currentEntry.drive) : undefined}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-[#1a1a1a] border border-[#333] hover:border-[#444] text-[11px] text-white font-mono transition-colors cursor-pointer disabled:cursor-default disabled:hover:border-[#333]"
                    >
                        <span className="truncate">{currentDrive ?? 'N/A'}</span>
                        {entries.length > 0 && <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-500" />}
                    </button>

                    {menuOpen && (
                        <div className="absolute bottom-full left-0 mb-2 w-96 max-w-[85vw] max-h-64 overflow-y-auto custom-scrollbar bg-[#1a1a1a] border border-[#383838] rounded-lg z-50 p-1">
                            {(['home', 'also', 'parent'] as Group[]).map(group => {
                                const rows = entries.filter(e => e.group === group);
                                if (rows.length === 0) return null;
                                return (
                                    <div key={group}>
                                        <p className={groupTitle}>{GROUP_TITLES[group]}</p>
                                        {rows.map(entry => {
                                            const st = byDrive[entry.drive];
                                            return (
                                                <div
                                                    key={entry.drive}
                                                    className={`group flex items-center gap-2 rounded px-3 py-1.5 hover:bg-[#2a2a2a] ${entry.drive === currentDrive ? 'bg-white/5' : ''}`}
                                                >
                                                    <button
                                                        onClick={() => { setActiveDrive(entry.drive); setMenuOpen(false); }}
                                                        title={aliasOf(entry)}
                                                        className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left cursor-pointer"
                                                    >
                                                        <span className="truncate text-[11px] font-mono text-white">{entry.drive}</span>
                                                        <span className="shrink-0 text-[10px] text-[#888888]">
                                                            {showSequences && st && (st.total === 0 ? 'No Sequence' : positionLabel(st))}
                                                        </span>
                                                    </button>
                                                    {onSelectDrive && (
                                                        <button
                                                            onClick={() => { setMenuOpen(false); onSelectDrive(entry.storage ?? encodeWdbs(entry.drive), driveSegmentLabel(entry.drive)); }}
                                                            title={`Show ${entry.drive} in the ${labels.aliasLibrary}`}
                                                            className="shrink-0 p-0.5 text-gray-600 hover:text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
                                                        >
                                                            <ExternalLink className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {canEditDrives && driveEditor && (
                    <button
                        onClick={() => setEditorOpen(o => !o)}
                        title={`Edit ${labels.aliasDriveLink}`}
                        // A fixed 24px slot (plus the row's 8px gap = pr-8 on the navigation row below), so
                        // Previous / Next can end exactly where the dropdown does.
                        className={`shrink-0 w-6 h-6 flex items-center justify-center transition-colors cursor-pointer ${editorOpen ? 'text-blue-400' : 'text-gray-500 hover:text-blue-400'}`}
                    >
                        <Pencil className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {/* Its own modal (same shell as the sequence window and Add URL), not an anchored popover: editing
                the Drive/"Also In" links has its own inputs and error states, and deserves the room. */}
            {editorOpen && driveEditor && createPortal(
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200"
                    onClick={() => setEditorOpen(false)}
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-lg flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
                    >
                        <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                            <div className="flex items-center gap-2 text-gray-200">
                                <Pencil className="w-4 h-4" />
                                <h2 className="text-lg font-bold">Edit {labels.aliasDriveLink}</h2>
                            </div>
                            <button onClick={() => setEditorOpen(false)} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-6 max-h-[70vh] overflow-y-auto custom-scrollbar">
                            {driveEditor}
                        </div>
                    </div>
                </div>,
                document.body,
            )}

            {/* Always here; grayed out when there's nothing to move to: no sequence yet, at an end of it,
                or this video isn't in the Drive's sequence. The count (which opens the list, where the first
                video is the top row) is on the left, and Previous / Next are joined as a pair on the right. */}
            {showSequences && (
                // Inset by the pencil's slot (when there is one) so the pair's right edge lines up with the dropdown's.
                <div className={`flex items-center justify-between gap-2 ${canEditDrives && driveEditor ? 'pr-8' : ''}`}>
                    <div className="min-w-0 flex">
                        {/* A sequence belongs to a Drive, so a video with none has no sequence: the button stays
                            (the bar keeps its shape) but is grayed out until it's filed under one. With a Drive
                            but no sequence yet it says "Create Sequence" and opens the picker to start one. */}
                        <button
                            onClick={() => setListOpen(noSequence ? 'add' : 'list')}
                            disabled={!current || (noSequence && !canAddVideos)}
                            title={!currentDrive
                                ? 'Sequences belong to a Drive. File this video under one to use them.'
                                : !current
                                    ? undefined
                                    : noSequence
                                        ? `Start a sequence for ${nameOf(currentEntry)}`
                                        : current.position != null
                                            ? 'Show this sequence (jump to any video, including the first)'
                                            : `Not in the ${nameOf(currentEntry)} sequence (${current.total} ${current.total === 1 ? 'video' : 'videos'}). Click to view it or add this video.`}
                            // hover:bg-[#333], not [#222]: [#222] is the *resting* shade other buttons on this bar
                            // use (e.g. Previous/Next), so starting from transparent and hovering to it barely
                            // reads as a highlight at all — [#333] is the same jump those buttons make on hover.
                            className="flex items-center gap-1.5 shrink min-w-0 px-2 py-1 rounded-md text-[11px] font-bold text-[#aaaaaa] hover:text-white hover:bg-[#333] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:text-[#aaaaaa] disabled:hover:bg-transparent"
                        >
                            <ListOrdered className="w-3.5 h-3.5 shrink-0" />
                            {/* A set width, wide enough for "999999 of 999999", so the row doesn't shift as this
                                changes between "Create Sequence" and a position. It only gives way on a very narrow pane. */}
                            <span className="truncate text-center tabular-nums" style={{ width: SEQUENCE_LABEL_WIDTH }}>
                                {current ? positionLabel(current) : currentDrive ? '' : 'Create Sequence'}
                            </span>
                        </button>
                    </div>

                    <div className="flex shrink-0 rounded-lg overflow-hidden border border-[#333]">
                        <button className={`${navPairButton} ${pairMinWidth}`} title="Previous Video" aria-label="Previous Video" disabled={!nav?.prev} onClick={() => go(nav?.prev)}>
                            <ChevronLeft className="w-3.5 h-3.5 shrink-0" /> {navLabel('Previous Video', 'Previous')}
                        </button>
                        <button className={`${navPairButton} ${pairMinWidth} border-l border-[#333]`} title="Next Video" aria-label="Next Video" disabled={!nav?.next} onClick={() => go(nav?.next)}>
                            {navLabel('Next Video', 'Next')} <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                        </button>
                    </div>
                </div>
            )}

            {listOpen && currentDrive && (
                <SequenceModal
                    drive={currentDrive}
                    driveLabel={nameOf(currentEntry)}
                    currentVideoId={videoId}
                    currentTitle={videoTitle}
                    // Only the video's own Drives, not the ones above them: the "this video" row and banner
                    // belong to a Drive it's actually filed under.
                    ownDrives={[home, ...also].filter(Boolean)}
                    canEdit={canEditSequences}
                    canAddVideos={canAddVideos}
                    startInAdd={listOpen === 'add'}
                    onClose={() => setListOpen(null)}
                    // The bar follows the Drive the video was opened from, which may be another one
                    // than it started on if the header's breadcrumb or Browse was used.
                    onOpenVideo={(id, fromDrive) => { setActiveDrive(fromDrive); onOpenVideo(id); }}
                    onChanged={refresh}
                />
            )}
        </div>
    );
}
