import { Save, Trash2, Bookmark, ArrowDown, ArrowUp, Calendar, Users, Sparkles, FileText } from 'lucide-react';
import { type Video } from '../api';
import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { format } from 'date-fns';
import { saveImageAs } from '../lib/save-image-as';

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
}

export function VideoList({
    videos, onSelect, onSaveAll, onDelete, saveProgress, compact = false, totalCount, isLibrary = false,
    allowDeletion = true, onSelectWithTab,
    sortField: sortFieldProp, onSortFieldChange, sortOrder: sortOrderProp, onToggleSortOrder,
    filterKind: filterProp, onFilterKindChange,
    onLoadMore, loadingMore = false, hasMore = false,
    loading = false, emptyTitle, emptyMessage,
    bulkAssignMode = false, bulkSelectedIds, onToggleBulkSelect, onBulkSelectRange, onBulkContextMenu,
}: Props) {
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

    const gridRef = useRef<HTMLDivElement>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    useLayoutEffect(() => {
        setScrollMargin(gridRef.current?.offsetTop ?? 0);
    }, [compact, isLibrary]);

    const rowVirtualizer = useWindowVirtualizer({
        count: rows.length,
        estimateSize: () => (compact ? 210 : 270),
        overscan: 4,
        scrollMargin,
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

    // Library mode keeps rendering (header + sort/filter buttons) even with zero results, so the
    // buttons stay usable to back out of a too-narrow filter/search. The plain search view keeps
    // its old behavior of rendering nothing until there's something to show.
    if (!isLibrary && videos.length === 0) return null;

    return (
        <div className="w-full">
            {/* Header Row 1: Title and Actions */}
            <div className="flex flex-col lg:flex-row justify-between items-center mb-4 gap-4 px-2">
                <div className="flex items-baseline gap-1.5 flex-shrink-0">
                    <h3 className="text-xl font-bold text-white">Videos</h3>
                    <span className="text-[#aaaaaa] text-sm font-medium">
                        {typeof totalCount === 'number' && totalCount > filteredVideos.length
                            ? `(${filteredVideos.length} of ${totalCount} results)`
                            : `(${filteredVideos.length} results)`}
                    </span>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-3 w-full lg:w-auto">
                    {onSaveAll && (
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
                    )}

                    <div className="flex items-center bg-[#1a1a1a] p-0.5 rounded-lg border border-[#272727] gap-0.5">
                        <div className="flex gap-0.5">
                            <button
                                onClick={() => handleSortField('date')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${sortField === 'date' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                <Calendar className="w-3 h-3" />
                                Date Added
                            </button>
                            {(isLibrary || videos.some(v => v.dateAdded)) && (
                                <button
                                    onClick={() => handleSortField('added')}
                                    className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${sortField === 'added' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                                >
                                    <Bookmark className="w-3 h-3" />
                                    Date Bookmarked
                                </button>
                            )}
                            <button
                                onClick={() => handleSortField('popularity')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${sortField === 'popularity' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                <Users className="w-3 h-3" />
                                Views
                            </button>
                        </div>

                        <div className="w-px h-3 bg-[#272727] mx-0.5" />

                        <button
                            onClick={toggleSortOrder}
                            className="p-1 rounded text-[#777] hover:text-white hover:bg-white/5 transition-all cursor-pointer group flex items-center gap-1"
                            title='Sort Order ↑ ↓'
                        >
                            {sortOrder === 'desc' ? (
                                <ArrowDown className="w-3.5 h-3.5 group-active:translate-y-0.5 transition-transform" />
                            ) : (
                                <ArrowUp className="w-3.5 h-3.5 group-active:-translate-y-0.5 transition-transform" />
                            )}
                        </button>
                    </div>

                    {isLibrary && (
                        <div className="flex items-center bg-[#1a1a1a] p-0.5 rounded-lg border border-[#272727] gap-0.5">
                            <button
                                onClick={() => handleFilter('all')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${filter === 'all' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                All Videos
                            </button>
                            <button
                                onClick={() => handleFilter('transcript')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${filter === 'transcript' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                <FileText className="w-3 h-3" />
                                Transcript Only
                            </button>
                            <button
                                onClick={() => handleFilter('summary')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${filter === 'summary' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                <Sparkles className="w-3 h-3" />
                                With AI Summary
                            </button>
                        </div>
                    )}
                </div>
            </div>


            {isLibrary && videos.length === 0 ? (
                loading ? (
                    <div className="flex flex-col items-center justify-center py-24 text-gray-400 space-y-4">
                        <div className="w-8 h-8 border-4 border-[#303030] border-t-red-600 rounded-full animate-spin" />
                        <p className="font-medium text-sm">Loading...</p>
                    </div>
                ) : (
                    <div className="text-center text-gray-500 py-24">
                        <p className="text-xl font-bold text-white mb-2">{emptyTitle ?? "No results"}</p>
                        {emptyMessage && <p className="text-sm">{emptyMessage}</p>}
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

                {onDelete && allowDeletion && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete(video);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-[#3f3f3f] rounded-full transition-all text-white self-start hover:cursor-pointer z-10"
                        title="Remove"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                )}
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