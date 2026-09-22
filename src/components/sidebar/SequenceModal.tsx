import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, ChevronUp, Eraser, ListOrdered, Plus, Search, X } from 'lucide-react';
import {
    addMatchingToDriveSequence, addToDriveSequence, clearDriveSequence, encodeWdbs, getChildDrives, getDriveSequence,
    getWdbsAliases, listDriveVideosForSequence, removeFromDriveSequence, setDriveSequenceOrder, type ChildDrive,
    type DriveVideo, type SequenceEntry, type SequenceSort,
} from '../../api';
import { ConfirmDialog } from '../ConfirmDialog';

interface Props {
    /** The Drive's display path (":CS-DSA") the modal opens on. The header's breadcrumb (and its "More" menu) can move it to another Drive's sequence. */
    drive: string;
    /** What to call the opening Drive in messages: its alias when it has one. */
    driveLabel: string;
    currentVideoId: string;
    currentTitle: string;
    /** The Drives the current video is directly filed under (its home and "Also in" links). The "this video" pieces (its row in an empty sequence, the "isn't in this sequence" banner, being pre-ticked when adding) only apply while viewing one of these, not a Drive above them: the list for :DUPED-FRW shows nothing of a video that is only in :DUPED-FRW-VVV. */
    ownDrives: string[];
    /** Reordering and removing one video at a time (a DB owner's allowEditSequences flag). */
    canEdit: boolean;
    /** Add Videos, Add to the End, and Clear Sequence (a DB owner's allowEditVideosInSequenceList
     *  flag, combined with allowEditSequences by the caller — it only ever narrows canEdit further,
     *  never grants more than it does). */
    canAddVideos: boolean;
    /** Open on the picker for adding videos rather than the list (used by "Create", when there's no sequence yet). */
    startInAdd?: boolean;
    onClose: () => void;
    /** `drive` is the Drive whose sequence the video was opened from, so the bar under it follows that one. */
    onOpenVideo: (videoId: string, drive: string) => void;
    /** After any change, so the bar under the video can refresh. */
    onChanged: () => void;
}

const PICKER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 250;

// The orders videos can be added in. Upload date is first: it's what a course or a channel's series
// usually follows. `asc`/`desc` are what the direction arrow's tooltip says.
const SORT_CHOICES: { key: SequenceSort; label: string; asc: string; desc: string }[] = [
    { key: 'published', label: 'Upload Date', asc: 'Oldest First', desc: 'Newest First' },
    { key: 'added', label: 'Date Added', asc: 'Earliest First', desc: 'Latest First' },
    { key: 'title', label: 'Title', asc: 'A to Z', desc: 'Z to A' },
];
// The direction button is an arrow (up for ascending, down for descending, like the Library's own sort
// button); the footer spells the order out, e.g. "Date Added, Latest First".
const describeOrder = (sort: SequenceSort, descending: boolean) => {
    const choice = SORT_CHOICES.find(c => c.key === sort)!;
    return `${choice.label}, ${descending ? choice.desc : choice.asc}`;
};

/** A Drive's sequence as a list: jump to any video and (when `canEdit`) reorder or remove them one at
 *  a time; (when `canAddVideos`) add more or clear the whole sequence. Adding shows every video filed
 *  under the Drive (its home or an "Also in" link, sub-drives included) that isn't in the sequence
 *  yet, in the order you pick; tick the ones to add, or select everything and untick the ones to
 *  leave out. They go on the end in that order. */
