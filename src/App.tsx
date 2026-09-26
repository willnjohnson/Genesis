import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
    getTranscript, getVideoHandle, getDisplaySettings, setDisplaySettings,
    getApiKey, getKeyStatus, getSetting, openExternalUrl, bulkUpdateVideoWdbs, addToDriveSequence,
    type Video, type BiographyEntry, saveTags, getBiography,
    getVideoById, getGlossaryTerms, getWdbsTree, decodeWdbs, type WdbsNode,
    UNSORTED_WDBS_FILTER, type TrashKind,
} from "./api";
import { useTrash } from "./hooks/useTrash";
import { useNavHistory } from "./hooks/useNavHistory";
import { TrashModal } from "./components/TrashModal";
import { driveSegmentLabel, formatBytes } from "./lib/utils";
import { resolveEntry } from "./lib/glossary";
import { setInternalLinkHandler, linkKindLabel, type LinkKind } from "./lib/internal-links";
import { LinkPicker } from "./components/LinkPicker";
import { MarkdownContextMenu } from "./components/MarkdownContextMenu";
import { TermDefinitionModal } from "./components/TermDefinitionModal";
import { saveImageAs } from "./lib/save-image-as";
import { applyTheme, resolveTheme, loadCustomThemes } from "./lib/themes";
import { SearchBar, type Facet } from "./components/SearchBar";
import { VideoList, type SortField, type SortOrder, type FilterType } from "./components/VideoList";
import { Sidebar } from "./components/Sidebar";
import { BRAND } from "./branding";
import { BrandLogo } from "./components/BrandLogo";
import { WorkspaceSwitcher } from "./components/workspace/WorkspaceSwitcher";
import { Notification, type NotificationContent } from "./components/Notification";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { SettingsModal, type SettingsTarget } from "./components/SettingsModal";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { SETTINGS_ENTRIES, TAB_LABELS, type SettingsTabId } from "./lib/settings-search";
import { Settings, ChevronUp, LayoutGrid, List, ChevronDown, Sparkles, Search, BookMarked, BookA, UserSearch, HardDrive, MousePointerClick, Key, Layers, Monitor, Palette, History, Cpu, RefreshCw, FileDown, Trash2, ArrowLeft, ArrowRight } from "lucide-react";
import { GlossaryView } from "./components/GlossaryView";
import { BiographyView } from "./components/BiographyView";
import { BiographyModal } from "./components/BiographyView";
import { WdbsTreePanel } from "./components/WdbsTreePanel";
import { BulkAssignMenu } from "./components/BulkAssignMenu";
import { useSearch } from "./hooks/useSearch";
import { useLibrary } from "./hooks/useLibrary";
import { useAutoSync } from "./hooks/useAutoSync";
import { onKinpakExportFinished } from "./lib/kinpak-export";
import { useFlags } from "./hooks/useFlags";
import { useWorkspace } from "./hooks/useWorkspace";

type ViewMode = 'search' | 'library' | 'glossary' | 'biography';

const VALID_FACETS = ['handle', 'channel_name', 'playlist', 'video', 'title_search', 'transcript_search', 'summary_search', 'term_search', 'definition_search', 'tag_search', 'person_search', 'bio_search'];
const DEFAULT_GLOSSARY_FACET = [{ type: 'term_search', value: '' }] as Facet[];

function getLibraryFacets(q: string, viewMode: ViewMode): Facet[] {
    if (!q) return [];
    const whitelist = viewMode === 'glossary'
        ? ['term_search', 'definition_search']
        : viewMode === 'biography'
            ? ['person_search', 'bio_search']
            : ['tag_search', 'term_search', 'video', 'handle', 'channel_name'];

    const FACET_RE = new RegExp(`(${whitelist.join('|')}):(?:"([^"]*)"|([^ ]*))`, 'g');
    const facets: Facet[] = [];
    let m;
    while ((m = FACET_RE.exec(q)) !== null) {
        facets.push({ type: m[1] as any, value: "" });
    }
    return facets;
}

function getLibraryQuery(q: string, viewMode: ViewMode): string {
    if (!q) return '';
    const whitelist = viewMode === 'glossary'
        ? ['term_search', 'definition_search']
        : viewMode === 'biography'
            ? ['person_search', 'bio_search']
            : ['tag_search', 'term_search', 'video', 'handle', 'channel_name'];

    // Check if q starts with a facet prefix and has exactly one colon
    const colonIndex = q.indexOf(':');
    const firstSpaceIndex = q.indexOf(' ');
    // Only treat this as a bare "facetname:value" display-unwrap when what's actually before the
    // colon is one of this mode's known facet names — otherwise a bare leading ':' (a Warp Drive
    // designator, e.g. ":UAP floating" in Library mode — see db/search.rs) would have its colon
    // eaten here even though it isn't a facet at all.
    const isKnownFacetPrefix = colonIndex > 0 && whitelist.includes(q.slice(0, colonIndex));

    if (isKnownFacetPrefix && (firstSpaceIndex === -1 || firstSpaceIndex > colonIndex)) {
        const rest = q.slice(colonIndex + 1);
        const whitelistPattern = `(${whitelist.join('|')})`;
        if (!new RegExp(`${whitelistPattern}:`).test(rest)) {
            let val = rest;
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            return val;
        }
    }

    const FACET_RE = new RegExp(`(${whitelist.join('|')}):(?:"([^"]*)"|([^ ]*))`, 'g');
    return q.replace(FACET_RE, '');
}

