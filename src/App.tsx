import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
    getTranscript, getVideoHandle, getDisplaySettings, setDisplaySettings,
    getApiKey, getKeyStatus, getSetting, openExternalUrl, bulkUpdateVideoWdbs,
    type Video, type BiographyEntry, saveTags, getBiography,
    getVideoById, getGlossaryTerms, getWdbsTree, decodeWdbs, type WdbsNode,
} from "./api";
import { driveSegmentLabel, formatBytes } from "./lib/utils";
import { setInternalLinkHandler, linkKindLabel, type LinkKind } from "./lib/internal-links";
import { LinkPicker } from "./components/LinkPicker";
import { MarkdownContextMenu } from "./components/MarkdownContextMenu";
import { TermDefinitionModal } from "./components/TermDefinitionModal";
import { saveImageAs } from "./lib/save-image-as";
import { applyTheme, resolveTheme, loadCustomThemes } from "./lib/themes";
import { SearchBar, type Facet } from "./components/SearchBar";
import { VideoList } from "./components/VideoList";
import { Sidebar } from "./components/Sidebar";
import { BRAND } from "./branding";
import { BrandLogo } from "./components/BrandLogo";
import { WorkspaceSwitcher } from "./components/workspace/WorkspaceSwitcher";
import { Notification, type NotificationType } from "./components/Notification";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { SettingsModal } from "./components/SettingsModal";
import { Settings, ChevronUp, LayoutGrid, List, ChevronDown, Sparkles, Search, BookMarked, BookA, UserSearch, HardDrive, MousePointerClick } from "lucide-react";
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

const VALID_FACETS = ['handle', 'playlist', 'video', 'title_search', 'transcript_search', 'summary_search', 'term_search', 'definition_search', 'tag_search', 'person_search', 'bio_search'];
const DEFAULT_GLOSSARY_FACET = [{ type: 'term_search', value: '' }] as Facet[];