export function SequenceModal({ drive: startDrive, driveLabel: startLabel, currentVideoId, currentTitle, ownDrives, canEdit, canAddVideos, startInAdd = false, onClose, onOpenVideo, onChanged }: Props) {
    // The Drive being looked at: where the modal opened, until the breadcrumb or its "More" moves it.
    const [drive, setDrive] = useState(startDrive);
    const driveLabel = drive === startDrive ? startLabel : drive;
    const direct = ownDrives.includes(drive);
    const [view, setView] = useState<'list' | 'add'>('list');
    const [entries, setEntries] = useState<SequenceEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    // The video whose removal is waiting on a yes.
    const [toRemove, setToRemove] = useState<SequenceEntry | null>(null);

    const load = () =>
        getDriveSequence(drive)
            .then(setEntries)
            .catch(e => setError(String(e)));

    // Moving to another Drive starts its list from scratch.
    useEffect(() => {
        setView('list');
        setError(null);
        setEntries(null);
        setMoreOpen(false);
        setChildren([]);
        load();
        loadChildren();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [drive]);

    // ── The header's breadcrumb (":CS" › "DSA" › "TREES") ────────────────────────
    const segments = drive.slice(1).split('-');
    // Just the segment names: the colon belongs to a full path (":DUPED-FRW"), which the tooltips show.
    const crumbs = segments.map((label, i) => ({ label, path: ':' + segments.slice(0, i + 1).join('-') }));
    // Curated aliases show as tooltips, like in the Drive tree. Keyed by storage path.
    const [aliases, setAliases] = useState<Record<string, string>>({});
    useEffect(() => {
        let cancelled = false;
        getWdbsAliases(crumbs.map(c => encodeWdbs(c.path)))
            .then(a => { if (!cancelled) setAliases(a); })
            .catch(() => { if (!cancelled) setAliases({}); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [drive]);

    // The Drives one level beneath this one (its sub-drives in the Drive tree, with or without a
    // sequence), for the breadcrumb's "More": at :DUPED-FRW that's PND and VVV, at :DUPED its
    // second-level nodes. It's how you step back down after going up.
    const [children, setChildren] = useState<ChildDrive[]>([]);
    const [moreOpen, setMoreOpen] = useState(false);
    const loadChildren = () => getChildDrives(drive).then(setChildren).catch(() => setChildren([]));

    // Videos are taken out one at a time (or moved) only while there's more than one; the last one goes
    // with "Clear Sequence", which is there whenever the sequence has any video. The backend agrees.
    const removable = (entries?.length ?? 0) > 1;
    const inSequence = entries?.some(e => e.videoId === currentVideoId) ?? false;

    // Runs one edit, then re-reads the list so what's shown is what's stored.
    const edit = async (change: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await change();
            onChanged();
        } catch (e) {
            setError(String(e));
        } finally {
            await load();
            setBusy(false);
        }
    };

    const move = (index: number, by: -1 | 1) => {
        if (!entries) return;
        const target = index + by;
        if (target < 0 || target >= entries.length) return;
        const ids = entries.map(e => e.videoId);
        [ids[index], ids[target]] = [ids[target], ids[index]];
        // Shown at once; the reload after the save settles it either way.
        setEntries(ids.map((id, i) => ({ ...entries.find(e => e.videoId === id)!, position: i + 1 })));
        edit(() => setDriveSequenceOrder(drive, ids));
    };

    // ── Adding videos ────────────────────────────────────────────────────────
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<SequenceSort>('published');
    const [descending, setDescending] = useState(false);
    const [items, setItems] = useState<DriveVideo[]>([]);
    const [total, setTotal] = useState(0);
    const [loadingItems, setLoadingItems] = useState(false);
    // What's ticked: either an explicit list of videos, in the order they were checked (so unticking one
    // closes the gap and re-ticking it sends it to the end — see orderOf below), or "everything listed"
    // minus the ones unticked (which covers videos on pages that haven't been loaded, so it has no
    // per-item tick order).
    const [mode, setMode] = useState<'explicit' | 'all'>('explicit');
    const [selectedOrder, setSelectedOrder] = useState<string[]>([]);
    const [excluded, setExcluded] = useState<Set<string>>(new Set());
    // How many videos are already in the sequence: ticking starts numbering after these, so with 3
    // already there, the first video checked is "4" — where it will actually land once added.
    const baseCount = entries?.length ?? 0;
    const orderOf = (id: string) => {
        const i = selectedOrder.indexOf(id);
        return i === -1 ? undefined : baseCount + i + 1;
    };
    // Bumped to throw away a page that arrives after the search or order changed.
    const fetchIdRef = useRef(0);

    const fetchItems = async (q: string, offset: number) => {
        const myFetch = ++fetchIdRef.current;
        setLoadingItems(true);
        try {
            const page = await listDriveVideosForSequence(drive, q, sort, descending, PICKER_PAGE, offset);
            if (fetchIdRef.current !== myFetch) return;
            setItems(prev => (offset === 0 ? page.videos : [...prev, ...page.videos.filter(v => !prev.some(p => p.videoId === v.videoId))]));
            setTotal(page.total);
        } catch (e) {
            if (fetchIdRef.current === myFetch) setError(String(e));
        } finally {
            if (fetchIdRef.current === myFetch) setLoadingItems(false);
        }
    };

    const openAdd = () => {
        setError(null);
        setQuery('');
        setItems([]);
        setTotal(0);
        // The video being watched is offered first, ticked, when it isn't in the sequence yet.
        setMode('explicit');
        setExcluded(new Set());
        setSelectedOrder(direct && !inSequence ? [currentVideoId] : []);
        setView('add');
    };

    // Loads the first page when the picker opens and again as the search or the order changes (after a
    // pause while typing).
    useEffect(() => {
        if (view !== 'add') return;
        const timer = window.setTimeout(() => fetchItems(query.trim(), 0), query ? SEARCH_DEBOUNCE_MS : 0);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, query, sort, descending]);

    // Opened from "Create": there's no sequence to look at, so go straight to picking its videos. (After
    // the Drive effect above, which resets to the list.)
    useEffect(() => {
        if (startInAdd && canAddVideos) openAdd();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // "Everything listed" means everything matching the search, so a new search starts the ticks over.
    const changeQuery = (value: string) => {
        setQuery(value);
        if (mode === 'all') {
            setMode('explicit');
            setSelectedOrder([]);
            setExcluded(new Set());
        }
    };

    // The current video sits at the top on its own (when it's not in the sequence), so it isn't listed twice.
    const pinCurrent = direct && !inSequence && !query.trim();
    const shown = items.filter(v => !(pinCurrent && v.videoId === currentVideoId));
    const isTicked = (id: string) => (mode === 'all' ? !excluded.has(id) : selectedOrder.includes(id));
    const toggle = (id: string) => {
        if (mode === 'all') {
            setExcluded(prev => {
                const next = new Set(prev);
                if (!next.delete(id)) next.add(id);
                return next;
            });
            return;
        }
        // Unticking drops it from the list (closing the gap for everything after it); ticking it again
        // appends it at the end, after whatever was checked since.
        setSelectedOrder(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
    };
    const selectAll = () => { setMode('all'); setExcluded(new Set()); setSelectedOrder([]); };
    const selectNone = () => { setMode('explicit'); setSelectedOrder([]); setExcluded(new Set()); };
    const count = mode === 'all' ? Math.max(0, total - excluded.size) : selectedOrder.length;

    const addSelected = async () => {
        setBusy(true);
        setError(null);
        try {
            // "All" goes on the end in the chosen sort order; an explicit pick goes on in the exact
            // order it was ticked, ignoring the Sort control (that's only for finding videos to tick).
            const out = mode === 'all'
                ? await addMatchingToDriveSequence(drive, query.trim(), sort, descending, [...excluded])
                : await addToDriveSequence(drive, selectedOrder);
            onChanged();
            await load();
            if (out.added === 0) {
                setError(out.notInDrive > 0 ? `Nothing added: not filed under ${drive}.` : 'Nothing added: already in the sequence.');
            } else {
                setView('list');
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    const iconButton = 'p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-default cursor-pointer';
    const smallButton = 'px-2.5 py-1.5 rounded-md bg-[#222] hover:bg-[#333] text-gray-300 text-[11px] font-bold border border-[#333] cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-[#222]';

    // On the page itself, not inside the video panel: that panel slides in with a CSS transform, which would
    // make this "fixed" window position against the panel instead of the screen.
    return createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-xl h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
            >
                <div className="px-6 py-3 border-b border-[#303030] flex items-center justify-between gap-3 bg-[#141414]">
                    <div className="flex items-center gap-2.5 min-w-0">
                        {view === 'add' ? (
                            <button onClick={() => setView('list')} title="Back to the sequence" className="text-gray-400 hover:text-white cursor-pointer shrink-0">
                                <ArrowLeft className="w-4 h-4" />
                            </button>
                        ) : (
                            <ListOrdered className="w-4 h-4 text-gray-400 shrink-0" />
                        )}
                        {view === 'add' ? (
                            <h2 className="text-sm font-bold text-white truncate">Add to {driveLabel}</h2>
                        ) : (
                            // Each level above is a link to that Drive's sequence and the last is where you are.
                            // The italic "More" opens the Drives below, when there are any.
                            <nav aria-label="Drive" className="flex items-center gap-1 min-w-0 text-sm font-bold">
                                {crumbs.map((crumb, i) => (
                                    <Fragment key={crumb.path}>
                                        {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-gray-600 shrink-0" />}
                                        {i === crumbs.length - 1 ? (
                                            <span className="text-white truncate" title={aliases[encodeWdbs(crumb.path)] ?? crumb.path}>{crumb.label}</span>
                                        ) : (
                                            <button
                                                onClick={() => setDrive(crumb.path)}
                                                title={`${aliases[encodeWdbs(crumb.path)] ?? crumb.path}: Show This Sequence`}
                                                className="text-gray-400 hover:text-white hover:underline underline-offset-4 truncate cursor-pointer"
                                            >
                                                {crumb.label}
                                            </button>
                                        )}
                                    </Fragment>
                                ))}
                                {children.length > 0 && (
                                    <>
                                        <ChevronRight className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                                        <span className="relative shrink-0">
                                            <button
                                                onClick={() => setMoreOpen(o => !o)}
                                                title="Drives Beneath This One"
                                                className="flex items-center gap-0.5 italic font-normal text-gray-400 hover:text-white cursor-pointer"
                                            >
                                                More <ChevronDown className="w-3 h-3" />
                                            </button>
                                            {moreOpen && (
                                                <>
                                                    <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
                                                    <div className="absolute top-full left-0 mt-2 w-64 max-h-64 overflow-y-auto custom-scrollbar bg-[#1a1a1a] border border-[#383838] rounded-lg z-20 p-1 font-normal">
                                                        {children.map(child => (
                                                            <button
                                                                key={child.drive}
                                                                onClick={() => setDrive(child.drive)}
                                                                title={child.drive}
                                                                className="w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded text-left hover:bg-[#2a2a2a] cursor-pointer"
                                                            >
                                                                <span className="truncate text-[11px] font-mono text-white">{child.drive.split('-').pop()}</span>
                                                                <span className="shrink-0 text-[10px] text-[#888888]">
                                                                    {child.videos} {child.videos === 1 ? 'video' : 'videos'}
                                                                    {child.sequenceTotal > 1 ? ` · ${child.sequenceTotal} in Sequence` : ''}
                                                                </span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                </>
                                            )}
                                        </span>
                                    </>
                                )}
                            </nav>
                        )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        {view === 'list' && entries && entries.length > 0 && (
                            <span className="px-2 py-0.5 rounded-md bg-[#222] border border-[#333] text-[11px] font-bold text-gray-300">
                                {entries.length} {entries.length === 1 ? 'video' : 'videos'}
                            </span>
                        )}
                        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {view === 'list' ? (
                    <>
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 min-h-[6rem]">
                            {error && <p className="px-4 py-2 text-xs text-red-400">{error}</p>}
                            {entries === null ? null : entries.length === 0 ? (
                                // No sequence: the list is honestly empty (the bar's "1 of 1" just means this video
                                // stands alone). Adding starts one, with the video being watched already ticked when
                                // it's filed under this Drive.
                                <p className="text-sm text-[#888888] py-8 px-6 text-center">
                                    No sequence for {driveLabel}.
                                    {canAddVideos && (
                                        <>
                                            {' '}
                                            <button onClick={openAdd} disabled={busy} className="text-blue-400 hover:text-blue-300 underline underline-offset-2 cursor-pointer disabled:opacity-50">
                                                Add videos
                                            </button>
                                            {' '}to start one.
                                        </>
                                    )}
                                </p>
                            ) : (
                                <>
                                    {direct && !inSequence && (
                                        <div className="mx-1 mb-2 px-4 py-3 rounded-lg bg-[#1a1a1a] border border-[#303030] flex items-center justify-between gap-3">
                                            <span className="text-xs text-[#aaaaaa]">This video isn't in this sequence.</span>
                                            {canAddVideos && (
                                                <button
                                                    disabled={busy}
                                                    onClick={() => edit(async () => {
                                                        const out = await addToDriveSequence(drive, [currentVideoId]);
                                                        if (out.added === 0) throw new Error(`This video isn't filed under ${drive}.`);
                                                    })}
                                                    className={`shrink-0 ${smallButton}`}
                                                >
                                                    Add to the End
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    <ol>
                                        {entries.map((entry, i) => {
                                            const current = entry.videoId === currentVideoId;
                                            return (
                                                <li key={entry.videoId} className={`group flex items-center gap-2 rounded-lg px-3 py-2 ${current ? 'bg-white/10' : 'hover:bg-white/5'}`}>
                                                    <span className="w-7 shrink-0 text-right text-[11px] font-mono text-[#666666]">{i + 1}</span>
                                                    <button
                                                        onClick={() => { onOpenVideo(entry.videoId, drive); onClose(); }}
                                                        className={`flex-1 min-w-0 text-left text-sm text-white truncate cursor-pointer hover:underline underline-offset-2 ${current ? 'font-bold' : ''}`}
                                                        title={entry.title}
                                                    >
                                                        {entry.title}
                                                    </button>
                                                    {canEdit && removable && (
                                                        <div className="flex items-center shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                                            <button disabled={busy || i === 0} onClick={() => move(i, -1)} title="Move up" className={iconButton}>
                                                                <ChevronUp className="w-4 h-4" />
                                                            </button>
                                                            <button disabled={busy || i === entries.length - 1} onClick={() => move(i, 1)} title="Move down" className={iconButton}>
                                                                <ChevronDown className="w-4 h-4" />
                                                            </button>
                                                            <button disabled={busy} onClick={() => setToRemove(entry)} title="Remove from this sequence" className={`${iconButton} hover:!text-red-500`}>
                                                                <X className="w-4 h-4" />
                                                            </button>
                                                        </div>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ol>
                                </>
                            )}
                        </div>

                        {canAddVideos && (
                            <div className="relative px-6 py-3 border-t border-[#303030] bg-[#141414] flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                    <button
                                        disabled={busy}
                                        onClick={openAdd}
                                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#222] hover:bg-[#333] text-gray-200 transition-all text-xs font-bold cursor-pointer border border-[#333] hover:border-[#444] disabled:opacity-50"
                                    >
                                        <Plus className="w-3.5 h-3.5" />
                                        Add Videos
                                    </button>
                                </div>
                                {entries && entries.length > 0 && (
                                    <button
                                        disabled={busy}
                                        onClick={() => setConfirmClear(true)}
                                        title="Take every video out of this sequence"
                                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#222] hover:bg-[#333] text-gray-300 hover:text-red-400 transition-all text-xs font-bold cursor-pointer border border-[#333] disabled:opacity-50"
                                    >
                                        <Eraser className="w-3.5 h-3.5" />
                                        Clear Sequence
                                    </button>
                                )}
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <div className="px-4 py-3 border-b border-[#303030] space-y-2.5">
                            <div className="relative">
                                <Search className="w-3.5 h-3.5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
                                <input
                                    autoFocus
                                    value={query}
                                    onChange={e => changeQuery(e.target.value)}
                                    placeholder="Search by title or channel"
                                    className="w-full bg-[#121212] border border-[#333] focus:border-red-600/50 outline-none rounded-md pl-8 pr-2 py-1.5 text-xs text-white placeholder-[#555]"
                                />
                            </div>
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#666666]" title="Sorts this list only. An explicit pick is added in the order you ticked it, not by this.">Sort</span>
                                    <select
                                        value={sort}
                                        onChange={e => setSort(e.target.value as SequenceSort)}
                                        className="px-2 py-1.5 bg-[#272727] hover:bg-[#3f3f3f] text-white rounded-md text-[11px] font-semibold cursor-pointer outline-none"
                                    >
                                        {SORT_CHOICES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                                    </select>
                                    <button
                                        onClick={() => setDescending(d => !d)}
                                        title={`${SORT_CHOICES.find(c => c.key === sort)![descending ? 'desc' : 'asc']} (click to reverse)`}
                                        aria-label="Reverse the order"
                                        className={smallButton}
                                    >
                                        {descending ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
                                    </button>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        onClick={selectAll}
                                        disabled={total === 0 || (mode === 'all' && excluded.size === 0)}
                                        className={smallButton}
                                    >
                                        Select All {total > 0 ? total.toLocaleString() : ''}
                                    </button>
                                    <button onClick={selectNone} disabled={count === 0} className={smallButton}>
                                        None
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 min-h-[6rem]">
                            {error && <p className="px-4 py-2 text-xs text-red-400">{error}</p>}
                            {pinCurrent && (
                                <PickerRow
                                    checked={isTicked(currentVideoId)}
                                    onToggle={() => toggle(currentVideoId)}
                                    title={currentTitle || 'This video'}
                                    detail="The video you're watching"
                                    order={mode === 'explicit' ? orderOf(currentVideoId) : undefined}
                                />
                            )}
                            {shown.map(v => (
                                <PickerRow
                                    key={v.videoId}
                                    checked={isTicked(v.videoId)}
                                    onToggle={() => toggle(v.videoId)}
                                    title={v.title}
                                    detail={[v.author, v.publishedAt?.slice(0, 10)].filter(Boolean).join(' · ')}
                                    order={mode === 'explicit' ? orderOf(v.videoId) : undefined}
                                />
                            ))}
                            {!loadingItems && shown.length === 0 && !pinCurrent && (
                                <p className="text-sm text-[#aaaaaa] py-8 px-6 text-center">
                                    {query.trim() ? 'No matching videos.' : `No more videos are filed under ${drive} to add.`}
                                </p>
                            )}
                            {items.length < total && (
                                <div className="p-3 text-center">
                                    <button
                                        disabled={loadingItems}
                                        onClick={() => fetchItems(query.trim(), items.length)}
                                        className="px-4 py-2 rounded-lg bg-[#222] hover:bg-[#333] text-gray-300 text-xs font-bold border border-[#333] cursor-pointer disabled:opacity-50"
                                    >
                                        {loadingItems ? 'Loading...' : `Load More (${(total - items.length).toLocaleString()} Left)`}
                                    </button>
                                </div>
                            )}
                            {loadingItems && items.length === 0 && <p className="text-xs text-[#666666] py-6 text-center">Loading...</p>}
                        </div>

                        <div className="px-6 py-3 border-t border-[#303030] bg-[#141414] flex items-center justify-between gap-3">
                            <span className="text-[11px] text-[#aaaaaa]">
                                {count.toLocaleString()} Selected · Added to the End
                                {mode === 'all' ? ` by ${describeOrder(sort, descending)}` : ' in the Order Checked'}
                            </span>
                            <button
                                disabled={busy || count === 0}
                                onClick={addSelected}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors text-xs font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default shrink-0"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Add {count > 0 ? count.toLocaleString() : ''}
                            </button>
                        </div>
                    </>
                )}
            </div>

            {toRemove && (
                <ConfirmDialog
                    title="Remove from Sequence"
                    message={`Remove "${toRemove.title}" from the ${driveLabel} sequence? The video itself stays in your library.`}
                    confirmLabel="Remove"
                    onCancel={() => setToRemove(null)}
                    onConfirm={() => {
                        const entry = toRemove;
                        setToRemove(null);
                        edit(() => removeFromDriveSequence(drive, entry.videoId));
                    }}
                />
            )}

            {confirmClear && entries && entries.length > 0 && (
                <ConfirmDialog
                    title="Clear Sequence"
                    message={entries.length === 1
                        ? `Clear the ${driveLabel} sequence? "${entries[0].title}" comes out of it but stays in your library.`
                        : `Clear the ${driveLabel} sequence? All ${entries.length} videos come out of it but stay in your library.`}
                    confirmLabel="Clear"
                    onCancel={() => setConfirmClear(false)}
                    onConfirm={() => {
                        setConfirmClear(false);
                        // Stays open, now showing "No sequence for …" with a link to add videos.
                        edit(() => clearDriveSequence(drive));
                    }}
                />
            )}
        </div>,
        document.body,
    );
}

function PickerRow({
    checked, onToggle, title, detail, order,
}: { checked: boolean; onToggle: () => void; title: string; detail: string; order?: number }) {
    return (
        <label className={`flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer ${checked ? 'bg-white/10' : 'hover:bg-white/5'}`}>
            <input type="checkbox" checked={checked} onChange={onToggle} className="shrink-0" />
            {/* Where this video will land once added — it's the order it was ticked in, counting from
                after whatever's already in the sequence. Unticking closes the gap for the ones after it;
                ticking it again sends it to the end, behind everything checked since. */}
            <span className="w-6 shrink-0 text-right text-[11px] font-mono text-[#666666] tabular-nums" aria-hidden={order == null}>
                {order ?? ''}
            </span>
            <span className="flex-1 min-w-0">
                <span className="block text-sm text-white truncate" title={title}>{title}</span>
                {detail && <span className="block text-[10px] text-[#777777] truncate">{detail}</span>}
            </span>
        </label>
    );
}