function App() {
    // ── App-level state ─────────────────────────────────────────────────────
    const [viewMode, setViewMode] = useState<ViewMode>('search');
    const [showGlossaryMenu, setShowGlossaryMenu] = useState(false);
    // Toggleable Drive/Warp Drive side panel inside the Library/Portal grid (see
    // components/WdbsTreePanel.tsx) — replaced the standalone Drive/Warp Drive tab this app used
    // to have.
    const [showDrivePanel, setShowDrivePanel] = useState(false);
    // Human-readable label of library.wdbsFilter, for the empty-state message below — the panel
    // only tracks the encoded path, not the display segment shown in the tree.
    const [driveFilterLabel, setDriveFilterLabel] = useState('');
    // The selected node's own curated alias (null when it doesn't have one, or nothing's
    // selected) — shown as "Drive: X (alias)" in VideoList's bottom-bar chip (see driveLabel
    // below). Used to live as its own strip under the tree in WdbsTreePanel; moved here so it has
    // one home instead of two.
    const [driveFilterAlias, setDriveFilterAlias] = useState<string | null>(null);
    // Bulk Assign Mode: click a card to select it (no checkboxes), right-click to assign the
    // whole selection to a Warp Drive category at once — see BulkAssignMenu.tsx. Only offered
    // while the Drive panel is open, since assigning implies picking a destination category.
    const [bulkAssignMode, setBulkAssignMode] = useState(false);
    const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
    const [bulkAssignMenu, setBulkAssignMenu] = useState<{ x: number; y: number; videoIds: string[] } | null>(null);
    const [bulkAssigning, setBulkAssigning] = useState(false);
    const [bulkAssignError, setBulkAssignError] = useState<string | null>(null);
    const [glossarySearchQuery, setGlossarySearchQuery] = useState("term_search:");
    const [biographySearchQuery, setBiographySearchQuery] = useState("person_search:");
    const [notification, setNotification] = useState<NotificationContent | null>(null);
    const [showScrollTop, setShowScrollTop] = useState(false);
    // The one scrollable region (see the `mt-4 flex-1 overflow-y-auto` div in the return below) —
    // everywhere that used to assume the whole window scrolls (this file, VideoList.tsx's
    // virtualizer, AlphabetJumpNav.tsx, useLibrary.ts's scroll-reset) now targets this instead.
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [showSettings, setShowSettings] = useState(false);
    // Where Settings should open when a link elsewhere sends you to a particular page of it.
    const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | undefined>(undefined);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [videoListMode, setVideoListMode] = useState<'grid' | 'compact'>('grid');
    const [navigationOrientation, setNavigationOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
    const [searchSortField, setSearchSortField] = useState<SortField>('date');
    const [searchSortOrder, setSearchSortOrder] = useState<SortOrder>('desc');
    const [searchFilterKind, setSearchFilterKind] = useState<FilterType>('all');
    const [pluginSummarizeEnabled, setPluginSummarizeEnabled] = useState(false);
    const [pluginPhotosynthesisEnabled, setPluginPhotosynthesisEnabled] = useState(false);
    // Feature flags: settings-table rows a DB owner sets (or a sync server enforces) to hide or
    // disable parts of the app. See lib/flags.ts and docs/customizing.md.
    const { flags, loaded: flagsLoaded, reload: reloadFlags } = useFlags();
    const { labels, reload: reloadWorkspace } = useWorkspace();
    const {
        showSearch, allowDeletionLibrary, allowModificationGlossary, showSummarizeButton,
        showSummarizeOllama, showSummarizeVenice, showSynthesizeVenice, showSynthesizePixabay,
        showSynthesizeUpload, showBiography, showDrive, allowEditBio, allowEditTranscriptOnNA,
        allowEditWDBS,
    } = flags;
    // Bumped whenever a video's WDBS assignment or symlinks change (Sidebar's editor, bulk
    // assign) so WdbsTreePanel's per-category counts refetch — those mutations happen outside
    // the tree panel itself, which otherwise has no way to know its counts just went stale.
    const [driveVersion, setDriveVersion] = useState(0);

    // ── Sidebar / transcript state ───────────────────────────────────────────
    const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
    const [transcript, setTranscript] = useState("");
    const [loadingTranscript, setLoadingTranscript] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [cachedSummaries, setCachedSummaries] = useState<Record<string, string>>({});
    const [videoTags, setVideoTags] = useState<string[]>([]);
    const [sidebarInitialTab, setSidebarInitialTab] = useState<'transcript' | 'summary' | undefined>(undefined);
    const [selectedBiography, setSelectedBiography] = useState<BiographyEntry | null>(null);
    // A glossary term opened from a link inside some markdown (see lib/internal-links.ts).
    const [linkedTerm, setLinkedTerm] = useState<{ term: string; definition: string; drives: string[] } | null>(null);

    // ── Hooks ────────────────────────────────────────────────────────────────
    const search = useSearch(hasApiKey);

    const effectivePluginSummarizeEnabled = pluginSummarizeEnabled && (showSummarizeOllama || showSummarizeVenice);
    const effectivePluginPhotosynthesisEnabled = pluginPhotosynthesisEnabled && (showSynthesizeVenice || showSynthesizePixabay || showSynthesizeUpload);

    const library = useLibrary(
        effectivePluginSummarizeEnabled,
        search.filteredVideos,
        setNotification,
        scrollContainerRef,
    );

    // ── Computed: which videos to show in VideoList ──────────────────────────
    // Library filtering/sorting/pagination all happen server-side now (see useLibrary's
    // reload effect and db/search.rs's library_order_by/filter_kind_where), so this is just a
    // pass-through per view mode rather than a second client-side filter pass.
    const displayedVideos = useMemo(() => {
        return viewMode === 'library' ? library.libraryVideos : search.filteredVideos;
    }, [viewMode, library.libraryVideos, search.filteredVideos]);

    // ── Init ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        const handleLinkClick = async (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const anchor = target.closest('a');
            if (anchor && anchor.href &&
                !anchor.href.startsWith(window.location.origin) &&
                !anchor.href.startsWith('blob:') &&
                anchor.getAttribute('href') !== '#' &&
                !anchor.href.startsWith('javascript:')) {
                e.preventDefault();
                await openExternalUrl(anchor.href);
            }
        };
        document.addEventListener('click', handleLinkClick);
        return () => document.removeEventListener('click', handleLinkClick);
    }, []);

    // Disable Ctrl+J download shortcut
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
                e.preventDefault();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Reads what App keeps in memory besides the feature flags (API access, plugin switches) and
    // re-reads the flags. Runs at startup and after a sync, since a sync server can enforce any of them.
    const loadFlags = useCallback(async () => {
        // "Has API access" = an own YouTube key OR a sync-server license for it.
        getKeyStatus().then(s => setHasApiKey(s.youtube.available)).catch(() => getApiKey().then(k => setHasApiKey(!!k)));
        getSetting('plugin_summarize_enabled').then(v => setPluginSummarizeEnabled(v === 'true'));
        getSetting('plugin_photosynthesis_enabled').then(v => setPluginPhotosynthesisEnabled(v === 'true'));
        await Promise.all([reloadFlags(), reloadWorkspace()]);
    }, [reloadFlags, reloadWorkspace]);

    // Keep the current view reachable. The first time flags load it also opens the DB owner's
    // defaultView; after that it only moves the user off a view that has just been hidden (a sync
    // can hide one while it's open).
    const appliedDefaultView = useRef(false);
    useEffect(() => {
        if (!flagsLoaded) return;
        if (!appliedDefaultView.current) {
            appliedDefaultView.current = true;
            setViewMode(flags.pickView());
            return;
        }
        setViewMode(v => (flags.viewVisible[v] ? v : flags.pickView()));
    }, [flagsLoaded, flags]);

    // A search's message ("No videos found...", "You must import an API Key...") belongs to the Search
    // view. Leave it and the message goes, so it isn't still sitting there in the Library or Glossary
    // (or, stale, when you come back).
    const clearSearchError = search.setError;
    useEffect(() => {
        if (viewMode !== 'search') clearSearchError(null);
    }, [viewMode, clearSearchError]);

    // Drive going away takes its panel and Bulk Assign Mode with it; so does losing edit rights.
    useEffect(() => {
        if (!showDrive) setShowDrivePanel(false);
    }, [showDrive]);
    // What Bulk Assign Mode can do: assign a Drive (allowEditWDBS) and/or add to a Drive's sequence.
    // The whole mode is hidden outright when allowEditDriveLinking is off, regardless of either.
    const canBulkSequence = showDrive && flags.showSequences && flags.allowEditSequences;
    const canBulkAssign = showDrive && flags.allowEditDriveLinking && (allowEditWDBS || canBulkSequence);
    useEffect(() => {
        if (!canBulkAssign) {
            // Bulk Assign Mode's toggle button disappears when editing is disabled: exit the mode
            // too so the grid doesn't stay stuck in bulk-select with no visible way out.
            setBulkAssignMode(false);
            setBulkSelectedIds(new Set());
            setBulkAssignMenu(null);
        }
    }, [canBulkAssign]);

    useEffect(() => {
        // Which database is open is the workspace's business (see WorkspaceGate): by the time this
        // runs the backend already has one, so there's nothing to restore here.
        const initialize = async () => {
            await loadFlags();
        };
        initialize().catch(error => {
            console.error('Failed to initialize app:', error);
        });
    }, [loadFlags]);

    const handleSaveImageAs = useCallback(async (url: string) => {
        // Try to suggest a filename based on the URL or default
        let suggestedName = 'image.webp';
        try {
            const urlParts = url.split('/');
            const lastPart = urlParts[urlParts.length - 1].split('?')[0];
            if (lastPart.match(/\.(png|jpg|jpeg|webp|gif)$/i)) {
                suggestedName = lastPart;
            }
        } catch { /* ignore */ }

        await saveImageAs(url, {
            filters: [
                { name: 'Images', extensions: ['webp', 'png', 'jpg', 'jpeg', 'gif'] },
                { name: 'All Files', extensions: ['*'] }
            ],
            defaultPath: suggestedName
        });
    }, []);

    useEffect(() => {
        const handleGlobalContextMenu = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target instanceof HTMLImageElement) {
                e.preventDefault();
                e.stopPropagation();
                handleSaveImageAs(target.src);
            }
        };
        document.addEventListener('contextmenu', handleGlobalContextMenu);
        return () => document.removeEventListener('contextmenu', handleGlobalContextMenu);
    }, [handleSaveImageAs]);

    // ── Theme / display settings ─────────────────────────────────────────────
    // Also re-run after a sync: a server can enforce the theme, list mode and orientation.
    const loadDisplay = useCallback(() => {
        return Promise.all([getDisplaySettings(), loadCustomThemes()]).then(([settings, customThemes]) => {
            applyTheme(resolveTheme(settings.theme, customThemes));
            setVideoListMode((settings.videoListMode as 'grid' | 'compact') || 'grid');
            setNavigationOrientation((settings.navigationOrientation as 'horizontal' | 'vertical') || 'horizontal');
        }).catch(() => applyTheme(resolveTheme(undefined, [])));
    }, []);

    useEffect(() => { loadDisplay(); }, [loadDisplay]);

    // The vertical rail's width, published as a CSS variable rather than threaded down as a prop:
    // a true `fixed` element anywhere in the tree (like AlphabetJumpNav's bottom bar) can stay clear
    // of the rail with plain CSS, without every such element needing to know navigationOrientation.
    useEffect(() => {
        document.documentElement.style.setProperty('--k-rail-width', navigationOrientation === 'vertical' ? '4rem' : '0px');
    }, [navigationOrientation]);

    // Everything a sync (or pack import) can change that App holds in memory: enforced flags, the
    // theme, the license-backed key status, and the content itself.
    const handleSyncApplied = useCallback(() => {
        loadFlags().catch(console.error);
        loadDisplay();
        library.refreshLibrary();
        library.refreshSummarizedCount();
        setDriveVersion(v => v + 1);
    }, [loadFlags, loadDisplay, library.refreshLibrary, library.refreshSummarizedCount]);

    useAutoSync(handleSyncApplied);

    // A Kinpak export can outlast the Settings window it was started from: say how it ended wherever you are.
    useEffect(() => onKinpakExportFinished(({ file, summary, error }) => {
        const name = file.split(/[\\/]/).pop() ?? file;
        setNotification(error
            ? { message: `Kinpak export failed: ${error}`, type: "error" }
            : { message: `Kinpak saved: ${name} (${formatBytes(summary?.bytes ?? 0)})`, type: "success" });
    }), []);

    // ── Scroll-to-top ────────────────────────────────────────────────────────
    // Re-attached whenever the view changes: Library renders its own scroll pane (beside the Drive
    // panel), a different element from the one Search/Glossary/Biography share, so a listener put
    // on the first pane never hears the Library's scrolling.
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const onScroll = () => setShowScrollTop(el.scrollTop > 400);
        onScroll();
        el.addEventListener("scroll", onScroll);
        return () => el.removeEventListener("scroll", onScroll);
    }, [viewMode]);

    // ── Load library when switching to Library mode ──────────────────────────
    // Paging, sorting, filtering, and re-fetching on search-text change all happen inside
    // useLibrary's own reactive effect now (see hooks/useLibrary.ts); this just flips it on.
    // enterLibrary() is idempotent, so tabbing back into the Library after visiting Search
    // doesn't re-fetch or reset anything — the search text, sort/filter, and loaded pages from
    // before are left exactly as they were.
    useEffect(() => {
        if (viewMode === 'library') {
            library.enterLibrary();
        }
    }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Preserve Library scroll position across tab switches ──────────────────
    // Capture scrollY the moment we leave the Library tab, then restore it once we're back and
    // the (already-loaded, unchanged) video grid has repainted at its old height.
    const libraryScrollYRef = useRef(0);
    const prevViewModeRef = useRef(viewMode);
    useEffect(() => {
        const cameFrom = prevViewModeRef.current;
        if (cameFrom === 'library' && viewMode !== 'library') {
            libraryScrollYRef.current = scrollContainerRef.current?.scrollTop ?? 0;
        } else if (viewMode === 'library' && cameFrom !== 'library') {
            requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: libraryScrollYRef.current }));
        }
        prevViewModeRef.current = viewMode;
    }, [viewMode]);

    // ── Refresh summarized count when entering Library (if plugin on) ─────────
    useEffect(() => {
        if (viewMode === 'library' && pluginSummarizeEnabled) {
            library.refreshSummarizedCount();
        }
    }, [viewMode, pluginSummarizeEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Handlers ─────────────────────────────────────────────────────────────
    const handleSelectVideo = useCallback(async (video: Video, tab?: 'transcript' | 'summary') => {
        setSidebarInitialTab(tab);
        setSelectedVideo(video);
        setVideoTags(video.tags ? video.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : []);
        setSidebarOpen(true);
        setTranscript("");
        setLoadingTranscript(true);

        // Fetch transcript and handle in parallel
        const [text, fetchedHandle] = await Promise.all([
            getTranscript(video.id).catch(e => `Failed to load transcript: ${e.message || String(e)}`),
            getVideoHandle(video.id).catch(() => null)
        ]);

        setTranscript(text);

        // If video doesn't have handle, use fetched one
        if (!video.handle && fetchedHandle) {
            setSelectedVideo(prev => prev ? { ...prev, handle: fetchedHandle } : null);
        }

        setLoadingTranscript(false);
    }, []);

    const handleSearch = useCallback(async (query: string) => {
        if (viewMode === 'library') {
            library.setLibrarySearch(query);
            return;
        }
        setSidebarOpen(false);
        const videoResult = await search.handleSearch(query);
        if (videoResult) handleSelectVideo(videoResult);
    }, [viewMode, library, search, handleSelectVideo]);

    const toggleVideoListMode = async () => {
        const newMode = videoListMode === 'grid' ? 'compact' : 'grid';
        setVideoListMode(newMode);
        try {
            const current = await getDisplaySettings();
            await setDisplaySettings({ ...current, videoListMode: newMode });
        } catch { /* ignore */ }
    };

    // Shared by Glossary's "Search by Tag"/"Search in Library/Portal" and Biography's "View
    // More" — all three jump into the Library/Portal grid with a specific query. If the Drive
    // panel was left open with a Warp Drive category selected, `library.wdbsFilter` stays set
    // and useLibrary's fetch routes the query through getVideosByWdbs instead of plain
    // searchLibrary — that endpoint doesn't understand facet syntax (`handle:`/`tag_search:`/...)
    // the way searchLibrary does, so the query came back malformed and the fetch failed outright
    // ("Failed to Load Portal/Library"), on top of silently (and confusingly) scoping the search
    // to whatever category happened to still be selected. Closing the Drive panel (and the bulk-
    // assign state that only makes sense while it's open — mirrors the panel's own toggle-off
    // handler below) before setting the query avoids both problems.
    const goToLibrarySearch = useCallback((query: string) => {
        setShowDrivePanel(false);
        library.setWdbsFilter(null);
        setDriveFilterLabel('');
        setBulkAssignMode(false);
        setBulkSelectedIds(new Set());
        setBulkAssignMenu(null);
        setSidebarOpen(false);
        setViewMode('library');
        library.setLibrarySearch(query);
    }, [library]);

    // Biography's "In Drive" list: opens the Library/Portal with the Drive panel showing and that
    // entry selected. Leftover search text is cleared first, since selecting a Drive keeps it
    // (and would narrow the Drive's videos by it).
    const goToLibraryDrive = useCallback((storagePath: string, label: string, alias: string | null = null) => {
        setBulkAssignMode(false);
        setBulkSelectedIds(new Set());
        setBulkAssignMenu(null);
        setSidebarOpen(false);
        setViewMode('library');
        library.setLibrarySearch('');
        library.setWdbsFilter(storagePath);
        setDriveFilterLabel(label);
        setDriveFilterAlias(alias);
        setShowDrivePanel(true);
    }, [library]);

    // 'tag' searches Quick Tags (#), 'term' searches glossary terms (^), 'library' is plain text.
    const handleSearchInLibrary = (term: string, mode: 'tag' | 'term' | 'library') => {
        goToLibrarySearch(mode === 'tag' ? `tag_search:${term}` : mode === 'term' ? `term_search:${term}` : term);
    };

    const handleViewBiography = useCallback(async (channelHandle: string) => {
        const bio = await getBiography(channelHandle);
        if (bio) {
            setSelectedBiography(bio);
            return;
        }
        setNotification({ message: `No biography found for ${channelHandle}`, type: "error" });
    }, []);

    // What clicking an in-app link (`[text](kinesis://glossary/...)`) does. A target that has gone
    // away, or a part of the app the DB owner has hidden, gets a message instead.
    const handleOpenLink = useCallback(async (kind: LinkKind, key: string) => {
        const say = (message: string) => setNotification({ message, type: "error" });
        const unavailable = () => say(`${linkKindLabel(kind, labels)} links aren't available here.`);
        try {
            switch (kind) {
                case 'glossary': {
                    if (!flags.showGlossary) return unavailable();
                    // A term can have a different definition per Drive; a link is by name alone, so
                    // prefer the one filed under the Drive being browsed (if any), else uncategorized.
                    const browsing = library.wdbsFilter?.startsWith(':') ? [':' + library.wdbsFilter.slice(1).split('-')[0]] : [];
                    const found = resolveEntry((await getGlossaryTerms()).filter(t => t.definition.trim() !== ''), key, browsing);
                    if (!found) return say(`"${key}" is no longer in the glossary.`);
                    setSelectedBiography(null);
                    setLinkedTerm(found);
                    return;
                }
                case 'bio': {
                    if (!flags.showBiography) return unavailable();
                    const bio = await getBiography(key);
                    if (!bio) return say(`No biography found for ${key}.`);
                    setLinkedTerm(null);
                    setSelectedBiography(bio);
                    return;
                }
                case 'video': {
                    const video = await getVideoById(key);
                    if (!video) return say("That video is no longer in the library.");
                    setLinkedTerm(null);
                    setSelectedBiography(null);
                    await handleSelectVideo(video);
                    return;
                }
                case 'drive': {
                    if (!flags.showDrive) return unavailable();
                    const find = (nodes: WdbsNode[]): WdbsNode | undefined => {
                        for (const n of nodes) {
                            if (n.path === key) return n;
                            const inner = find(n.children);
                            if (inner) return inner;
                        }
                        return undefined;
                    };
                    const node = find(await getWdbsTree());
                    if (!node) return say(`${decodeWdbs(key) || key} has no videos any more.`);
                    setLinkedTerm(null);
                    setSelectedBiography(null);
                    goToLibraryDrive(node.path, driveSegmentLabel(decodeWdbs(node.path)));
                    return;
                }
            }
        } catch (e) {
            say(typeof e === 'string' ? e : (e as { message?: string })?.message ?? "Couldn't open that link.");
        }
    }, [flags.showGlossary, flags.showBiography, flags.showDrive, handleSelectVideo, goToLibraryDrive, library.wdbsFilter]);

    useEffect(() => setInternalLinkHandler(handleOpenLink), [handleOpenLink]);

    // ── Command palette (Ctrl/Cmd+K) ─────────────────────────────────────────
    const [paletteOpen, setPaletteOpen] = useState(false);
    // Latest values for the key handler below, which is set up once.
    const paletteState = useRef({ open: false, sidebarOpen: false });
    paletteState.current = { open: paletteOpen, sidebarOpen };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k' || e.defaultPrevented) return;
            // In a markdown editor Ctrl+K is "insert link" (lib/markdown-editor.ts): leave it be.
            if ((e.target as HTMLElement | null)?.tagName === 'TEXTAREA') return;
            e.preventDefault();
            if (paletteState.current.open) { setPaletteOpen(false); return; }
            // Only from the plain pages: not over the video sidebar, and not with anything else covering the
            // window (a modal, Settings, the Workspaces screen, a confirmation). Every one of those is a
            // full-window `fixed inset-0` layer, same as the Esc handler above relies on.
            const covered = paletteState.current.sidebarOpen
                || Array.from(document.querySelectorAll<HTMLElement>('div.fixed.inset-0'))
                    .some(el => el.id !== 'k-life' && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
            if (!covered) setPaletteOpen(true);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    // ── Esc closes the topmost modal ─────────────────────────────────────────
    // Every modal here is a full-window `fixed inset-0` backdrop that closes when the backdrop itself
    // is clicked, so Esc "clicks" the topmost one. Marking a backdrop `data-no-escape` (Settings) makes
    // Esc leave it alone — and whatever is under it, since the topmost is the one that decides. Anything
    // that handles Esc itself (the palette, the link picker, a dropdown) calls preventDefault first.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
            const backdrops = Array.from(document.querySelectorAll<HTMLElement>('div.fixed.inset-0'))
                .filter(el => el.id !== 'k-life' && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
            if (backdrops.length === 0) return;
            const z = (el: HTMLElement) => Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
            // Highest z-index wins; among equals, the one added to the page last.
            const top = backdrops.reduce((best, el) => (z(el) >= z(best) ? el : best));
            if (top.closest('[data-no-escape]')) return;
            e.preventDefault();
            top.click();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    // The palette's actions: only what this workspace has switched on.
    // Back and forward (Alt+Left / Alt+Right, or the mouse's back and forward buttons) through the places visited:
    // a section, the Drive picked in the Library, the video open in the sidebar. Search text in a section is kept
    // with its place but typing in it doesn't make a new one (see hooks/useNavHistory.ts).
    const navPlace = {
        view: viewMode,
        libraryQuery: library.librarySearch,
        wdbs: library.wdbsFilter,
        driveLabel: driveFilterLabel,
        driveAlias: driveFilterAlias,
        showDrivePanel,
        glossaryQuery: glossarySearchQuery,
        biographyQuery: biographySearchQuery,
        video: sidebarOpen ? selectedVideo : null,
    };
    const nav = useNavHistory(
        navPlace,
        p => `${p.view}|${p.wdbs ?? ''}|${p.video?.id ?? ''}`,
        p => {
            setBulkAssignMode(false);
            setBulkSelectedIds(new Set());
            setBulkAssignMenu(null);
            setViewMode(p.view);
            // The Drive first: choosing one (or none) resets the Library's search text, so that goes in after.
            library.setWdbsFilter(p.wdbs);
            library.setLibrarySearch(p.libraryQuery);
            setDriveFilterLabel(p.driveLabel);
            setDriveFilterAlias(p.driveAlias);
            setShowDrivePanel(p.showDrivePanel);
            setGlossarySearchQuery(p.glossaryQuery);
            setBiographySearchQuery(p.biographyQuery);
            if (p.video) {
                void handleSelectVideo(p.video);
            } else {
                setSidebarOpen(false);
                setSidebarInitialTab(undefined);
            }
        },
    );
    useEffect(() => {
        // Not while something is on top of the page (a dialog, Settings, the Trash): those aren't places. The
        // sidebar's own dimming layer is marked so it doesn't count.
        const covered = () => !!document.querySelector('div.fixed.inset-0:not(#k-life):not([data-nav-ok])');
        // Option+Arrow moves by word in a text box on a Mac; Cmd+[ and Cmd+] are its own back and forward.
        const mac = /Mac/i.test(navigator.platform);
        const onKey = (e: KeyboardEvent) => {
            let dir = 0;
            if (mac) {
                if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === '[' || e.key === ']')) dir = e.key === '[' ? -1 : 1;
            } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                dir = e.key === 'ArrowLeft' ? -1 : 1;
            }
            if (dir === 0) return;
            e.preventDefault();
            if (covered()) return;
            if (dir < 0) nav.back(); else nav.forward();
        };
        const onMouse = (e: MouseEvent) => {
            // The side buttons of a mouse: 3 is back, 4 is forward.
            if (e.button !== 3 && e.button !== 4) return;
            e.preventDefault();
            if (covered()) return;
            if (e.button === 3) nav.back(); else nav.forward();
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('mouseup', onMouse, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('mouseup', onMouse, true);
        };
    }, [nav.back, nav.forward]);

    // The Trash window is App's, so the status bar chips and the command palette both open it. Nothing in it is
    // saved anywhere: it's emptied when the app closes.
    const [trashOpen, setTrashOpen] = useState<TrashKind | null>(null);
    const videoTrash = useTrash('video');
    const glossaryTrash = useTrash('glossary');
    // Bumped when a term is put back, so a mounted Glossary reloads.
    const [glossaryReload, setGlossaryReload] = useState(0);

    const paletteCommands = useMemo<PaletteCommand[]>(() => {
        const cmds: PaletteCommand[] = [];
        if (flags.viewVisible.search) cmds.push({ id: 'view-search', label: `Go to ${labels.aliasSearch}`, icon: Search, keywords: 'search youtube find', run: () => setViewMode('search') });
        if (flags.viewVisible.library) cmds.push({ id: 'view-library', label: `Go to ${labels.aliasLibrary}`, icon: BookMarked, keywords: 'library saved videos', run: () => setViewMode('library') });
        if (flags.viewVisible.glossary) cmds.push({ id: 'view-glossary', label: `Go to ${labels.aliasGlossary}`, icon: BookA, keywords: 'glossary terms tags', run: () => { setGlossarySearchQuery(""); setViewMode('glossary'); } });
        if (flags.viewVisible.biography) cmds.push({ id: 'view-biography', label: `Go to ${labels.aliasBiography}`, icon: UserSearch, keywords: 'biography people channels creators', run: () => { setBiographySearchQuery(""); setViewMode('biography'); } });
        if (flags.settingsVisible) cmds.push({ id: 'settings', label: 'Open Settings', icon: Settings, keywords: 'preferences options', run: () => setShowSettings(true) });
        // Each page of Settings, and the particular settings people look for, found by what they're
        // called (lib/settings-search.ts). Only pages this workspace shows; Sync only in development.
        if (flags.settingsVisible) {
            const tabIcons: Record<SettingsTabId, React.ElementType> = {
                api: Key, db: HardDrive, workspace: Layers, display: Monitor, theme: Palette,
                history: History, plugins: Cpu, sync: RefreshCw, export: FileDown,
            };
            for (const entry of SETTINGS_ENTRIES) {
                if (!flags.tabVisible[entry.tab] || (entry.tab === 'sync' && !import.meta.env.DEV)) continue;
                // The tray setting only exists on Windows.
                if (entry.label === 'Keep running in the tray' && !/Win/i.test(navigator.platform)) continue;
                cmds.push({
                    id: `settings:${entry.tab}:${entry.apiSection ?? ''}:${entry.label}`,
                    group: 'Settings',
                    label: entry.label,
                    hint: `Settings > ${TAB_LABELS[entry.tab]}`,
                    icon: tabIcons[entry.tab],
                    keywords: entry.keywords,
                    run: () => { setSettingsTarget({ tab: entry.tab, apiSection: entry.apiSection }); setShowSettings(true); },
                });
            }
        }
        // The Trash of each section that has something in it, from anywhere: the two live in different views
        // (the Library's videos, the Glossary's terms), so each gets its own entry, named for its section.
        if (flags.viewVisible.library && videoTrash.count > 0) {
            cmds.push({ id: 'trash-video', label: `Open Trash: ${labels.aliasLibrary}`, hint: `${videoTrash.count} in Trash`, icon: Trash2, keywords: 'trash deleted restore undo videos', run: () => setTrashOpen('video') });
        }
        if (flags.viewVisible.glossary && glossaryTrash.count > 0) {
            cmds.push({ id: 'trash-glossary', label: `Open Trash: ${labels.aliasGlossary}`, hint: `${glossaryTrash.count} in Trash`, icon: Trash2, keywords: 'trash deleted restore undo terms tags', run: () => setTrashOpen('glossary') });
        }
        if (nav.canBack) cmds.push({ id: 'nav-back', label: 'Go back', hint: 'Alt + Left', icon: ArrowLeft, keywords: 'previous back history return', run: nav.back });
        if (nav.canForward) cmds.push({ id: 'nav-forward', label: 'Go forward', hint: 'Alt + Right', icon: ArrowRight, keywords: 'next forward history', run: nav.forward });
        if (flags.showListModeToggle) {
            cmds.push({ id: 'layout', label: videoListMode === 'grid' ? 'Switch to compact layout' : 'Switch to grid layout', icon: videoListMode === 'grid' ? List : LayoutGrid, keywords: 'layout list grid compact view', run: () => { void toggleVideoListMode(); } });
        }
        return cmds;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flags, labels, videoListMode, videoTrash.count, glossaryTrash.count, nav.canBack, nav.canForward]);


    const handleAddTag = async (term: string) => {
        if (!videoTags.includes(term)) {
            const newTags = [...videoTags, term];
            setVideoTags(newTags);
            if (selectedVideo) {
                try {
                    await saveTags(selectedVideo.id, newTags.join(','));
                    setSelectedVideo(prev => prev ? { ...prev, tags: newTags.join(',') } : null);
                    library.libraryVideos.forEach(v => {
                        if (v.id === selectedVideo.id) v.tags = newTags.join(',');
                    });
                } catch (e) {
                    console.error('Failed to save tag:', e);
                }
            }
        }
    };

    const handleRemoveTag = async (term: string) => {
        const newTags = videoTags.filter(t => t !== term);
        setVideoTags(newTags);
        if (selectedVideo) {
            try {
                await saveTags(selectedVideo.id, newTags.join(','));
                setSelectedVideo(prev => prev ? { ...prev, tags: newTags.join(',') } : null);
                library.libraryVideos.forEach(v => {
                    if (v.id === selectedVideo.id) v.tags = newTags.join(',');
                });
            } catch (e) {
                console.error('Failed to remove tag:', e);
            }
        }
    };

    const handleCacheSummary = (videoId: string, summary: string) => {
        setCachedSummaries(prev => ({ ...prev, [videoId]: summary }));
        setSelectedVideo(prev => (prev && prev.id === videoId) ? { ...prev, summary, hasSummary: true } : prev);
        library.libraryVideos.forEach(v => {
            if (v.id === videoId) { v.summary = summary; v.hasSummary = true; }
        });
    };

    const handleToggleBulkSelect = useCallback((video: Video) => {
        setBulkSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(video.id)) next.delete(video.id); else next.add(video.id);
            return next;
        });
    }, []);

    // Shift-click range select/deselect — VideoList.tsx's handleBulkCardClick has already worked
    // out the full resulting selection (base-selection-before-the-anchor-click, with the anchor-
    // to-target range forced to match the anchor's own state), so this just applies it wholesale
    // rather than layering another add/remove on top.
    const handleBulkSelectRange = useCallback((nextSelectedIds: Set<string>) => {
        setBulkSelectedIds(nextSelectedIds);
    }, []);

    // Standard file-manager-style right-click: if the card is already part of the selection, the
    // menu applies to the whole selection; otherwise it applies to just this card (replacing
    // whatever was selected before), so a single video can be reassigned without a separate
    // select-then-right-click step.
    const handleBulkContextMenu = useCallback((video: Video, x: number, y: number) => {
        setBulkAssignError(null);
        setBulkSelectedIds(prev => {
            const targetIds = prev.has(video.id) ? Array.from(prev) : [video.id];
            setBulkAssignMenu({ x, y, videoIds: targetIds });
            return prev.has(video.id) ? prev : new Set([video.id]);
        });
    }, []);

    // `alsoSequence` (from BulkAssignMenu's checkbox) appends the same videos to that Drive's own
    // sequence right after assigning them — as a second step, once assignment has actually
    // succeeded, so add_to_drive_sequence's "filed at or beneath the Drive" check can never reject
    // them: they were just filed there, by this same action.
    const handleBulkAssign = useCallback(async (wdbs: string, alsoSequence: boolean) => {
        if (!bulkAssignMenu) return;
        setBulkAssigning(true);
        setBulkAssignError(null);
        try {
            const result = await bulkUpdateVideoWdbs(bulkAssignMenu.videoIds, wdbs);
            const label = wdbs.trim() || "unassigned";

            if (result.succeeded.length === 0 && result.failed.length > 0) {
                setBulkAssignError(result.failed[0][1]);
                return;
            }

            let seqAdded = 0;
            let seqAlreadyIn = 0;
            // Nothing to sequence into once the selection was cleared back to unassigned.
            if (alsoSequence && wdbs.trim() && result.succeeded.length > 0) {
                const shown = new Map(displayedVideos.map((v, i) => [v.id, i]));
                const ids = [...result.succeeded].sort((a, b) => (shown.get(a) ?? Infinity) - (shown.get(b) ?? Infinity));
                const seqOut = await addToDriveSequence(wdbs, ids);
                seqAdded = seqOut.added;
                seqAlreadyIn = seqOut.alreadyIn;
            }

            const assignPart = `Assigned ${result.succeeded.length} video${result.succeeded.length === 1 ? '' : 's'} to ${label}`;
            const failedPart = result.failed.length > 0 ? `; ${result.failed.length} failed` : '';
            const seqPart = alsoSequence && wdbs.trim()
                ? `, added ${seqAdded} to its sequence${seqAlreadyIn > 0 ? ` (${seqAlreadyIn} already in it)` : ''}`
                : '';
            setNotification({ message: `${assignPart}${seqPart}${failedPart}.`, type: result.failed.length === 0 ? "success" : "info" });
            setBulkSelectedIds(new Set());
            setBulkAssignMenu(null);
            library.refreshLibrary();
            setDriveVersion(v => v + 1);
        } catch (e: any) {
            setBulkAssignError(typeof e === "string" ? e : e?.message ?? "Bulk assign failed.");
        } finally {
            setBulkAssigning(false);
        }
    }, [bulkAssignMenu, library, displayedVideos, setNotification]);

    // Adds the selection to a Drive's sequence in the order the grid shows it (so sorting the grid by
    // date, then selecting a range, gives a chronological sequence), not the order they were clicked.
    const handleBulkAddToSequence = useCallback(async (drive: string) => {
        if (!bulkAssignMenu) return;
        setBulkAssigning(true);
        setBulkAssignError(null);
        try {
            const shown = new Map(displayedVideos.map((v, i) => [v.id, i]));
            const ids = [...bulkAssignMenu.videoIds].sort((a, b) => (shown.get(a) ?? Infinity) - (shown.get(b) ?? Infinity));
            const out = await addToDriveSequence(drive, ids);
            const name = drive.trim().toUpperCase();
            const skipped = [
                out.alreadyIn > 0 ? `${out.alreadyIn} already in it` : '',
                out.notInDrive > 0 ? `${out.notInDrive} not filed under ${name}` : '',
            ].filter(Boolean).join(', ');
            if (out.added === 0) {
                setBulkAssignError(`Nothing added${skipped ? `: ${skipped}` : ''}.`);
            } else {
                setNotification({
                    message: `Added ${out.added} video${out.added === 1 ? '' : 's'} to the ${name} sequence${skipped ? `; ${skipped}` : ''}.`,
                    type: skipped ? "info" : "success",
                });
                setBulkSelectedIds(new Set());
                setBulkAssignMenu(null);
            }
        } catch (e: any) {
            setBulkAssignError(typeof e === "string" ? e : e?.message ?? "Couldn't add to the sequence.");
        } finally {
            setBulkAssigning(false);
        }
    }, [bulkAssignMenu, displayedVideos, setNotification]);

    // "No videos are tagged under X yet" is only true when the category itself is being shown
    // unfiltered — with a search or filter (transcript/summary) active, the category can easily
    // be non-empty while still returning zero results for that combination, so the message needs
    // to say that instead of implying the category has nothing in it.
    const libraryEmptyMessage = library.wdbsFilter
        ? (library.librarySearch.trim() || library.filterKind !== 'all'
            ? `Nothing in "${driveFilterLabel}" matches the current search/filter.`
            : `No videos are tagged under "${driveFilterLabel}" yet.`)
        : (library.librarySearch.trim() ? "Try different search terms" : "Find videos and save their transcripts here.");

    // The bottom bar's Drive chip prefix: "Drive" for the synthetic All/Unsorted states (nothing
    // to show depth for), otherwise "L<depth>" (L1 = a root node, L2 = one level under it, etc.),
    // with a tooltip on the prefix itself giving the ancestor path above the selected node (e.g.
    // hovering "L3" on a node at :CRYPTO-BITCOIN-INFO shows ":CRYPTO-BITCOIN") — the value shown
    // next to the prefix is still just the node's own segment/alias, so this is how the chip says
    // "this is a level-3 node" without repeating the whole path there too.
    const driveLabelPrefix = (() => {
        const path = library.wdbsFilter;
        if (!path || path === UNSORTED_WDBS_FILTER) return { text: 'Drive', tooltip: undefined as string | undefined };
        const segments = path.replace(/^θψ/, '').split('_').filter(Boolean);
        const ancestors = segments.slice(0, -1);
        return { text: `L${segments.length}`, tooltip: ancestors.length > 0 ? `:${ancestors.join('-')}` : undefined };
    })();

    // Where the Videos section starts on screen (right of the navigation rail and the Drive panel, when it is open):
    // the Summarize All button is placed from it, so it stays in the Videos section instead of over the Drive panel.
    const [videosLeft, setVideosLeft] = useState(0);
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (viewMode !== 'library' || !el) return;
        const measure = () => setVideosLeft(Math.round(el.getBoundingClientRect().left));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        window.addEventListener('resize', measure);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [viewMode, showDrivePanel, showDrive, navigationOrientation]);

    // Deleting the video the dialog asked about (or, with Confirm Before Deleting off, the one a delete button asked
    // about, with no dialog at all).
    const runConfirmedDelete = async () => {
        await library.confirmDeleteAction(() => { setSidebarOpen(false); setSelectedVideo(null); });
        // The Drive tree's per-category video counts (and any category that just
        // emptied) are computed server-side, so re-fetch instead of leaving them stale.
        setDriveVersion(v => v + 1);
    };
    const autoDeletingRef = useRef(false);
    useEffect(() => {
        if (!library.confirmDelete || flags.confirmBeforeDeleting || autoDeletingRef.current) return;
        autoDeletingRef.current = true;
        void runConfirmedDelete().finally(() => { autoDeletingRef.current = false; });
    }, [library.confirmDelete, flags.confirmBeforeDeleting]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="h-screen overflow-hidden bg-[#0f0f0f] text-white font-sans selection:bg-red-500/30 selection:text-white select-none flex flex-col">
            {/* Navigation - conditional rendering */}
            {navigationOrientation === 'vertical' && (
                <div className="fixed left-0 top-0 h-full w-16 bg-[#0f0f0f] border-r border-[#272727] z-40 flex flex-col items-center pt-6">
                    {/* Logo */}
                    <div className="mb-8">
                        <BrandLogo
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleSaveImageAs(BRAND.logo);
                            }}
                        />
                    </div>

                    {/* Navigation Icons */}
                    <div className="flex-1 flex flex-col items-center gap-4">
                        {showSearch && (
                            <button
                                onClick={() => setViewMode('search')}
                                className={`p-2 rounded-lg transition-all cursor-pointer ${viewMode === 'search' ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-white hover:bg-[#272727]'}`}
                                title={labels.aliasSearch}
                            >
                                <Search className="w-5 h-5" />
                            </button>
                        )}
                        {flags.viewVisible.library && (
                            <button
                                onClick={() => setViewMode('library')}
                                className={`p-2 rounded-lg transition-all cursor-pointer ${viewMode === 'library' ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-white hover:bg-[#272727]'}`}
                                title={labels.aliasLibrary}
                            >
                                <BookMarked className="w-5 h-5" />
                            </button>
                        )}
                        {flags.viewVisible.glossary && (
                            <button
                                onClick={() => { setGlossarySearchQuery(""); setViewMode('glossary'); }}
                                className={`p-2 rounded-lg transition-all cursor-pointer ${viewMode === 'glossary' ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-white hover:bg-[#272727]'}`}
                                title={labels.aliasGlossary}
                            >
                                <BookA className="w-5 h-5" />
                            </button>
                        )}
                        {showBiography && (
                            <button
                                onClick={() => { setBiographySearchQuery(""); setViewMode('biography'); }}
                                className={`p-2 rounded-lg transition-all cursor-pointer ${viewMode === 'biography' ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-white hover:bg-[#272727]'}`}
                                title={labels.aliasBiography}
                            >
                                <UserSearch className="w-5 h-5" />
                            </button>
                        )}
                    </div>

                    {/* Bottom Icons (with the bottom padding the rail used to have, now that the switcher below sits flush) */}
                    <div className="flex flex-col items-center gap-4 pb-4">
                        {flags.showListModeToggle && (
                            <button
                                onClick={toggleVideoListMode}
                                className="p-2 text-gray-400 hover:text-white transition-all cursor-pointer rounded-lg hover:bg-[#272727]"
                                title={videoListMode === 'grid' ? "Switch to Compact View" : "Switch to Grid View"}
                            >
                                {videoListMode === 'grid' ? <List className="w-5 h-5 k-reveal" /> : <LayoutGrid className="w-5 h-5 k-pop" />}
                            </button>
                        )}
                        {flags.settingsVisible && (
                            <button
                                onClick={() => setShowSettings(true)}
                                className="p-2 text-gray-400 hover:text-white transition-all cursor-pointer rounded-lg hover:bg-[#272727]"
                                title="Settings"
                            >
                                <Settings className="w-5 h-5 k-spin-once" />
                            </button>
                        )}
                    </div>

                    {/* A direct child of the rail (not of the icon group above), so it spans the rail's full
                        width and sits flush with the bottom of the window, without their padding. */}
                    <WorkspaceSwitcher variant="rail" />
                </div>
            )}

            <div className={`${navigationOrientation === 'vertical' ? 'ml-16' : ''} px-4 pt-4 shrink-0`}>
                <header className="relative z-40 transition-all">
                    {/* Top bar - only show in horizontal mode */}
                    {navigationOrientation === 'horizontal' && (
                        <div className="flex items-center justify-between mb-6 relative border-b border-[#272727] pb-2">
                            <div className="flex items-center gap-3">
                                <BrandLogo
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleSaveImageAs(BRAND.logo);
                                    }}
                                />
                                {/* ml-0.5: the wordmark and the workspace name under it sit 2px further from the logo. */}
                                <div className="flex flex-col ml-0.5">
                                    <h1 className="text-2xl font-bold tracking-tighter text-white">
                                        <span className="text-[var(--k-accent)]">{BRAND.name.substring(0, 3)}</span>{BRAND.name.substring(3)}
                                    </h1>
                                    <WorkspaceSwitcher variant="name" name={labels.workspaceName} />
                                </div>
                            </div>

                            <div className="flex gap-3">
                                {(['search', 'library'] as ViewMode[]).map(mode => {
                                    if (!flags.viewVisible[mode]) return null;
                                    // 'library' renders as the workspace's Library alias (e.g. "Portal") — the
                                    // ViewMode value itself stays 'library' either way.
                                    const label = mode === 'library' ? labels.aliasLibrary : labels.aliasSearch;
                                    return (
                                        <button
                                            key={mode}
                                            onClick={() => setViewMode(mode)}
                                            className={`px-4 py-2 rounded-lg font-semibold text-sm transition-all cursor-pointer ${viewMode === mode ? 'bg-white text-black' : 'bg-[#272727] text-white hover:bg-[#3f3f3f]'}`}
                                        >
                                            {label}
                                        </button>
                                    );
                                })}
                                {(flags.viewVisible.glossary || showBiography) && (
                                <div className="relative">
                                    <button
                                        onClick={() => setShowGlossaryMenu(!showGlossaryMenu)}
                                        onBlur={() => setTimeout(() => setShowGlossaryMenu(false), 200)}
                                        className={`p-2 rounded-lg transition-all cursor-pointer flex items-center justify-center ${viewMode === 'glossary' || viewMode === 'biography' || showGlossaryMenu ? 'bg-white text-black' : 'bg-[#272727] text-white hover:bg-[#3f3f3f]'}`}
                                        title="More Options"
                                    >
                                        <ChevronDown className="w-5 h-5" />
                                    </button>
                                    {showGlossaryMenu && (
                                        <div className="absolute top-full right-0 mt-2 min-w-36 w-max bg-[#272727] border border-[#3f3f3f] rounded-lg shadow-xl z-51 overflow-hidden">
                                            {flags.viewVisible.glossary && (
                                                <button
                                                    onClick={() => { setGlossarySearchQuery(""); setViewMode('glossary'); setShowGlossaryMenu(false); }}
                                                    className={`w-full text-left px-4 py-2 text-sm hover:bg-[#3f3f3f] cursor-pointer ${viewMode === 'glossary' ? 'text-white font-bold' : 'text-gray-300'}`}
                                                >
                                                    {labels.aliasGlossary}
                                                </button>
                                            )}
                                            {showBiography && (
                                                <button
                                                    onClick={() => { setBiographySearchQuery(""); setViewMode('biography'); setShowGlossaryMenu(false); }}
                                                    className={`w-full text-left px-4 py-2 text-sm hover:bg-[#3f3f3f] cursor-pointer ${viewMode === 'biography' ? 'text-white font-bold' : 'text-gray-300'}`}
                                                >
                                                    {labels.aliasBiography}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                                )}
                                {flags.showListModeToggle && (
                                    <button
                                        onClick={toggleVideoListMode}
                                        className="p-2 ml-2 text-gray-400 hover:text-white transition-all cursor-pointer bg-[#272727] rounded-lg"
                                        title={videoListMode === 'grid' ? "Switch to Compact View" : "Switch to Grid View"}
                                    >
                                        {videoListMode === 'grid' ? <List className="w-5 h-5 k-reveal" /> : <LayoutGrid className="w-5 h-5 k-pop" />}
                                    </button>
                                )}
                                {flags.settingsVisible && (
                                    <button
                                        onClick={() => setShowSettings(true)}
                                        className="p-2 ml-1 text-gray-400 hover:text-white transition-all cursor-pointer"
                                        title="Settings"
                                    >
                                        <Settings className="w-5 h-5 k-spin-once" />
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="flex items-center gap-3">
                        {viewMode === 'library' && showDrive && (
                            <button
                                onClick={() => setShowDrivePanel(prev => {
                                    const next = !prev;
                                    // "Toggling off will reset library videos to its default full
                                    // results thing" — clearing the category filter (and, via
                                    // setWdbsFilter, any leftover search text) does that. Bulk
                                    // Assign Mode only exists while this panel is open, so it (and
                                    // any in-progress selection) goes with it.
                                    if (!next) {
                                        library.setWdbsFilter(null);
                                        setBulkAssignMode(false);
                                        setBulkSelectedIds(new Set());
                                        setBulkAssignMenu(null);
                                    }
                                    return next;
                                })}
                                className={`shrink-0 p-2.5 mb-2 rounded-lg border transition-all cursor-pointer ${showDrivePanel ? 'bg-red-600 border-red-600 text-white' : 'bg-[#121212] border-[#404040] text-gray-400 hover:text-white hover:border-[#505050]'}`}
                                title={`Toggle ${labels.aliasDriveName}`}
                            >
                                <HardDrive className="w-5 h-5" />
                            </button>
                        )}
                        <div className="flex-1 min-w-0">
                            <SearchBar
                                key={viewMode}
                                onSearch={viewMode === 'glossary' ? setGlossarySearchQuery : (viewMode === 'biography' ? setBiographySearchQuery : (viewMode === 'library' ? library.setLibrarySearch : handleSearch))}
                                onLiveFilter={
                                    viewMode === 'search'
                                        ? (search.videos.length > 0 ? search.handleInput : undefined)
                                        : (viewMode === 'glossary' ? setGlossarySearchQuery : (viewMode === 'biography' ? setBiographySearchQuery : (viewMode === 'library' ? library.setLibrarySearch : undefined)))
                                }
                                loading={search.loading}
                                viewMode={viewMode}
                                initialFacets={
                                    viewMode === 'glossary'
                                        ? getLibraryFacets(glossarySearchQuery, 'glossary')
                                        : viewMode === 'biography'
                                            ? getLibraryFacets(biographySearchQuery, 'biography')
                                            : (viewMode === 'library' ? (library.librarySearch ? getLibraryFacets(library.librarySearch, 'library') : []) : search.activeFacets as Facet[])
                                }
                                initialQuery={
                                    viewMode === 'glossary'
                                        ? getLibraryQuery(glossarySearchQuery, 'glossary')
                                        : viewMode === 'biography'
                                            ? getLibraryQuery(biographySearchQuery, 'biography')
                                        : (viewMode === 'library' ? getLibraryQuery(library.librarySearch, 'library') : search.activeText)
                                }
                                 placeholder={viewMode === 'glossary' ? "Look up Tag/Term" : (viewMode === 'biography' ? `Look up ${labels.aliasBiographyItem}` : (viewMode === 'library' ? "Look up Videos and Transcripts" : "Search YouTube handle, playlist URL, or video URL"))}
                            />
                        </div>
                    </div>
                </header>
            </div>

            {/* Everything above (rail, header, search bar) is shrink-0/fixed and stays put.
                --k-bottom-bar-height's marginBottom (not padding — padding wouldn't shrink this
                element's own box, so its scrollbar track would still run behind BottomBar) ends
                this region's box exactly where BottomBar begins. This div itself never scrolls
                (overflow-hidden) — it just lays out whichever of the two shapes below applies. */}
            {/* No mt-4 here: header already ends with mb-4, and each view's own sticky heading
                (VideoList.tsx/GlossaryView.tsx/BiographyView.tsx) adds its own mb-4 below itself —
                stacking a third top margin on top of those left too much whitespace above it. */}
            <div
                className={`${navigationOrientation === 'vertical' ? 'ml-16' : ''} px-4 flex-1 min-h-0 overflow-hidden`}
                style={{ marginBottom: 'var(--k-bottom-bar-height, 0px)' }}
            >
                {viewMode === 'library' ? (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-400 flex gap-6 h-full">
                        {showDrivePanel && showDrive && (
                            // Always beside the grid, never stacked above it (no flex-col
                            // fallback at narrow widths): the panel instead shrinks its own width
                            // down to min-w-40. Its own scroll (h-full, independent of
                            // scrollContainerRef) rather than sharing the grid's: scrolling the
                            // video list shouldn't move the Drive tree out of view, and vice
                            // versa. WdbsTreePanel's own row labels truncate with an ellipsis (and
                            // a title tooltip) to cope with the narrower width.
                            <div className="w-80 min-w-40 shrink h-full flex flex-col gap-3">
                                <WdbsTreePanel
                                    className="flex-1 min-h-0 flex flex-col"
                                    selectedPath={library.wdbsFilter ?? undefined}
                                    onSelect={(path, label, alias) => {
                                        // Clicking the already-selected node (a real Drive or the
                                        // synthetic Unsorted entry) steps back off it, the same as
                                        // the toggle button turning the panel off — see
                                        // setWdbsFilter(null)'s own reset-search behavior.
                                        if (path === library.wdbsFilter) {
                                            library.setWdbsFilter(null);
                                            setDriveFilterLabel('');
                                            setDriveFilterAlias(null);
                                        } else {
                                            library.setWdbsFilter(path);
                                            setDriveFilterLabel(label);
                                            setDriveFilterAlias(alias);
                                        }
                                    }}
                                    refreshKey={driveVersion}
                                    allowEditAlias={allowEditWDBS}
                                />
                                {canBulkAssign && (
                                    <button
                                        onClick={() => setBulkAssignMode(prev => {
                                            const next = !prev;
                                            if (!next) setBulkSelectedIds(new Set());
                                            return next;
                                        })}
                                        // mb-2: this column's own h-full already stops right at the
                                        // fixed bottom bar's top edge (via the shared marginBottom
                                        // on the content region above), so without this the button
                                        // sits flush against it with no breathing room.
                                        className={`shrink-0 mb-2 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-xs font-bold transition-all cursor-pointer ${bulkAssignMode ? 'bg-red-600 border-red-600 text-white' : 'bg-[#121212] border-[#404040] text-gray-400 hover:text-white hover:border-[#505050]'}`}
                                        title={`Select videos, then right-click to ${allowEditWDBS ? `assign them to a ${labels.aliasDriveName} category` : ''}${allowEditWDBS && canBulkSequence ? ', optionally also adding them to its sequence' : canBulkSequence ? 'add them to a sequence' : ''}`}
                                    >
                                        <MousePointerClick className="w-3.5 h-3.5" />
                                        {bulkAssignMode ? `Bulk Assign Mode (${bulkSelectedIds.size} selected)` : "Bulk Assign Mode"}
                                    </button>
                                )}
                            </div>
                        )}
                        {/* position: relative makes this VideoList.tsx's gridRef offsetParent, so
                            its existing offsetTop-based scrollMargin keeps resolving correctly
                            against this pane instead of the document. */}
                        <div ref={scrollContainerRef} className="flex-1 min-w-0 h-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] custom-scrollbar relative">
                            <VideoList
                                videos={displayedVideos}
                                onSelect={handleSelectVideo}
                                onSelectWithTab={handleSelectVideo}
                                onDelete={library.handleDeleteVideo}
                                compact={videoListMode === 'compact'}
                                totalCount={library.totalCount}
                                isLibrary={true}
                                allowDeletion={allowDeletionLibrary}
                                sortField={library.sortField}
                                onSortFieldChange={library.setSortField}
                                sortOrder={library.sortOrder}
                                onToggleSortOrder={library.toggleSortOrder}
                                filterKind={library.filterKind}
                                onFilterKindChange={library.setFilterKind}
                                onLoadMore={library.loadMore}
                                loadingMore={library.loadingMore}
                                hasMore={library.hasMore}
                                loading={library.loading}
                                emptyTitle={library.wdbsFilter ? "No videos" : (library.librarySearch.trim() ? "No results" : `Build your ${labels.aliasLibrary}`)}
                                emptyMessage={libraryEmptyMessage}
                                bulkAssignMode={bulkAssignMode}
                                bulkSelectedIds={bulkSelectedIds}
                                onToggleBulkSelect={handleToggleBulkSelect}
                                onBulkSelectRange={handleBulkSelectRange}
                                onBulkContextMenu={handleBulkContextMenu}
                                driveLabel={showDrivePanel
                                    ? (driveFilterLabel ? (driveFilterAlias ? `${driveFilterLabel} (${driveFilterAlias})` : driveFilterLabel) : 'All')
                                    : undefined}
                                driveLabelPrefix={showDrivePanel ? driveLabelPrefix.text : undefined}
                                driveLabelPrefixTooltip={driveLabelPrefix.tooltip}
                                onOpenTrash={() => setTrashOpen('video')}
                                scrollContainerRef={scrollContainerRef}
                            />
                        </div>
                    </div>
                ) : (
                    // Glossary/Biography/Search share the one scroll pane directly — no Drive
                    // panel to keep independent of it. position: relative, see the comment above.
                    <div ref={scrollContainerRef} className="h-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] custom-scrollbar relative">
                        {viewMode === 'glossary' ? (
                            <GlossaryView
                                searchQuery={glossarySearchQuery}
                                onSearchInLibrary={handleSearchInLibrary}
                                onOpenVideo={handleSelectVideo}
                                allowModification={allowModificationGlossary}
                                onNotify={setNotification}
                                onOpenTrash={() => setTrashOpen('glossary')}
                                reloadSignal={glossaryReload}
                                scrollContainerRef={scrollContainerRef}
                            />
                        ) : viewMode === 'biography' ? (
                            <BiographyView searchQuery={biographySearchQuery} onVideoSelect={handleSelectVideo} onViewMore={(handle) => goToLibrarySearch(`handle:${handle.replace('@', '')}`)} onDriveSelect={showDrive ? goToLibraryDrive : undefined} allowEditBio={allowEditBio} scrollContainerRef={scrollContainerRef} />
                        ) : (
                            <>
                                <VideoList
                                    videos={displayedVideos}
                                    onSelect={handleSelectVideo}
                                    onSelectWithTab={handleSelectVideo}
                                    onSaveAll={flags.saveAllAllowed && displayedVideos.length > 0 ? library.handleSaveAll : undefined}
                                    saveProgress={library.saveProgress}
                                    compact={videoListMode === 'compact'}
                                    error={search.error}
                                    loading={search.loading}
                                    idle={!search.hasSearched && !search.error}
                                    onOpenApiKeySettings={flags.settingsVisible && flags.tabVisible.api ? () => { setSettingsTarget({ tab: 'api', apiSection: 'youtube' }); setShowSettings(true); } : undefined}
                                    sortField={searchSortField}
                                    onSortFieldChange={setSearchSortField}
                                    sortOrder={searchSortOrder}
                                    onToggleSortOrder={() => setSearchSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
                                    filterKind={searchFilterKind}
                                    onFilterKindChange={setSearchFilterKind}
                                    scrollContainerRef={scrollContainerRef}
                                />
                                {displayedVideos.length > 0 && search.continuationToken && !search.isSearch && (
                                    <div className="mt-16 pb-20 text-center flex justify-center gap-4">
                                        <button
                                            onClick={search.handleLoadMore}
                                            disabled={search.loadingMore}
                                            className="px-10 py-3 bg-[#272727] text-white rounded-full text-sm font-bold hover:bg-[#3f3f3f] transition-all disabled:opacity-50 cursor-pointer"
                                        >
                                            {search.loadingMore
                                                ? <div className="flex items-center gap-2"><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Loading...</div>
                                                : "Load More"
                                            }
                                        </button>
                                        <button
                                            onClick={search.handleLoadAll}
                                            disabled={search.loadingMore}
                                            className="px-10 py-3 bg-white text-black rounded-full text-sm font-bold hover:bg-[#e5e5e5] transition-all disabled:opacity-50 cursor-pointer"
                                        >
                                            {search.loadingMore ? "Loading..." : "Load All"}
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}

                {bulkAssignMenu && (
                    <BulkAssignMenu
                        x={bulkAssignMenu.x}
                        y={bulkAssignMenu.y}
                        count={bulkAssignMenu.videoIds.length}
                        onAssign={handleBulkAssign}
                        canAssignDrive={allowEditWDBS}
                        canAddToSequence={canBulkSequence}
                        defaultDrive={library.wdbsFilter ? decodeWdbs(library.wdbsFilter).toUpperCase() : ''}
                        onAddToSequence={handleBulkAddToSequence}
                        onClose={() => { setBulkAssignMenu(null); setBulkAssignError(null); }}
                        assigning={bulkAssigning}
                        error={bulkAssignError}
                    />
                )}
            </div>

            <Sidebar
                isOpen={sidebarOpen}
                onClose={() => {
                    setSidebarOpen(false);
                    setSidebarInitialTab(undefined);
                }}
                transcript={transcript}
                loading={loadingTranscript}
                title={selectedVideo?.title || ""}
                videoId={selectedVideo?.id}
                handle={selectedVideo?.handle}
                onSave={selectedVideo ? (summary) => library.handleSaveVideo(selectedVideo, summary, transcript) : undefined}
                onDelete={() => library.handleDeleteFromSidebar(selectedVideo)}
                onRefetch={selectedVideo ? () => handleSelectVideo(selectedVideo) : undefined}
                onTranscriptChange={setTranscript}
                pluginSummarizeEnabled={effectivePluginSummarizeEnabled}
                pluginPhotosynthesisEnabled={effectivePluginPhotosynthesisEnabled}
                showSynthesizeVenice={showSynthesizeVenice}
                showSynthesizePixabay={showSynthesizePixabay}
                showSynthesizeUpload={showSynthesizeUpload}
                onSummaryGenerated={library.refreshSummarizedCount}
                cachedSummaries={cachedSummaries}
                onCacheSummary={handleCacheSummary}
                allowDeletion={allowDeletionLibrary}
                isLibrary={viewMode === 'library'}
                videoTags={videoTags}
                onHandleClick={handleViewBiography}
                onAddTag={handleAddTag}
                onRemoveTag={handleRemoveTag}
                onSearchInLibrary={handleSearchInLibrary}
                initialTab={sidebarInitialTab}
                showBiography={showBiography}
                allowEditTranscriptOnNA={allowEditTranscriptOnNA}
                wdbs={selectedVideo?.wdbs}
                allowEditWDBS={allowEditWDBS}
                onWdbsUpdated={(newWdbs) => {
                    setSelectedVideo(prev => prev ? { ...prev, wdbs: newWdbs } : prev);
                    library.refreshLibrary();
                }}
                onWdbsChanged={() => setDriveVersion(v => v + 1)}
                onSelectDrive={showDrive ? goToLibraryDrive : undefined}
                driveContext={library.wdbsFilter}
                onVideoSelect={handleSelectVideo}
            />

            <SettingsModal
                openTo={settingsTarget}
                isOpen={showSettings && flags.settingsVisible}
                onClose={() => {
                    setShowSettings(false);
                    // allowEditWDBS has a live toggle in PluginsTab (unlike most other
                    // settings-table-only flags) but no dedicated onChange callback plumbed
                    // through, so the flags are re-read on close. (Leaving Bulk Assign Mode when
                    // editing is switched off is handled by the effect that watches the flag.)
                    reloadFlags();
                    reloadWorkspace();
                }}
                onStatusChange={setHasApiKey}
                onVideoListModeChange={setVideoListMode}
                currentVideoListMode={videoListMode}
                onNavigationOrientationChange={setNavigationOrientation}
                currentNavigationOrientation={navigationOrientation}
                onPluginsChange={() => {
                    getSetting('plugin_summarize_enabled').then(v => setPluginSummarizeEnabled(v === 'true'));
                    getSetting('plugin_photosynthesis_enabled').then(v => setPluginPhotosynthesisEnabled(v === 'true'));
                }}
                onSyncComplete={handleSyncApplied}
                showSummarizeOllama={showSummarizeOllama}
                showSummarizeVenice={showSummarizeVenice}
                showSynthesizeVenice={showSynthesizeVenice}
                showSynthesizePixabay={showSynthesizePixabay}
                showSynthesizeUpload={showSynthesizeUpload}
            />

            {trashOpen && (
                <TrashModal
                    kind={trashOpen}
                    onClose={() => setTrashOpen(null)}
                    onRestored={trashOpen === 'video' ? library.refreshLibrary : () => setGlossaryReload(n => n + 1)}
                />
            )}

            {notification && (
                <Notification
                    message={notification.message}
                    type={notification.type}
                    action={notification.action}
                    onClose={() => setNotification(null)}
                />
            )}

            {selectedBiography && (
                <BiographyModal
                    biography={selectedBiography}
                    onClose={() => setSelectedBiography(null)}
                    onVideoSelect={handleSelectVideo}
                    onViewMore={(handle) => {
                        goToLibrarySearch(`handle:${handle}`);
                        setSelectedBiography(null);
                    }}
                    onDriveSelect={showDrive ? (path, label) => {
                        goToLibraryDrive(path, label);
                        setSelectedBiography(null);
                    } : undefined}
                    allowEditBio={allowEditBio}
                />
            )}

            {linkedTerm && (
                <TermDefinitionModal
                    term={linkedTerm}
                    onClose={() => setLinkedTerm(null)}
                    onSearch={(term, mode) => {
                        setLinkedTerm(null);
                        handleSearchInLibrary(term, mode);
                    }}
                    onOpenVideo={video => handleSelectVideo(video)}
                />
            )}

            <LinkPicker />

            <CommandPalette
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
                commands={paletteCommands}
                onOpenVideo={video => { void handleSelectVideo(video); }}
                onOpenDrive={(path, label, alias) => goToLibraryDrive(path, label, alias)}
                onOpenTerm={term => { void handleOpenLink('glossary', term); }}
                onOpenBio={handle => { void handleOpenLink('bio', handle); }}
            />
            <MarkdownContextMenu />

            {library.confirmDelete && flags.confirmBeforeDeleting && (
                <ConfirmDialog
                    message={`Are you sure you want to delete "${library.confirmDelete.video.title}"?`}
                    onConfirm={runConfirmedDelete}
                    onCancel={() => library.setConfirmDelete(null)}
                />
            )}

            <button
                // Not "smooth": VideoList's rows are virtualized with an *estimated* row height.
                // A multi-frame smooth scroll gives it time to swap in newly-visible rows
                // mid-animation and correct that estimate, which shifts the pane's total height
                // while the browser's scroll animation is still computing against the original
                // one — the scroll can end up landing wherever that shifting layout leaves it,
                // well short of 0. A single instant jump happens before the virtualizer gets a
                // chance to do that.
                onClick={() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: "auto" })}
                className={`fixed right-11 p-2.5 bg-red-600 hover:bg-red-500 text-white rounded-full shadow-lg transition-opacity duration-200 cursor-pointer z-39 active:scale-95 ${showScrollTop ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                // `max`, not a flat add: this button's resting spot (3rem) already clears every
                // other view with nothing docked at the bottom (including Library/Search with the
                // setting off). --k-bottom-bar-height (VideoList.tsx) only needs to push it up
                // further once that bar is actually taller than 2rem or so — adding the two
                // unconditionally floated it a whole extra 3rem above an already-short bar.
                style={{ bottom: 'max(3rem, calc(var(--k-bottom-bar-height, 0px) + 1rem))' }}
                title="Back to Top"
            >
                <ChevronUp className="w-5 h-5" style={{ color: '#ffffff' }} />
            </button>

            {viewMode === 'library' && effectivePluginSummarizeEnabled && showSummarizeButton && flags.allowSummarizeAll && !sidebarOpen && (
                <button
                    onClick={library.handleSummarizeAll}
                    disabled={!!library.summarizeProgress}
                    className={`fixed summarize-btn h-10 px-4 bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-500 hover:to-blue-500 rounded-lg text-sm font-bold transition-all shadow-lg hover:shadow-purple-500/25 disabled:opacity-50 flex items-center gap-2 z-40 ${!library.summarizeProgress ? 'cursor-pointer' : 'cursor-default'}`}
                    // At the left edge of the Videos section (wherever the Drive panel leaves it), on the same line as
                    // the back-to-top button at the right, so it never sits over the Drive panel.
                    style={{ left: videosLeft + 16, bottom: 'max(3rem, calc(var(--k-bottom-bar-height, 0px) + 1rem))' }}
                >
                    {library.summarizeProgress ? (
                        <>
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            {library.summarizeProgress}
                        </>
                    ) : (
                        <>
                            <Sparkles className="w-4 h-4" />
                            {library.summarizedCount > 0 ? `Summarized (${library.summarizedCount}/${library.totalCount})` : 'Summarize All'}
                        </>
                    )}
                </button>
            )}
        </div>
    );
}

export default App;
