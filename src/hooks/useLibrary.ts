import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
    getSavedVideos, searchLibrary, saveVideo, deleteVideo, bulkSaveVideos,
    summarizeAllVideos, getSummarizedCount, getVideosByWdbs,
    type Video, type LibrarySortField, type LibrarySortOrder, type LibraryFilterKind
} from "../api";
import { type NotificationType } from "../components/Notification";
import { BRAND } from "../branding";

// Bumped from 100 -> 300 per the search revision doc ("empirically verified to work great in
// the Kinesis app").
const PAGE_SIZE = 300;
// Debounces both text-search keystrokes and sort/filter button clicks into a single request,
// mirroring the FTS search debounce this replaced. Short enough that a button click still feels
// instant.
const RELOAD_DEBOUNCE_MS = 250;

/**
 * Owns the saved-videos library: paged loading from the DB (300 rows at a time, sorted/filtered
 * server-side by `sortField`/`sortOrder`/`filterKind` so a several-thousand-video library never
 * has to be pulled into memory or re-sorted client-side — see db/search.rs's `library_order_by`/
 * `filter_kind_where`), "load more" pagination (`loadMore`, appends the next page), saving
 * (single or bulk, chunked 10-at-a-time via `handleSaveAll`), deleting (two-phase:
 * `handleDeleteVideo`/`handleDeleteFromSidebar` stage a pending confirmation, `confirmDeleteAction`
 * commits it), and bulk summarization.
 *
 * `sortField`/`sortOrder`/`filterKind`/`librarySearch` are intentionally state owned by this hook
 * (not local to VideoList) so the Library's sort/filter button selections survive a new search
 * instead of resetting to their defaults.
 */