function getLibraryFacets(q: string, viewMode: ViewMode): Facet[] {
    if (!q) return [];
    const whitelist = viewMode === 'glossary'
        ? ['term_search', 'definition_search']
        : viewMode === 'biography'
            ? ['person_search', 'bio_search']
            : ['tag_search', 'term_search', 'video', 'handle'];

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
            : ['tag_search', 'term_search', 'video', 'handle'];

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
    const [notification, setNotification] = useState<{ message: string; type: NotificationType } | null>(null);
    const [showScrollTop, setShowScrollTop] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [videoListMode, setVideoListMode] = useState<'grid' | 'compact'>('grid');
    const [navigationOrientation, setNavigationOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
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
    const [linkedTerm, setLinkedTerm] = useState<{ term: string; definition: string } | null>(null);

    // ── Hooks ────────────────────────────────────────────────────────────────
    const search = useSearch(hasApiKey);

    const effectivePluginSummarizeEnabled = pluginSummarizeEnabled && (showSummarizeOllama || showSummarizeVenice);
    const effectivePluginPhotosynthesisEnabled = pluginPhotosynthesisEnabled && (showSynthesizeVenice || showSynthesizePixabay || showSynthesizeUpload);

    const library = useLibrary(
        effectivePluginSummarizeEnabled,
        search.filteredVideos,
        setNotification,
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
    useEffect(() => {
        if (!showDrive || !allowEditWDBS) {
            // Bulk Assign Mode's toggle button disappears when editing is disabled: exit the mode
            // too so the grid doesn't stay stuck in bulk-select with no visible way out.
            setBulkAssignMode(false);
            setBulkSelectedIds(new Set());
            setBulkAssignMenu(null);
        }
    }, [showDrive, allowEditWDBS]);

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
    useEffect(() => {
        const onScroll = () => setShowScrollTop(window.scrollY > 400);
        window.addEventListener("scroll", onScroll);
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

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
            libraryScrollYRef.current = window.scrollY;
        } else if (viewMode === 'library' && cameFrom !== 'library') {
            requestAnimationFrame(() => window.scrollTo({ top: libraryScrollYRef.current }));
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
    const goToLibraryDrive = useCallback((storagePath: string, label: string) => {
        setBulkAssignMode(false);
        setBulkSelectedIds(new Set());
        setBulkAssignMenu(null);
        setSidebarOpen(false);
        setViewMode('library');
        library.setLibrarySearch('');
        library.setWdbsFilter(storagePath);
        setDriveFilterLabel(label);
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
                    const found = (await getGlossaryTerms()).find(([term]) => term === key);
                    if (!found || !found[1].trim()) return say(`"${key}" is no longer in the glossary.`);
                    setSelectedBiography(null);
                    setLinkedTerm({ term: found[0], definition: found[1] });
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
    }, [flags.showGlossary, flags.showBiography, flags.showDrive, handleSelectVideo, goToLibraryDrive]);

    useEffect(() => setInternalLinkHandler(handleOpenLink), [handleOpenLink]);

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

    const handleBulkAssign = useCallback(async (wdbs: string) => {
        if (!bulkAssignMenu) return;
        setBulkAssigning(true);
        setBulkAssignError(null);
        try {
            const result = await bulkUpdateVideoWdbs(bulkAssignMenu.videoIds, wdbs);
            const label = wdbs.trim() || "unassigned";
            if (result.failed.length === 0) {
                setNotification({ message: `Assigned ${result.succeeded.length} video${result.succeeded.length === 1 ? '' : 's'} to ${label}.`, type: "success" });
                setBulkSelectedIds(new Set());
                setBulkAssignMenu(null);
            } else if (result.succeeded.length === 0) {
                setBulkAssignError(result.failed[0][1]);
            } else {
                setNotification({ message: `Assigned ${result.succeeded.length} video${result.succeeded.length === 1 ? '' : 's'} to ${label}; ${result.failed.length} failed.`, type: "info" });
                setBulkSelectedIds(new Set());
                setBulkAssignMenu(null);
            }
            library.refreshLibrary();
            setDriveVersion(v => v + 1);
        } catch (e: any) {
            setBulkAssignError(typeof e === "string" ? e : e?.message ?? "Bulk assign failed.");
        } finally {
            setBulkAssigning(false);
        }
    }, [bulkAssignMenu, library, setNotification]);

    // "No videos are tagged under X yet" is only true when the category itself is being shown
    // unfiltered — with a search or filter (transcript/summary) active, the category can easily
    // be non-empty while still returning zero results for that combination, so the message needs
    // to say that instead of implying the category has nothing in it.
    const libraryEmptyMessage = library.wdbsFilter
        ? (library.librarySearch.trim() || library.filterKind !== 'all'
            ? `Nothing in "${driveFilterLabel}" matches the current search/filter.`
            : `No videos are tagged under "${driveFilterLabel}" yet.`)
        : (library.librarySearch.trim() ? "Try different search terms" : "Find videos and save their transcripts here.");

    return (
        <div className="min-h-screen bg-[#0f0f0f] text-white font-sans selection:bg-red-500/30 selection:text-white pb-20 select-none">
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
                                {videoListMode === 'grid' ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
                            </button>
                        )}
                        {flags.settingsVisible && (
                            <button
                                onClick={() => setShowSettings(true)}
                                className="p-2 text-gray-400 hover:text-white transition-all cursor-pointer rounded-lg hover:bg-[#272727]"
                                title="Settings"
                            >
                                <Settings className="w-5 h-5" />
                            </button>
                        )}
                    </div>

                    {/* A direct child of the rail (not of the icon group above), so it spans the rail's full
                        width and sits flush with the bottom of the window, without their padding. */}
                    <WorkspaceSwitcher variant="rail" />
                </div>
            )}

            <div className={`${navigationOrientation === 'vertical' ? 'ml-16' : ''} px-4 pt-4`}>
                <header className="mb-4 relative z-40 transition-all">
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
                                <div className="flex flex-col">
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
                                        {videoListMode === 'grid' ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
                                    </button>
                                )}
                                {flags.settingsVisible && (
                                    <button
                                        onClick={() => setShowSettings(true)}
                                        className="p-2 ml-1 text-gray-400 hover:text-white transition-all cursor-pointer"
                                        title="Settings"
                                    >
                                        <Settings className="w-5 h-5" />
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
                                className={`shrink-0 p-2.5 mb-4 rounded-lg border transition-all cursor-pointer ${showDrivePanel ? 'bg-red-600 border-red-600 text-white' : 'bg-[#121212] border-[#404040] text-gray-400 hover:text-white hover:border-[#505050]'}`}
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
                {viewMode === 'search' && search.error && (
                    <div className="mt-8 text-center animate-in fade-in duration-300">
                        <div className="text-red-500 font-medium bg-red-900/10 px-6 py-3 rounded-lg border border-red-600/20 inline-block mx-auto text-sm">
                            {search.error}
                        </div>
                    </div>
                )}

                <div className="mt-8">
                     {viewMode === 'glossary' ? (
                         <GlossaryView
                             searchQuery={glossarySearchQuery}
                             onSearchInLibrary={handleSearchInLibrary}
                             allowModification={allowModificationGlossary}
                         />
                     ) : viewMode === 'biography' ? (
                          <BiographyView searchQuery={biographySearchQuery} onVideoSelect={handleSelectVideo} onViewMore={(handle) => goToLibrarySearch(`handle:${handle.replace('@', '')}`)} onDriveSelect={showDrive ? goToLibraryDrive : undefined} allowEditBio={allowEditBio} />
                     ) : viewMode === 'search' ? (
                        <>
                            <VideoList
                                videos={displayedVideos}
                                onSelect={handleSelectVideo}
                                onSelectWithTab={handleSelectVideo}
                                onSaveAll={flags.saveAllAllowed && displayedVideos.length > 0 ? library.handleSaveAll : undefined}
                                saveProgress={library.saveProgress}
                                compact={videoListMode === 'compact'}
                            />
                            {search.continuationToken && !search.isSearch && (
                                <div className="mt-16 text-center flex justify-center gap-4">
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
                    ) : (
                        <div className="animate-in fade-in slide-in-from-bottom-2 duration-400 flex flex-col lg:flex-row gap-6">
                            {showDrivePanel && showDrive && (
                                <div className="lg:w-80 shrink-0">
                                    <WdbsTreePanel
                                        selectedPath={library.wdbsFilter ?? undefined}
                                        onSelect={(path, label) => {
                                            library.setWdbsFilter(path);
                                            setDriveFilterLabel(label);
                                        }}
                                        refreshKey={driveVersion}
                                        allowEditAlias={allowEditWDBS}
                                        clearNavRail={navigationOrientation === 'vertical'}
                                    />
                                    {allowEditWDBS && (
                                        <button
                                            onClick={() => setBulkAssignMode(prev => {
                                                const next = !prev;
                                                if (!next) setBulkSelectedIds(new Set());
                                                return next;
                                            })}
                                            className={`mt-3 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-xs font-bold transition-all cursor-pointer ${bulkAssignMode ? 'bg-red-600 border-red-600 text-white' : 'bg-[#121212] border-[#404040] text-gray-400 hover:text-white hover:border-[#505050]'}`}
                                            title={`Select videos, then right-click to assign them to a ${labels.aliasDriveName} category`}
                                        >
                                            <MousePointerClick className="w-3.5 h-3.5" />
                                            {bulkAssignMode ? `Bulk Assign Mode (${bulkSelectedIds.size} selected)` : "Bulk Assign Mode"}
                                        </button>
                                    )}
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
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
                                />
                            </div>
                        </div>
                    )}

                    {bulkAssignMenu && (
                        <BulkAssignMenu
                            x={bulkAssignMenu.x}
                            y={bulkAssignMenu.y}
                            count={bulkAssignMenu.videoIds.length}
                            onAssign={handleBulkAssign}
                            onClose={() => { setBulkAssignMenu(null); setBulkAssignError(null); }}
                            assigning={bulkAssigning}
                            error={bulkAssignError}
                        />
                    )}
                </div>
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
                onVideoSelect={handleSelectVideo}
            />

            <SettingsModal
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

            {notification && (
                <Notification
                    message={notification.message}
                    type={notification.type}
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
                />
            )}

            <LinkPicker />
            <MarkdownContextMenu />

            {library.confirmDelete && (
                <ConfirmDialog
                    message={`Are you sure you want to delete "${library.confirmDelete.video.title}"?`}
                    onConfirm={async () => {
                        await library.confirmDeleteAction(() => { setSidebarOpen(false); setSelectedVideo(null); });
                        // The Drive tree's per-category video counts (and any category that just
                        // emptied) are computed server-side, so re-fetch instead of leaving them stale.
                        setDriveVersion(v => v + 1);
                    }}
                    onCancel={() => library.setConfirmDelete(null)}
                />
            )}

            <button
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                className={`fixed bottom-12 right-6 p-3 bg-red-600 hover:bg-red-500 text-white rounded-full shadow-lg transition-opacity duration-200 cursor-pointer z-39 active:scale-95 ${showScrollTop ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                title="Back to Top"
            >
                <ChevronUp className="w-6 h-6" style={{ color: '#ffffff' }} />
            </button>

            {viewMode === 'library' && effectivePluginSummarizeEnabled && showSummarizeButton && flags.allowSummarizeAll && !sidebarOpen && (
                <button
                    onClick={library.handleSummarizeAll}
                    disabled={!!library.summarizeProgress}
                    className={`fixed bottom-12 left-20 summarize-btn px-4 py-2.5 bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-500 hover:to-blue-500 rounded-lg text-sm font-bold transition-all shadow-lg hover:shadow-purple-500/25 disabled:opacity-50 flex items-center gap-2 z-40 ${!library.summarizeProgress ? 'cursor-pointer' : 'cursor-default'}`}
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
