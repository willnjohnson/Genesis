import { Save, Trash2, Bookmark, ArrowDown, ArrowUp, Calendar, Users, Sparkles, FileText, ListVideo } from 'lucide-react';
import { type Video } from '../api';
import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { format } from 'date-fns';
import { saveImageAs } from '../lib/save-image-as';
import { useFlags } from '../hooks/useFlags';
import { BottomBar } from './BottomBar';
import { TrashChip } from './TrashChip';
import { LifeLoader } from './LifeLoader';

// Mirrors the Tailwind breakpoints used by the grid className below (sm/md/lg/xl/2xl at
// Tailwind's default 640/768/1024/1280/1536px) so the virtualizer knows how many cards land in
// each rendered row without having to measure the DOM.
function useColumnCount(compact: boolean) {
    const getColumns = useCallback(() => {
        const w = window.innerWidth;
        if (compact) {
            if (w >= 1536) return 8;
            if (w >= 1280) return 6;
            if (w >= 1024) return 5;
            if (w >= 768) return 4;
            if (w >= 640) return 3;
            return 2;
        }
        if (w >= 1536) return 5;
        if (w >= 1280) return 4;
        if (w >= 1024) return 3;
        if (w >= 640) return 2;
        return 1;
    }, [compact]);

    const [columns, setColumns] = useState(getColumns);

    useEffect(() => {
        const onResize = () => setColumns(getColumns());
        onResize();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [getColumns]);

    return columns;
}

// The backend's bad-YouTube-API-key message (commands/youtube/metadata.rs's BAD_KEY_MESSAGE).
const BAD_API_KEY_MESSAGE = "Your YouTube API key isn't valid.";

export type SortField = 'popularity' | 'date' | 'added';
export type SortOrder = 'desc' | 'asc';
export type FilterType = 'all' | 'transcript' | 'summary';

interface Props {
    videos: Video[];
    onSelect: (video: Video) => void;
    onSaveAll?: () => void;
    onDelete?: (video: Video) => void;
    saveProgress?: string | null;
    compact?: boolean;
    totalCount?: number;
    isLibrary?: boolean;
    allowDeletion?: boolean;
    onSelectWithTab?: (video: Video, tab: 'transcript' | 'summary') => void;
    // Library mode only: keeps the sort/filter header visible (so the buttons are always usable)
    // even while a page-1 reload is in flight or a search/filter turned up nothing.
    loading?: boolean;
    emptyTitle?: string;
    emptyMessage?: string;
    // Search only: a failed fetch (e.g. "Failed to fetch. Check your connection or the URL/
    // handle.") — shown in the same content-section slot as emptyTitle, in its place, since
    // there's nothing else to show there anyway. Muted red rather than a separate alert box: a
    // recoverable, often routine failure (a typo'd handle, a dropped connection) doesn't need to
    // shout, just needs to visibly not be "you just haven't searched yet."
    error?: string | null;
    // When the error is the bad-YouTube-API-key one ("Your YouTube API key isn't valid."): what its
    // "YouTube API key" opens.
    onOpenApiKeySettings?: () => void;
    // Sort/filter are "controlled" when these are passed (Library mode, where sorting/filtering
    // happens server-side and the buttons must survive a new search — see hooks/useLibrary.ts).
    // Left uncontrolled (internal state) for the plain YouTube-search view, whose results are
    // already fully loaded client-side.
    sortField?: SortField;
    onSortFieldChange?: (field: SortField) => void;
    sortOrder?: SortOrder;
    onToggleSortOrder?: () => void;
    filterKind?: FilterType;
    onFilterKindChange?: (filter: FilterType) => void;
    // Infinite-scroll pagination (Library mode only).
    onLoadMore?: () => void;
    loadingMore?: boolean;
    hasMore?: boolean;
    // Bulk Assign Mode (Library/Portal grid only — see App.tsx's Drive panel toggle). When
    // active, clicking a card toggles its membership in `bulkSelectedIds` instead of opening it,
    // and right-clicking calls `onBulkContextMenu` instead of the thumbnail's normal
    // "Save Image As" — see VideoCard below.
    bulkAssignMode?: boolean;
    bulkSelectedIds?: Set<string>;
    onToggleBulkSelect?: (video: Video) => void;
    // Shift-click range select (file-manager-style): replaces the whole selection with "the
    // selection as it was right before the last plain click" plus that click's card's range to
    // the shift-clicked target forced to match the card's own resulting state — see
    // handleBulkCardClick below for why it's a full replace rather than an incremental add/
    // remove: repeated shift-clicks (1, shift+18, shift+19, shift+5, ...) need each one to
    // re-derive the range from that same fixed anchor, so a shift+5 after a shift+19 correctly
    // *shrinks* the selection back down instead of leaving 6-19 stuck on from the earlier click.
    onBulkSelectRange?: (nextSelectedIds: Set<string>) => void;
    onBulkContextMenu?: (video: Video, x: number, y: number) => void;
    // Library mode only, and only while its Drive panel is open: "All"/"Unsorted" or the selected
    // node's own label (plus curated alias). Shown as a "<prefix>: X" chip in the bottom bar (see
    // BottomBar.tsx) — there's no room for it in the in-flow heading, and Search never has a
    // Drive to report.
    driveLabel?: string;
    // The chip's prefix — "Drive" for All/Unsorted, "L<depth>" for a real node (App.tsx computes
    // this from library.wdbsFilter's segment count). Defaults to "Drive" if omitted.
    driveLabelPrefix?: string;
    // Hover text for the prefix itself: the ancestor path above the selected node (e.g. "L3" on
    // :CRYPTO-BITCOIN-INFO tooltips ":CRYPTO-BITCOIN") — omitted for "Drive" (All/Unsorted) or a
    // root (L1) node, neither of which has a meaningful ancestor path to show.
    driveLabelPrefixTooltip?: string;
    // Opens the Trash window (the bar's "N in Trash"). App owns the window, so the command palette can open it too.
    onOpenTrash?: () => void;
    // Search only: nothing has been searched yet, so the empty area invites a search instead of reporting no results.
    idle?: boolean;
    // App.tsx's one scrollable content pane — the grid virtualizes against this instead of the
    // window (there's no window-level scroll anymore; see App.tsx).
    scrollContainerRef: RefObject<HTMLDivElement | null>;
}

export function VideoList({
    videos, onSelect, onSaveAll, onDelete, saveProgress, compact = false, totalCount, isLibrary = false,
    allowDeletion = true, onSelectWithTab,
    sortField: sortFieldProp, onSortFieldChange, sortOrder: sortOrderProp, onToggleSortOrder,
    filterKind: filterProp, onFilterKindChange,
    onLoadMore, loadingMore = false, hasMore = false,
    loading = false, emptyTitle, emptyMessage, error, onOpenApiKeySettings,
    driveLabel, driveLabelPrefix = 'Drive', driveLabelPrefixTooltip, onOpenTrash, idle = false, scrollContainerRef,
    bulkAssignMode = false, bulkSelectedIds, onToggleBulkSelect, onBulkSelectRange, onBulkContextMenu,
}: Props) {
    // A DB owner can hide the sort and filter controls (see lib/flags.ts).
    const { flags } = useFlags();
    const [internalSortField, setInternalSortField] = useState<SortField>('date');
    const [internalSortOrder, setInternalSortOrder] = useState<SortOrder>('desc');
    const [internalFilter, setInternalFilter] = useState<FilterType>('all');

    const sortField = sortFieldProp ?? internalSortField;
    const sortOrder = sortOrderProp ?? internalSortOrder;
    const filter = filterProp ?? internalFilter;

    const handleSaveImageAs = async (url: string) => {
        await saveImageAs(url, {
            filters: [{ name: 'Image', extensions: ['webp', 'jpg', 'png'] }],
            defaultPath: 'video-thumbnail.webp'
        });
    };

    // Library mode's `videos` prop already arrives filtered/sorted/paginated by the backend
    // (see db/search.rs's filter_kind_where/library_order_by), so skip redoing it client-side —
    // filtering/sorting again here would only be re-deriving what the server already decided,
    // and can't be "more correct" since it's operating on a partial (one-page) result set anyway.
    const filteredVideos = useMemo(() => {
        if (isLibrary) return videos;
        return videos.filter(v => {
            const hasTranscript = v.hasTranscript ?? !!v.transcript;
            const hasSummary = v.hasSummary ?? !!v.summary;
            if (filter === 'transcript') return hasTranscript && !hasSummary;
            if (filter === 'summary') return hasSummary;
            return true;
        });
    }, [videos, filter, isLibrary]);

    const sortedVideos = useMemo(() => {
        if (isLibrary) return filteredVideos;
        return [...filteredVideos].sort((a, b) => {
            let cmp = 0;
            if (sortField === 'popularity') {
                const vA = parseViewCount(a.viewCount);
                const vB = parseViewCount(b.viewCount);
                cmp = vA - vB;
            } else if (sortField === 'added') {
                const timeA = a.dateAdded ? new Date(a.dateAdded).getTime() : 0;
                const timeB = b.dateAdded ? new Date(b.dateAdded).getTime() : 0;
                cmp = timeA - timeB;
            } else {
                const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
                const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;

                const validA = !isNaN(timeA) && timeA > 0;
                const validB = !isNaN(timeB) && timeB > 0;

                if (validA && validB) {
                    cmp = timeA - timeB;
                } else if (!validA && !validB) {
                    cmp = a.title.localeCompare(b.title);
                } else {
                    cmp = validA ? 1 : -1;
                }
            }
            if (cmp === 0) return a.id.localeCompare(b.id);
            return sortOrder === 'asc' ? cmp : -cmp;
        });
    }, [filteredVideos, sortField, sortOrder, isLibrary]);

    const handleSortField = (field: SortField) => {
        if (onSortFieldChange) onSortFieldChange(field);
        else setInternalSortField(field);
    };

    const handleFilter = (f: FilterType) => {
        if (onFilterKindChange) onFilterKindChange(f);
        else setInternalFilter(f);
    };

    const columns = useColumnCount(compact);
    const rows = useMemo(() => {
        const out: Video[][] = [];
        for (let i = 0; i < sortedVideos.length; i += columns) {
            out.push(sortedVideos.slice(i, i + columns));
        }
        return out;
    }, [sortedVideos, columns]);

    // Bulk Assign Mode's shift-click range select. `sortedVideos`' order is exactly the visual
    // order (it's what `rows` above is chunked from), so a shift-click just needs the anchor and
    // target's positions in it — no need to walk the row/column grid itself.
    //
    // A shift-click range is always computed as `bulkBaseSelectionRef` (the selection exactly as
    // it stood right after the anchor's own plain-click toggle, before any shift-clicks) with the
    // anchor→target range forced to `bulkAnchorSelectedRef` (whatever the anchor's own toggle
    // just made it). Recomputing from that same fixed base every time — rather than incrementally
    // mutating whatever the previous shift-click left behind — is what lets repeated shift-clicks
    // *shrink* a range back down: select 1, shift+18 selects 1-18, shift+19 extends to 1-19,
    // shift+5 needs to drop 6-19 back off, which only works if it's re-deriving "base + [1,5]"
    // rather than adding [1,5] onto whatever 1-19 already was. All three refs reset (to null/true/
    // empty) whenever Bulk Assign Mode itself turns off, so a stale anchor from a previous session
    // can't leak into a fresh one.
    const bulkAnchorIdRef = useRef<string | null>(null);
    const bulkAnchorSelectedRef = useRef(true);
    const bulkBaseSelectionRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        if (!bulkAssignMode) {
            bulkAnchorIdRef.current = null;
            bulkAnchorSelectedRef.current = true;
            bulkBaseSelectionRef.current = new Set();
        }
    }, [bulkAssignMode]);

    const videoIndexById = useMemo(() => {
        const m = new Map<string, number>();
        sortedVideos.forEach((v, i) => m.set(v.id, i));
        return m;
    }, [sortedVideos]);

    const handleBulkCardClick = useCallback((video: Video, e: React.MouseEvent) => {
        if (e.shiftKey && bulkAnchorIdRef.current && onBulkSelectRange) {
            const anchorIdx = videoIndexById.get(bulkAnchorIdRef.current);
            const targetIdx = videoIndexById.get(video.id);
            if (anchorIdx !== undefined && targetIdx !== undefined) {
                const [start, end] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
                const next = new Set(bulkBaseSelectionRef.current);
                for (const v of sortedVideos.slice(start, end + 1)) {
                    if (bulkAnchorSelectedRef.current) next.add(v.id); else next.delete(v.id);
                }
                onBulkSelectRange(next);
                return;
            }
        }
        // Plain click: toggle this card and make it the new anchor. `bulkSelectedIds` is still
        // last render's value here (the toggle's own state update hasn't landed yet), so the
        // anchor's resulting state and the new base snapshot are both derived from it directly
        // rather than read back after the fact.
        const wasSelected = bulkSelectedIds?.has(video.id) ?? false;
        const nextBase = new Set(bulkSelectedIds ?? []);
        if (wasSelected) nextBase.delete(video.id); else nextBase.add(video.id);
        bulkAnchorIdRef.current = video.id;
        bulkAnchorSelectedRef.current = !wasSelected;
        bulkBaseSelectionRef.current = nextBase;
        onToggleBulkSelect?.(video);
    }, [videoIndexById, sortedVideos, onBulkSelectRange, onToggleBulkSelect, bulkSelectedIds]);

    // The grid isn't the scroll pane's first child (the "Videos" heading + Save All row precedes
    // it, and in Library mode WdbsTreePanel sits beside it), so the virtualizer still needs to
    // know how far down the pane it starts — same idea as before switching off
    // useWindowVirtualizer, just measured from the pane's own origin instead of the document's.
    // gridRef.offsetTop resolves correctly against it since App.tsx's scroll pane has
    // position: relative (making it gridRef's offsetParent) and nothing in between sets its own
    // position.
    const gridRef = useRef<HTMLDivElement>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    useLayoutEffect(() => {
        setScrollMargin(gridRef.current?.offsetTop ?? 0);
    }, [compact, isLibrary]);

    // Heading row: swap the sort/filter buttons to icon-only once their labelled width would no
    // longer fit beside "Videos" (and Save All). The labelled width is only measurable while the
    // labels are showing, so it's remembered while they are and compared against the room left
    // over — the room doesn't depend on which mode is showing, so this can't flip-flop.
    const showBookmarkedSort = isLibrary || videos.some(v => v.dateAdded);
    const headerRowRef = useRef<HTMLDivElement>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const headerControlsRef = useRef<HTMLDivElement>(null);
    const [headerIconOnly, setHeaderIconOnly] = useState(false);
    const headerIconOnlyRef = useRef(false);
    const labeledControlsWidthRef = useRef(0);
    const measureHeader = useCallback(() => {
        const row = headerRowRef.current;
        const heading = headingRef.current;
        const controls = headerControlsRef.current;
        if (!row || !heading || !controls) return;
        if (!headerIconOnlyRef.current) labeledControlsWidthRef.current = controls.offsetWidth;
        const style = getComputedStyle(row);
        const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const gap = parseFloat(style.columnGap) || 0;
        const available = row.clientWidth - padX - heading.offsetWidth - gap;
        const next = labeledControlsWidthRef.current > available;
        if (next !== headerIconOnlyRef.current) {
            headerIconOnlyRef.current = next;
            setHeaderIconOnly(next);
        }
    }, []);
    // Anything that changes what the controls contain invalidates the remembered labelled width:
    // show the labels again so the next measure (below, after every render) reads a fresh one.
    useLayoutEffect(() => {
        headerIconOnlyRef.current = false;
        setHeaderIconOnly(false);
    }, [isLibrary, showBookmarkedSort, saveProgress, flags.showSortControls, flags.showFilterControls, flags.showSortControlButtons]);
    useLayoutEffect(() => { measureHeader(); });
    useEffect(() => {
        const row = headerRowRef.current;
        if (!row) return;
        const observer = new ResizeObserver(measureHeader);
        observer.observe(row);
        return () => observer.disconnect();
    }, [measureHeader]);

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        estimateSize: () => (compact ? 210 : 270),
        overscan: 4,
        scrollMargin,
        getScrollElement: () => scrollContainerRef.current,
    });

    const toggleSortOrder = () => {
        if (onToggleSortOrder) onToggleSortOrder();
        else setInternalSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    };

    // Infinite scroll: once the last rendered row is at (or near) the end of the currently
    // loaded rows, ask the parent for the next page. `loadMoreLockRef` prevents re-firing on
    // every intermediate scroll-driven render before `loadingMore` has had a chance to flip
    // true and take over as the guard.
    const loadMoreLockRef = useRef(false);
    useEffect(() => {
        loadMoreLockRef.current = loadingMore;
    }, [loadingMore]);

    const virtualItems = rowVirtualizer.getVirtualItems();
    const lastVirtualIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
    useEffect(() => {
        if (!isLibrary || !onLoadMore || !hasMore || loadingMore || loadMoreLockRef.current) return;
        if (lastVirtualIndex >= rows.length - 1) {
            loadMoreLockRef.current = true;
            onLoadMore();
        }
    }, [isLibrary, onLoadMore, hasMore, loadingMore, lastVirtualIndex, rows.length]);

    // Shown only while Library's Drive panel is actually open (App.tsx computes driveLabel from
    // that) — Search never has a Drive to report. `w-80` is the same width Tailwind token the
    // Drive panel itself uses (App.tsx), so the chip lines up directly under the panel at typical
    // widths; `min-w-0` + `truncate` on the value (an alias can be long) make this the bar's
    // pressure-release valve — no shrink-0 here, unlike the buttons below — so a long Drive name
    // or alias gives up space and ellipsizes well before anything interactive would ever need to.
    const driveChip = driveLabel ? (
        <div className="w-80 min-w-0 shrink flex items-center gap-2 text-[11px] text-gray-400">
            <span className="shrink-0" title={driveLabelPrefixTooltip}>{driveLabelPrefix}:</span>
            <span className="text-white font-semibold truncate" title={driveLabel}>{driveLabel}</span>
        </div>
    ) : null;

    // Sort/filter buttons match AlphabetJumpNav's own flat, small-text style (same font size, no
    // boxed group background, no border radius, no gap between them — each button's own small
    // padding is the only spacing, exactly like the A-Z letters). A plain border (no fill, no
    // radius) still marks each group's edges, so "these buttons are one group" stays visible
    // without a filled pill background. The active/selected button gets a secondary-surface
    // background (the same #303030 tone Settings' own cards/toggles use) — understated rather
    // than a stark white pill, matching AlphabetJumpNav's own plain-text look.
    const groupWrapClass = "flex items-stretch border-x border-[#272727] px-1";
    const btnClass = (active: boolean) =>
        `px-1.5 py-0.5 text-[11px] transition-colors cursor-pointer flex items-center gap-1 ${active ? 'bg-[#303030] text-white' : 'text-gray-400 hover:text-white hover:bg-[#272727]'}`;
    const toggleClass = "px-1.5 py-0.5 text-gray-400 hover:text-white hover:bg-[#272727] transition-all cursor-pointer group flex items-center gap-1";
    // Every sort/filter button pairs an icon with a text label. The label hides below a
    // container-query threshold (each button keeps its icon, plus a `title` tooltip for the
    // now-hidden text) rather than getting invisibly clipped by BottomBar's overflow-hidden once
    // it runs out of room — this is the bar's last line of defense after driveChip/the count have
    // already given up all the space they can. Keyed off the bar's own width (BottomBar.tsx's
    // `@container`), not the viewport's: the window can be plenty wide while the bar itself has
    // little room left (nav rail + an open Drive panel already spoken for), which is exactly what
    // let buttons get clipped before ever reaching this fallback. @3xl (48rem/768px of the bar's
    // own width, not the window's) is roughly what the sort + filter groups' text actually needs
    // at once with no Drive chip in the mix (~640px of buttons plus the title) — tune this if
    // it's still switching earlier or later than it should; there's no way to derive it exactly
    // since it depends on this workspace's own label lengths (a curated Drive alias, etc.), not
    // just a fixed pixel count.
    const btnLabel = (text: string) => <span className="hidden @3xl:inline">{text}</span>;

    // Rendered next to the bare "Videos" heading up top — it's a save action, not something to
    // bury in a bar meant to be small (see the return below for exactly where each thing goes).
    const saveAllButton = onSaveAll ? (
        <button
            onClick={onSaveAll}
            disabled={!!saveProgress}
            className={`px-3 py-1.5 bg-white text-black hover:bg-[#e5e5e5] rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 flex items-center gap-2 ${!saveProgress ? 'cursor-pointer' : 'cursor-default'}`}
        >
            {saveProgress ? (
                <>
                    <div className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
                    {saveProgress}
                </>
            ) : (
                <>
                    <Save className="w-4 h-4" />
                    Save All
                </>
            )}
        </button>
    ) : null;

    // The bottom bar's own content — count, sort group, filter group. The count shrinks/truncates
    // to match AlphabetJumpNav's own text-[11px] scale — the bar is meant to read as small as that
    // one — and is second in line (after driveChip) to give up space when it's too narrow: it
    // truncates rather than wrapping/scrolling, but only once driveChip has nothing left to give;
    // the count itself is normally short, so this is mostly a safety net for very narrow windows,
    // not something that visibly kicks in day to day.
    const sortControls = (
        <div className="flex items-stretch self-stretch gap-2 shrink-0 ml-auto">
            {flags.showSortControls && (
                <div className={groupWrapClass}>
                    <div className="flex">
                        {(isLibrary || videos.some(v => v.dateAdded)) && (
                            <button
                                onClick={() => handleSortField('added')}
                                className={btnClass(sortField === 'added')}
                                title="Date Bookmarked"
                            >
                                <Bookmark className="w-3 h-3" />
                                {btnLabel("Date Bookmarked")}
                            </button>
                        )}
                        <button
                            onClick={() => handleSortField('date')}
                            className={btnClass(sortField === 'date')}
                            title="Date Added"
                        >
                            <Calendar className="w-3 h-3" />
                            {btnLabel("Date Added")}
                        </button>
                        <button
                            onClick={() => handleSortField('popularity')}
                            className={btnClass(sortField === 'popularity')}
                            title="Views"
                        >
                            <Users className="w-3 h-3" />
                            {btnLabel("Views")}
                        </button>
                    </div>

                    <div className="w-px h-3 self-center bg-[#272727] mx-0.5" />

                    <button
                        onClick={toggleSortOrder}
                        className={toggleClass}
                        title='Sort Order ↑ ↓'
                    >
                        {sortOrder === 'desc' ? (
                            <ArrowDown className="w-3.5 h-3.5 group-active:translate-y-0.5 transition-transform" />
                        ) : (
                            <ArrowUp className="w-3.5 h-3.5 group-active:-translate-y-0.5 transition-transform" />
                        )}
                    </button>
                </div>
            )}

            {isLibrary && flags.showFilterControls && (
                <div className={groupWrapClass}>
                    <button
                        onClick={() => handleFilter('all')}
                        className={btnClass(filter === 'all')}
                        title="All Videos"
                    >
                        <ListVideo className="w-3 h-3" />
                        {btnLabel("All Videos")}
                    </button>
                    <button
                        onClick={() => handleFilter('transcript')}
                        className={btnClass(filter === 'transcript')}
                        title="Transcript Only"
                    >
                        <FileText className="w-3 h-3" />
                        {btnLabel("Transcript Only")}
                    </button>
                    <button
                        onClick={() => handleFilter('summary')}
                        className={btnClass(filter === 'summary')}
                        title="With AI Summary"
                    >
                        <Sparkles className="w-3 h-3" />
                        {btnLabel("With AI Summary")}
                    </button>
                </div>
            )}
        </div>
    );

    // The heading's own sort/filter buttons (Settings > Display > Sort Controls Accessibility),
    // styled like v0.4.4's: each group its own boxed pill, white active button, muted inactive ones.
    // Labels drop to icon-only (tooltips keep the names) once the full-label row would run into the
    // "Videos" heading — measured (see headerIconOnly below), not a viewport breakpoint, since the
    // width needed depends on which buttons this view has (Library adds the filter group).
    const headerGroupClass = "flex items-center bg-[#1a1a1a] p-0.5 rounded-lg border border-[#272727] gap-0.5";
    const headerBtnClass = (active: boolean) =>
        `px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${active ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`;
    const headerToggleClass = "p-1 rounded text-[#777] hover:text-white hover:bg-white/5 transition-all cursor-pointer group flex items-center gap-1";
    const headerLabel = (text: string) => (headerIconOnly ? null : text);

    const headerSortControls = (
        <div className="flex items-center gap-3 shrink-0">
            {flags.showSortControls && (
                <div className={headerGroupClass}>
                    <div className="flex gap-0.5">
                        {showBookmarkedSort && (
                            <button
                                onClick={() => handleSortField('added')}
                                className={headerBtnClass(sortField === 'added')}
                                title="Date Bookmarked"
                            >
                                <Bookmark className="w-3 h-3" />
                                {headerLabel("Date Bookmarked")}
                            </button>
                        )}
                        <button
                            onClick={() => handleSortField('date')}
                            className={headerBtnClass(sortField === 'date')}
                            title="Date Added"
                        >
                            <Calendar className="w-3 h-3" />
                            {headerLabel("Date Added")}
                        </button>
                        <button
                            onClick={() => handleSortField('popularity')}
                            className={headerBtnClass(sortField === 'popularity')}
                            title="Views"
                        >
                            <Users className="w-3 h-3" />
                            {headerLabel("Views")}
                        </button>
                    </div>

                    <div className="w-px h-3 bg-[#272727] mx-0.5" />

                    <button
                        onClick={toggleSortOrder}
                        className={headerToggleClass}
                        title='Sort Order ↑ ↓'
                    >
                        {sortOrder === 'desc' ? (
                            <ArrowDown className="w-3.5 h-3.5 group-active:translate-y-0.5 transition-transform" />
                        ) : (
                            <ArrowUp className="w-3.5 h-3.5 group-active:-translate-y-0.5 transition-transform" />
                        )}
                    </button>
                </div>
            )}

            {isLibrary && flags.showFilterControls && (
                <div className={headerGroupClass}>
                    <button
                        onClick={() => handleFilter('all')}
                        className={headerBtnClass(filter === 'all')}
                        title="All Videos"
                    >
                        <ListVideo className="w-3 h-3" />
                        {headerLabel("All Videos")}
                    </button>
                    <button
                        onClick={() => handleFilter('transcript')}
                        className={headerBtnClass(filter === 'transcript')}
                        title="Transcript Only"
                    >
                        <FileText className="w-3 h-3" />
                        {headerLabel("Transcript Only")}
                    </button>
                    <button
                        onClick={() => handleFilter('summary')}
                        className={headerBtnClass(filter === 'summary')}
                        title="With AI Summary"
                    >
                        <Sparkles className="w-3 h-3" />
                        {headerLabel("With AI Summary")}
                    </button>
                </div>
            )}
        </div>
    );

    // "12 of 340 results" once there are more than are loaded/shown, otherwise just "12 results". Shown in the
    // bottom bar, and as the tooltip on the "Videos" heading.
    const resultsPartial = typeof totalCount === 'number' && totalCount > filteredVideos.length;
    const resultsNumbers = resultsPartial ? `${filteredVideos.length} of ${totalCount}` : `${filteredVideos.length}`;
    const resultsText = `${resultsNumbers} results`;

    // Videos deleted this session, to put back. The words show when the bar is wide enough for them (an open Drive
    // panel takes room, so it needs a wider bar then), otherwise just the icon.
    const trashChip = onOpenTrash ? <TrashChip kind="video" labelFrom={driveLabel ? '6xl' : '4xl'} onOpen={onOpenTrash} /> : null;

    const headerContent = (
        <>
            <div className="flex items-baseline gap-1.5 min-w-0">
                {/* Styled like the Drive chip beside it: the numbers pop in white, semibold, and the word
                    "results" stays the muted label color. */}
                <span className="min-w-0 truncate text-[11px] font-semibold text-gray-400" title={resultsText}>
                    <span className="text-white font-semibold">{resultsNumbers}</span> results
                </span>
            </div>

            {/* Search and Library alike: at the right, just before the sort buttons. */}
            <div className="flex items-center self-stretch gap-2 shrink-0 ml-auto">
                {trashChip}
                {sortControls}
            </div>
        </>
    );

    return (
        // pb-20: room at the very bottom for the floating back-to-top and Summarize All buttons (App.tsx), so
        // they never sit on the last thumbnails when scrolled all the way down (Glossary and Biography do the same).
        <div className="w-full pb-20">
            {/* Bare heading (plus Save All) — same convention as Glossary/Biography's own top
                heading — while the rest (count, sort, filter) lives in the fixed bar below the
                grid, always (see BottomBar.tsx). sticky top-0 (with a solid bg, since this scrolls
                within App.tsx's shared content pane) keeps it visible instead of scrolling past
                with the grid beneath it. */}
            <div ref={headerRowRef} className="sticky top-0 z-10 bg-[#0f0f0f] flex items-center gap-4 min-h-9 mb-4 px-2">
                <h3 ref={headingRef} className="text-xl font-bold text-white shrink-0" title={resultsText}>Videos</h3>

                <div ref={headerControlsRef} className="ml-auto flex items-center justify-end gap-3 shrink-0">
                    {flags.showSortControlButtons && headerSortControls}
                    {saveAllButton}
                </div>
            </div>

            {/* A resultless Search reaches this with videos.length === 0 same as an empty Library
                does — the empty-state message and the bottom bar (BottomBar.tsx) both always show
                regardless of view, rather than the whole component rendering nothing. */}
            {videos.length === 0 ? (
                loading ? (
                    // The app's own loading animation, the same size as the one shown while switching workspaces (12px
                    // cells, 3px gaps, 22px above a 20px label; see public/k-life.js), since this fills the whole page.
                    <div className="flex flex-col items-center justify-center py-24 gap-[22px]">
                        <LifeLoader cell={12} gap={3} />
                        <h2 className="text-xl text-white">{isLibrary ? 'Loading' : 'Searching'}</h2>
                    </div>
                ) : idle ? (
                    // Nothing has been searched yet: an invitation, not "no results".
                    // Laid out like the empty state below: a title, then a smaller line under it.
                    <div className="text-center text-gray-500 py-24">
                        <p className="text-xl text-white mb-2">Search for videos</p>
                        <p className="text-sm">Or paste a YouTube link, handle or playlist.</p>
                    </div>
                ) : (
                    <div className="text-center text-gray-500 py-24">
                        <p className="text-xl text-white mb-2">
                            {error && onOpenApiKeySettings && error === BAD_API_KEY_MESSAGE ? (
                                <>
                                    Your{" "}
                                    <button onClick={onOpenApiKeySettings} className="underline decoration-dotted underline-offset-4 hover:text-[var(--k-accent)] transition-colors cursor-pointer">YouTube API key</button>
                                    {" "}isn't valid.
                                </>
                            ) : (error || emptyTitle || (isLibrary ? "No results" : "No search results"))}
                        </p>
                        {!error && emptyMessage && <p className="text-sm">{emptyMessage}</p>}
                    </div>
                )
            ) : (
                <>
                    <div ref={gridRef} style={{ position: 'relative', height: rowVirtualizer.getTotalSize() }}>
                        {virtualItems.map((virtualRow) => (
                            <div
                                key={virtualRow.key}
                                ref={rowVirtualizer.measureElement}
                                data-index={virtualRow.index}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
                                }}
                            >
                                <div className={`grid gap-x-3 pb-8 ${compact ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'}`}>
                                    {rows[virtualRow.index].map((video) => (
                                        <VideoCard
                                            key={video.id}
                                            video={video}
                                            compact={compact}
                                            onSelect={onSelect}
                                            onSelectWithTab={onSelectWithTab}
                                            onDelete={onDelete}
                                            allowDeletion={allowDeletion}
                                            onSaveImageAs={handleSaveImageAs}
                                            bulkAssignMode={bulkAssignMode}
                                            selected={bulkSelectedIds?.has(video.id) ?? false}
                                            onToggleSelect={onToggleBulkSelect ? (e) => handleBulkCardClick(video, e) : undefined}
                                            onBulkContextMenu={onBulkContextMenu ? (x, y) => onBulkContextMenu(video, x, y) : undefined}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>

                    {isLibrary && loadingMore && (
                        <div className="flex items-center justify-center gap-2 py-6 text-[#aaaaaa] text-sm">
                            <div className="w-4 h-4 border-2 border-[#303030] border-t-red-600 rounded-full animate-spin" />
                            Loading more...
                        </div>
                    )}
                </>
            )}

            <BottomBar>
                <div className="flex items-center gap-6 flex-1 min-w-0">
                    {driveChip}
                    {headerContent}
                </div>
            </BottomBar>
        </div>
    );
}

interface VideoCardProps {
    video: Video;
    compact: boolean;
    onSelect: (video: Video) => void;
    onSelectWithTab?: (video: Video, tab: 'transcript' | 'summary') => void;
    onDelete?: (video: Video) => void;
    allowDeletion: boolean;
    onSaveImageAs: (url: string) => void;
    bulkAssignMode?: boolean;
    selected?: boolean;
    onToggleSelect?: (e: React.MouseEvent) => void;
    onBulkContextMenu?: (x: number, y: number) => void;
}

function VideoCard({ video, compact, onSelect, onSelectWithTab, onDelete, allowDeletion, onSaveImageAs, bulkAssignMode = false, selected = false, onToggleSelect, onBulkContextMenu }: VideoCardProps) {
    return (
        <div
            className={`group flex flex-col gap-2 cursor-pointer rounded-lg transition-all ${selected ? 'ring-2 ring-[var(--k-accent)] ring-offset-2 ring-offset-[var(--k-bg)]' : ''}`}
            onClick={(e) => bulkAssignMode ? onToggleSelect?.(e) : onSelect(video)}
            onContextMenu={bulkAssignMode ? (e) => { e.preventDefault(); onBulkContextMenu?.(e.clientX, e.clientY); } : undefined}
        >
            <div className={`${compact ? 'aspect-[16/9]' : 'aspect-video'} w-full rounded-lg overflow-hidden bg-[#272727] relative`}>
                {bulkAssignMode && (
                    <div className={`absolute inset-0 z-10 transition-colors ${selected ? 'bg-[color-mix(in_srgb,var(--k-accent)_25%,transparent)]' : 'bg-black/0 group-hover:bg-black/10'}`} />
                )}
                <img
                    src={video.thumbnail}
                    alt={video.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    loading="lazy"
                    // Left unattached (rather than attached-but-no-op) in bulk mode so the event
                    // bubbles untouched to the card's own onContextMenu above, instead of this
                    // handler's e.stopPropagation() intercepting it.
                    onContextMenu={bulkAssignMode ? undefined : (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onSaveImageAs(video.thumbnail);
                    }}
                />
            </div>

            <div className="flex gap-2 relative">
                <div className="flex flex-col flex-1 overflow-hidden">
                    <h3 className={`${compact ? 'text-xs' : 'text-sm'} font-bold text-white line-clamp-2 leading-tight group-hover:text-white`}>
                        {video.title}
                    </h3>

                    <div className={`flex flex-col text-[#aaaaaa] ${compact ? 'text-[10px]' : 'text-[13px]'}`}>
                        <span
                            className="truncate"
                            title={`${(h => h ? `Handle: ${h}` : `Channel Name: ${video.author}`)(video.handle)}`}
                        >
                            {video.author || "YouTube Creator"}
                        </span>

                        <div className="whitespace-nowrap overflow-hidden text-ellipsis">
                            <span title={`Views: ${parseViewCount(video.viewCount).toLocaleString('en-US')}`}>
                                {formatViewCount(video.viewCount)} views
                            </span>
                            <span className="text-[8px] mx-1">•</span>
                            <span title={`Timestamp: ${video.publishedAt || 'Unknown'}`}>
                                {formatDate(video.publishedAt)}
                            </span>
                        </div>

                        {video.dateAdded && (
                            <div className="flex items-center justify-between mt-0.5 font-medium text-[10px]">
                                <div className="flex items-center gap-1 text-yellow-600 min-w-0">
                                    <Bookmark className="w-2.5 h-2.5 fill-yellow-600 shrink-0" />
                                    <span
                                        className="whitespace-nowrap overflow-hidden text-ellipsis"
                                        title={`Timestamp: ${video.dateAdded}`}
                                    >
                                        {formatDate(video.dateAdded)}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Absolutely positioned (rather than inline above) so these stay pinned to the
                    bottom-right corner even when dateAdded is absent and the block above doesn't render. */}
                <div className="absolute bottom-0 right-0 flex items-center gap-1 z-20">
                    {(video.hasTranscript ?? !!video.transcript) && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (onSelectWithTab) onSelectWithTab(video, 'transcript');
                            }}
                            className="p-0.5 text-green-600 hover:bg-green-600/10 rounded transition-colors cursor-pointer"
                            title="Transcript"
                        >
                            <FileText className="w-2.5 h-2.5" />
                        </button>
                    )}
                    {(video.hasSummary ?? !!video.summary) && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (onSelectWithTab) onSelectWithTab(video, 'summary');
                            }}
                            className="p-0.5 text-purple-600 hover:bg-purple-600/10 rounded transition-colors cursor-pointer"
                            title="AI Summary"
                        >
                            <Sparkles className="w-2.5 h-2.5" />
                        </button>
                    )}
                </div>

                {/* A fixed-width slot, present whether or not the button inside it is — allowDeletion
                    (allowDeletionLibrary) can flip for the whole grid at once (e.g. Read-only), and
                    without this every card's title reflows to fill the space the button leaves
                    behind, which reads as every title's wrapping changing for no reason. */}
                <div className="w-7 shrink-0 self-start">
                    {onDelete && allowDeletion && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete(video);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-[#3f3f3f] rounded-full transition-all text-white hover:cursor-pointer z-10"
                            title="Remove"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function formatDate(dateStr: string) {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
        return dateStr;
    }
    return format(d, 'MMM dd, yyyy');
}

function parseViewCount(count: string): number {
    if (!count || count === "Saved") return 0;
    const clean = count.toLowerCase().replace(/,/g, '').trim();
    let multiplier = 1;
    if (clean.includes('k')) multiplier = 1000;
    else if (clean.includes('m')) multiplier = 1000000;
    else if (clean.includes('b')) multiplier = 1000000000;
    const num = parseFloat(clean.replace(/[^0-9.]/g, ''));
    if (isNaN(num)) return 0;
    return Math.floor(num * multiplier);
}

function formatViewCount(count: string): string {
    if (count === "Saved") return 'Saved';
    if (!count) return '0';
    if (count.toLowerCase().includes('view')) {
        return count.split(' ')[0];
    }
    const n = parseViewCount(count);
    if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toLocaleString();
}