export function useLibrary(
    pluginSummarizeEnabled: boolean,
    filteredSearchVideos: Video[],
    setNotification: (n: { message: string; type: NotificationType } | null) => void,
) {
    const [libraryVideos, setLibraryVideos] = useState<Video[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [librarySearch, setLibrarySearch] = useState("");
    // The Drive/Warp Drive side panel's selected category (see App.tsx's toggle button and
    // components/WdbsTreePanel.tsx) — `null` means browsing the Library/Portal grid normally.
    // NOT mutually exclusive with free-text search: while a category is selected, `librarySearch`
    // narrows *within* it (see fetchPage below) rather than escaping to a library-wide search —
    // only explicitly clearing the category (setWdbsFilter(null), e.g. the toggle button turning
    // the panel off) resets back to the plain, unfiltered Library/Portal view.
    const [wdbsFilter, setWdbsFilterState] = useState<string | null>(null);
    const [sortField, setSortField] = useState<LibrarySortField>('date');
    const [sortOrder, setSortOrder] = useState<LibrarySortOrder>('desc');
    const [filterKind, setFilterKind] = useState<LibraryFilterKind>('all');
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [saveProgress, setSaveProgress] = useState<string | null>(null);
    const [summarizeProgress, setSummarizeProgress] = useState<string | null>(null);
    const [summarizedCount, setSummarizedCount] = useState(0);
    const [confirmDelete, setConfirmDelete] = useState<{ video: Video; fromSidebar?: boolean } | null>(null);
    const [enabled, setEnabled] = useState(false);
    // Bumped by refreshLibrary() to force the reload effect below to re-run even when none of
    // its other deps (search/sort/filter) changed — e.g. after a bulk save or entering an
    // already-`enabled` Library view again.
    const [reloadNonce, setReloadNonce] = useState(0);

    // Tracks in-flight page-1 requests so a stale response (e.g. from before the user changed
    // the search/sort/filter again) can't clobber a newer one that resolves first.
    const requestIdRef = useRef(0);
    const loadingMoreRef = useRef(false);

    const refreshSummarizedCount = useCallback(async () => {
        if (!pluginSummarizeEnabled) return;
        try { setSummarizedCount(await getSummarizedCount()); } catch { /* ignore */ }
    }, [pluginSummarizeEnabled]);

    const fetchPage = useCallback((offset: number) => {
        const opts = { filterKind, sortField, sortOrder, limit: PAGE_SIZE, offset };
        // Search text always narrows *within* the selected category when one's active, rather
        // than escaping to a library-wide search — see wdbsFilter above.
        if (wdbsFilter) return getVideosByWdbs(wdbsFilter, librarySearch, opts);
        return librarySearch.trim()
            ? searchLibrary(librarySearch, undefined, opts)
            : getSavedVideos(undefined, false, opts);
    }, [librarySearch, wdbsFilter, filterKind, sortField, sortOrder]);

    // Explicitly clearing the category (passing `null` — e.g. the toggle button turning the
    // panel off) also resets any search text, per "reset to the default full results" — but
    // selecting a category leaves whatever search text is already there in place, now scoped to
    // that category instead of the whole library.
    const setWdbsFilter = useCallback((path: string | null) => {
        if (path === null) setLibrarySearch("");
        setWdbsFilterState(path);
    }, []);

    // Enters the Library view. Idempotent: if it's already enabled (the user is just switching
    // back from another tab, not visiting for the first time), this is a no-op — the current
    // search text, sort/filter selection, loaded pages, and scroll position are all left alone
    // rather than being reloaded from page 1 every time the tab is revisited.
    const enterLibrary = useCallback(() => {
        setEnabled(true);
    }, []);

    // Forces a page-1 reload of whatever search/sort/filter is currently active — used after a
    // mutation (bulk save, single save, summarize) changes what the DB would return, unlike
    // enterLibrary() which must NOT reload just because the user tabbed back in.
    const refreshLibrary = useCallback(() => {
        setEnabled(true);
        setReloadNonce(n => n + 1);
    }, []);

    // Reactive page-1 reload: fires whenever the user changes the search text, sort, or filter
    // (or first enters the Library). Debounced so rapid typing/clicking doesn't spam the DB.
    useEffect(() => {
        if (!enabled) return;
        const myRequestId = ++requestIdRef.current;
        setLoading(true);
        const timer = window.setTimeout(async () => {
            try {
                const res = await fetchPage(0);
                if (requestIdRef.current !== myRequestId) return; // superseded by a newer request
                setLibraryVideos(res.videos);
                setTotalCount(res.totalCount ?? res.videos.length);
                // A new search/sort/filter starts the grid over from page 1 — reset scroll too,
                // otherwise staying scrolled deep into the old (possibly much longer) result set
                // can make the infinite-scroll trigger in VideoList fire several "load more"
                // calls back-to-back just to catch up to where the page happened to be.
                window.scrollTo({ top: 0 });
                if (pluginSummarizeEnabled) refreshSummarizedCount();
            } catch {
                if (requestIdRef.current === myRequestId) {
                    setNotification({ message: `Failed to load ${BRAND.libraryLabel}`, type: "error" });
                }
            } finally {
                if (requestIdRef.current === myRequestId) setLoading(false);
            }
        }, RELOAD_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, librarySearch, wdbsFilter, sortField, sortOrder, filterKind, reloadNonce, fetchPage]);

    const hasMore = libraryVideos.length < totalCount;

    const loadMore = useCallback(async () => {
        if (loadingMoreRef.current || loading || !hasMore) return;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        const myRequestId = requestIdRef.current;
        try {
            const res = await fetchPage(libraryVideos.length);
            if (requestIdRef.current !== myRequestId) return; // a reload superseded this page
            setLibraryVideos(prev => {
                const existing = new Set(prev.map(v => v.id));
                return [...prev, ...res.videos.filter(v => !existing.has(v.id))];
            });
            if (typeof res.totalCount === 'number') setTotalCount(res.totalCount);
        } catch {
            setNotification({ message: "Failed to load more videos", type: "error" });
        } finally {
            loadingMoreRef.current = false;
            setLoadingMore(false);
        }
    }, [loading, hasMore, fetchPage, libraryVideos.length, setNotification]);

    const toggleSortOrder = useCallback(() => {
        setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    }, []);

    const handleSaveVideo = useCallback(async (video: Video, summary?: string | null, transcript?: string) => {
        if (!video) return;
        try {
            const result = await saveVideo(video, transcript ?? video.transcript ?? '', summary);
            if (result.status === 'exists') {
                setNotification({ message: `"${video.title.substring(0, 30)}..." already exists in DB.`, type: "info" });
            } else {
                setNotification({ message: `Saved "${video.title.substring(0, 30)}..." to ${BRAND.libraryLabel}.`, type: "success" });
                // Re-fetch page 1 in the background so the new video lands in its correct sorted
                // position and the total count picks it up, rather than guessing where a naive
                // client-side prepend would belong under the active sort.
                refreshLibrary();
            }
        } catch (e: any) {
            setNotification({ message: `Failed to save: ${e.message || e || "Unknown error"}`, type: "error" });
            throw e;
        }
    }, [setNotification, refreshLibrary]);

    const handleDeleteVideo = useCallback((video: Video) => {
        setConfirmDelete({ video, fromSidebar: false });
    }, []);

    const handleDeleteFromSidebar = useCallback((video: Video | null) => {
        if (video) setConfirmDelete({ video, fromSidebar: true });
    }, []);

    const confirmDeleteAction = useCallback(async (
        onSidebarClose: () => void,
    ) => {
        if (!confirmDelete) return;
        try {
            await deleteVideo(confirmDelete.video.id);
            setLibraryVideos(prev => prev.filter(v => v.id !== confirmDelete.video.id));
            setTotalCount(prev => Math.max(0, prev - 1));
            setNotification({ message: `Deleted "${confirmDelete.video.title}"`, type: "success" });
            if (confirmDelete.fromSidebar) onSidebarClose();
        } catch (e: any) {
            setNotification({ message: `Failed to delete: ${e.message}`, type: "error" });
        } finally {
            setConfirmDelete(null);
            refreshSummarizedCount();
        }
    }, [confirmDelete, refreshSummarizedCount, setNotification]);

    const handleSaveAll = useCallback(async () => {
        if (filteredSearchVideos.length === 0 || saveProgress) return;
        const chunkSize = 10;
        let allResults: any[] = [];
        try {
            for (let i = 0; i < filteredSearchVideos.length; i += chunkSize) {
                const chunk = filteredSearchVideos.slice(i, i + chunkSize);
                setSaveProgress(`Saving ${Math.min(i + chunk.length, filteredSearchVideos.length)}/${filteredSearchVideos.length}...`);
                const results = await bulkSaveVideos(chunk.map(v => v.id));
                allResults.push(...results);
            }
            let saved = 0, existed = 0, errored = 0;
            allResults.forEach(r => { if (r.error) errored++; else if (r.status === 'exists') existed++; else saved++; });
            setNotification({
                message: `Bulk save complete. Saved: ${saved}, Existed: ${existed}, Failed: ${errored}`,
                type: errored > 0 ? "info" : "success"
            });
            refreshLibrary();
        } catch (e: any) {
            setNotification({ message: `Bulk save failed: ${e.message}`, type: "error" });
        } finally {
            setSaveProgress(null);
        }
    }, [filteredSearchVideos, saveProgress, refreshLibrary, setNotification]);

    const handleSummarizeAll = useCallback(async () => {
        if (summarizeProgress || !pluginSummarizeEnabled) return;
        if (libraryVideos.length === 0 && totalCount === 0) {
            setNotification({ message: `No videos in ${BRAND.libraryLabel} to summarize`, type: "info" });
            return;
        }
        try {
            setSummarizeProgress("Starting...");
            const count = await summarizeAllVideos();
            setSummarizedCount(prev => prev + count);
            setNotification({
                message: count > 0 ? `Successfully summarized ${count} video${count > 1 ? 's' : ''}` : "All videos are already summarized",
                type: count > 0 ? "success" : "info"
            });
            if (count > 0) refreshLibrary();
        } catch (e: any) {
            setNotification({ message: `Summarize failed: ${e.message}`, type: "error" });
        } finally {
            setSummarizeProgress(null);
        }
    }, [summarizeProgress, pluginSummarizeEnabled, libraryVideos.length, totalCount, setNotification, refreshLibrary]);

    return useMemo(() => ({
        libraryVideos,
        totalCount,
        hasMore,
        librarySearch,
        setLibrarySearch,
        wdbsFilter,
        setWdbsFilter,
        sortField,
        setSortField,
        sortOrder,
        toggleSortOrder,
        filterKind,
        setFilterKind,
        loading,
        loadingMore,
        loadMore,
        saveProgress,
        summarizeProgress,
        summarizedCount,
        confirmDelete,
        setConfirmDelete,
        enterLibrary,
        refreshLibrary,
        refreshSummarizedCount,
        handleSaveVideo,
        handleDeleteVideo,
        handleDeleteFromSidebar,
        confirmDeleteAction,
        handleSaveAll,
        handleSummarizeAll,
    }), [
        libraryVideos, totalCount, hasMore, librarySearch, setLibrarySearch, wdbsFilter, setWdbsFilter,
        sortField, sortOrder, toggleSortOrder,
        filterKind, loading, loadingMore, loadMore, saveProgress, summarizeProgress, summarizedCount,
        confirmDelete, enterLibrary, refreshLibrary, refreshSummarizedCount, handleSaveVideo,
        handleDeleteVideo, handleDeleteFromSidebar, confirmDeleteAction, handleSaveAll, handleSummarizeAll,
    ]);
}
