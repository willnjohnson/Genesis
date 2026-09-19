import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface Video {
    id: string;
    title: string;
    thumbnail: string;
    author?: string;
    description?: string;
    duration?: string;
    views?: string;
    publishedTime?: string;
    viewCount: string;
    publishedAt: string;
    dateAdded?: string;
    handle?: string;
    status?: string;
    transcript?: string;
    summary?: string;
    tags?: string;
    hasTranscript?: boolean;
    hasSummary?: boolean;
    lengthSeconds?: number;
    // Warp Drive taxonomy designator, in storage encoding (e.g. "θψUAP_GERB_PND") — empty/absent
    // means unassigned ("Universe"). See updateVideoWdbs for the user-facing ":UAP-GERB-PND" form.
    wdbs?: string;
}

export interface SearchResponse {
    videos: Video[];
    continuation: string | null;
    totalCount?: number;
}

export type LibrarySortField = 'date' | 'added' | 'popularity';
export type LibrarySortOrder = 'asc' | 'desc';
export type LibraryFilterKind = 'all' | 'transcript' | 'summary';

export interface LibraryQueryOptions {
    filterKind?: LibraryFilterKind;
    sortField?: LibrarySortField;
    sortOrder?: LibrarySortOrder;
    limit?: number;
    offset?: number;
}

export interface DbDetails {
    path: string;
    size_bytes: number;
    video_count: number;
    history_count: number;
    channel_count: number;
    /** Every Drive entry at any depth. */
    drive_count: number;
    /** Standard Glossary Tags (with a definition). */
    glossary_count: number;
    quick_tag_count: number;
    biography_count: number;
    attachment_count: number;
    /** What attachments take up in the database, after compression. */
    attachment_bytes: number;
}

export interface DisplaySettings {
    resolution: string;
    fullscreen: boolean;
    theme: string;
    videoListMode: 'grid' | 'compact';
    navigationOrientation: 'horizontal' | 'vertical';
}

export interface HistoryEntry {
    id: number;
    search_query: string;
    searchedAt: string;
}

export interface ChannelInfo {
    channelId: string;
    channelName: string;
}

export async function getVideos(id: string, isPlaylist: boolean, continuation?: string | null): Promise<SearchResponse> {
    return await invoke("fetch_videos", { id, isPlaylist, continuation });
}

export async function getTranscript(id: string): Promise<string> {
    return await invoke("fetch_transcript", { videoId: id });
}

export async function getVideoHandle(id: string): Promise<string | null> {
    return await invoke("fetch_video_handle", { videoId: id });
}

export async function summarizeTranscript(transcript: string, handle?: string, videoId?: string): Promise<string> {
    return await invoke("summarize_transcript", { transcript, handle: handle ?? null, videoId: videoId ?? null });
}

export async function getVideoInfo(id: string): Promise<Video> {
    return await invoke("fetch_video_info", { videoId: id });
}

export async function saveVideo(video: Video, transcript: string, summary?: string | null): Promise<Video> {
    // Pass along what was already successfully fetched for this video (search results +
    // the transcript/handle fetched when it was opened) so the backend can save directly
    // instead of redundantly re-fetching from YouTube, which is flaky under some network/VPN
    // conditions even though nothing here actually needs re-fetching.
    return await invoke("save_video", {
        videoId: video.id,
        summary,
        title: video.title,
        author: video.author,
        handle: video.handle,
        thumbnail: video.thumbnail,
        lengthSeconds: video.lengthSeconds,
        viewCount: video.viewCount,
        publishedAt: video.publishedAt,
        transcript,
    });
}

export async function searchVideos(query: string, continuation?: string | null): Promise<SearchResponse> {
    return await invoke("search_videos", { query, continuation });
}

export async function getSavedVideos(includeContent?: boolean, opts?: LibraryQueryOptions): Promise<SearchResponse> {
    return await invoke("fetch_saved_videos", {
        includeContent,
        filterKind: opts?.filterKind,
        sortField: opts?.sortField,
        sortOrder: opts?.sortOrder,
        limit: opts?.limit,
        offset: opts?.offset,
    });
}

export async function searchLibrary(query: string, opts?: LibraryQueryOptions): Promise<SearchResponse> {
    return await invoke("search_library", {
        query,
        filterKind: opts?.filterKind,
        sortField: opts?.sortField,
        sortOrder: opts?.sortOrder,
        limit: opts?.limit,
        offset: opts?.offset,
    });
}

export async function deleteVideo(id: string): Promise<void> {
    await invoke("delete_video", { videoId: id });
}

export async function bulkSaveVideos(ids: string[]): Promise<any[]> {
    return await invoke("bulk_save_videos", { videoIds: ids });
}

export async function fetchChannelVideosV3(handle: string, continuationToken?: string | null): Promise<SearchResponse> {
    return await invoke("fetch_channel_videos_v3", { query: handle, continuation: continuationToken ?? null });
}

export async function getApiKey(): Promise<string | null> {
    return await invoke("get_api_key");
}

export async function setApiKey(key: string): Promise<void> {
    await invoke("set_api_key", { apiKey: key });
}

export async function removeApiKey(): Promise<void> {
    await invoke("remove_api_key");
}

export async function openDbLocation(): Promise<void> {
    await invoke("open_db_location");
}

export async function getDbDetails(): Promise<DbDetails> {
    return await invoke("get_db_details");
}

export async function getDisplaySettings(): Promise<DisplaySettings> {
    return await invoke("get_display_settings");
}

export async function setDisplaySettings(settings: DisplaySettings): Promise<void> {
    await invoke("set_display_settings", { settings });
}

export async function getSearchHistory(limit: number): Promise<HistoryEntry[]> {
    return await invoke("get_search_history", { limit });
}

export async function addSearchHistory(query: string): Promise<void> {
    await invoke("add_search_history", { query });
}

export async function clearHistoryBeforeDate(date: string): Promise<void> {
    await invoke("clear_history_before_date", { date });
}

export async function deleteHistoryEntry(id: number): Promise<void> {
    await invoke("delete_history_entry", { id });
}

export async function clearAllHistory(): Promise<void> {
    await invoke("clear_all_history");
}

/** One saved video (with its summary and transcript), or null when it isn't in this library. */
export async function getVideoById(videoId: string): Promise<Video | null> {
    return await invoke("get_video_by_id", { videoId });
}

export async function checkVideoExists(id: string): Promise<boolean> {
    return await invoke("check_video_exists", { videoId: id });
}

export async function getSimilarVideos(videoId: string, limit?: number): Promise<Video[]> {
    return await invoke("get_similar_videos", { videoId, limit: limit ?? null });
}

export async function resolveChannel(query: string): Promise<ChannelInfo> {
    return await invoke("resolve_channel", { query });
}

export async function fetchViewCount(videoId: string): Promise<string> {
    return await invoke("fetch_view_count", { videoId });
}

export async function getSetting(key: string): Promise<string | null> {
    return await invoke("get_setting", { key });
}

/** Several settings in one call (the sync server's enforced values applied); missing keys are null. */
export async function getSettings(keys: string[]): Promise<Record<string, string | null>> {
    return await invoke("get_settings", { keys });
}

export async function setSetting(key: string, value: string): Promise<void> {
    await invoke("set_setting", { key, value });
}

/** Every customizable name (workspace name and aliases) with defaults filled in. */
export async function getWorkspaceLabels(): Promise<Record<string, string>> {
    return await invoke("get_workspace_labels");
}

/** Sets one name; an empty value resets it. Resolves to the value now in effect, rejects with a readable message. */
export async function setWorkspaceLabel(key: string, value: string): Promise<string> {
    return await invoke("set_workspace_label", { key, value });
}

export async function getOllamaModel(): Promise<string> {
    return await invoke("get_ollama_model");
}

export async function setOllamaModel(model: string): Promise<void> {
    await invoke("set_ollama_model", { model });
}

export async function getOllamaPrompt(): Promise<string> {
    return await invoke("get_ollama_prompt");
}

export async function setOllamaPrompt(prompt: string): Promise<void> {
    await invoke("set_ollama_prompt", { prompt });
}

export async function checkOllama(): Promise<boolean> {
    return await invoke("check_ollama");
}

export async function checkModelPulled(): Promise<boolean> {
    return await invoke("check_model_pulled");
}

export async function pullModel(): Promise<void> {
    await invoke("pull_model");
}

export async function deleteModel(): Promise<void> {
    await invoke("delete_model");
}

export async function installOllama(): Promise<void> {
    await invoke("install_ollama");
}

export async function saveSummary(videoId: string, summary: string): Promise<void> {
    await invoke("save_summary", { videoId, summary });
}

export async function saveTags(videoId: string, tags: string): Promise<void> {
    await invoke("save_tags", { videoId, tags });
}

export async function saveTranscript(videoId: string, transcript: string): Promise<void> {
    await invoke("save_transcript", { videoId, transcript });
}

export async function getSummary(videoId: string): Promise<string | null> {
    return await invoke("get_summary", { videoId });
}

export async function getSummarizedCount(): Promise<number> {
    return await invoke("get_summarized_count");
}

export async function getVideosWithSummaries(): Promise<string[]> {
    return await invoke("get_videos_with_summaries");
}

export async function summarizeAllVideos(): Promise<number> {
    return await invoke("summarize_all_videos");
}

export async function getVeniceApiKey(): Promise<string | null> {
    return await invoke("get_venice_api_key");
}

export async function setVeniceApiKey(key: string): Promise<void> {
    await invoke("set_venice_api_key", { apiKey: key });
}

export async function removeVeniceApiKey(): Promise<void> {
    await invoke("remove_venice_api_key");
}

export async function getVenicePrompt(): Promise<string> {
    return await invoke("get_venice_prompt");
}

export async function setVenicePrompt(prompt: string): Promise<void> {
    await invoke("set_venice_prompt", { prompt });
}

/** Opens a folder picker (at `startDir` when given and it still exists). */
export async function selectFolder(startDir?: string | null): Promise<string | null> {
    return await invoke("select_folder", { startDir: startDir ?? null });
}

export async function setDbPath(path: string): Promise<string> {
    return await invoke("set_db_path_override", { folderPath: path });
}

export interface ExportSummary {
    videos_exported: number;
    glossary_terms: number;
    biographies: number;
    folder_path: string;
}

/** Exports the library as an Obsidian vault into `vaultPath`, a NEW folder: if that name is already
 *  taken the export writes to "name (2)" etc. instead. The summary's `folder_path` is where it went. */
export async function exportToObsidian(vaultPath: string): Promise<ExportSummary> {
    return await invoke("export_to_obsidian", { vaultPath });
}

/** Save As dialog whose chosen name is the vault folder itself; null if cancelled. */
export async function selectVaultPath(defaultName: string, startDir?: string | null): Promise<string | null> {
    return await invoke("select_vault_path", { defaultName, startDir: startDir ?? null });
}

export interface AppInfo {
    name: string;
    version: string;
}

export async function getAppInfo(): Promise<AppInfo> {
    return await invoke("get_app_info");
}

export async function getEmbedServerPort(): Promise<number | null> {
    return await invoke("get_embed_server_port");
}

export interface GlossaryTerm {
    term: string;
    definition: string;
}

export interface BiographyEntry {
    handle: string;
    displayName: string;
    bio: string;
    wikipedia: string;
    website: string;
    twitter: string;
    instagram: string;
    facebook: string;
    threads: string;
    youtube: string;
    tiktok: string;
    twitch: string;
    reddit: string;
    discord: string;
}
export async function addGlossaryTerm(term: string, definition: string): Promise<void> {
    await invoke("add_glossary_term", { term, definition });
}

export async function getGlossaryTerms(): Promise<[string, string][]> {
    return await invoke("get_glossary_terms");
}

export async function deleteGlossaryTerm(term: string): Promise<void> {
    await invoke("delete_glossary_term", { term });
}

/** A top-level Drive (level 1) a Standard Glossary Tag can be filed under. */
export interface WdbsRoot {
    /** Display path, e.g. ":CRYPTO" (what assignments are stored as). */
    path: string;
    /** The bare name shown in the UI, e.g. "CRYPTO". */
    segment: string;
    /** The curated alias, when it differs from `segment`. */
    alias: string | null;
}

/** Adds or edits a term and the top-level Drives it's filed under, in one step. `originalTerm` is
 *  the term's current name when editing (a different `term` renames it). Quick Tags (empty
 *  definition) never keep drives. */
export async function saveGlossaryTerm(originalTerm: string | null, term: string, definition: string, drives: string[]): Promise<void> {
    await invoke("save_glossary_term", { originalTerm, term, definition, drives });
}

/** Every (term, drive root) assignment, e.g. ["Halving", ":CRYPTO"]. */
export async function getGlossaryDriveLinks(): Promise<[string, string][]> {
    return await invoke("get_glossary_drive_links");
}

export async function getWdbsRoots(): Promise<WdbsRoot[]> {
    return await invoke("get_wdbs_roots");
}

/** A Drive that some of a channel's saved videos are filed under. */
export interface HandleDrive {
    /** Storage form, e.g. "θψCRYPTO_DOAC". */
    path: string;
    /** Display form, e.g. ":CRYPTO-DOAC". */
    display: string;
    /** The Drive's curated alias, when it has one that differs from its name. */
    alias: string | null;
    /** How many of the channel's videos are in it. */
    count: number;
}

/** One file attached to a video. Sizes are in bytes. */
export interface AttachmentInfo {
    id: number;
    name: string;
    ext: string;
    /** The original file's size. */
    size: number;
    /** What the database actually holds (smaller when the file was compressed). */
    storedSize: number;
    addedAt: string;
}

export interface VideoAttachments {
    note: string;
    attachments: AttachmentInfo[];
}

/** What happened to one file in `addAttachments`: it was added, or `error` says why not. */
export interface AddAttachmentOutcome {
    name: string;
    attachment: AttachmentInfo | null;
    error: string | null;
}

export async function getVideoAttachments(videoId: string): Promise<VideoAttachments> {
    return await invoke("get_video_attachments", { videoId });
}

export async function saveVideoNote(videoId: string, note: string): Promise<void> {
    await invoke("save_video_note", { videoId, note });
}

/** Native multi-file picker limited to the supported types. Empty when cancelled. */
export async function pickAttachmentFiles(): Promise<string[]> {
    return await invoke("pick_attachment_files");
}

/** Stores the files at `paths` (read by the backend) on the video, reporting each one's result. */
export async function addAttachments(videoId: string, paths: string[]): Promise<AddAttachmentOutcome[]> {
    return await invoke("add_attachments", { videoId, paths });
}

export async function removeAttachment(id: number): Promise<void> {
    await invoke("remove_attachment", { id });
}

/** Opens the attachment in the system's default app. */
export async function openAttachment(id: number): Promise<void> {
    await invoke("open_attachment", { id });
}

/** Save As dialog; false when the user cancels. */
export async function saveAttachmentAs(id: number): Promise<boolean> {
    return await invoke("save_attachment_as", { id });
}

/** Curated aliases for the given Drive paths (storage form), keyed by path. Drives without an alias are left out. */
export async function getWdbsAliases(paths: string[]): Promise<Record<string, string>> {
    return await invoke("get_wdbs_aliases", { paths });
}

/** Every Drive a channel's saved videos appear in (its category or an "Also in" link). */
export async function getHandleDrives(handle: string): Promise<HandleDrive[]> {
    return await invoke("get_handle_drives", { handle });
}

type RawBiographyEntry = {
    handle: string;
    display_name: string;
    bio: string;
    wikipedia: string;
    website: string;
    twitter: string;
    instagram: string;
    facebook: string;
    threads: string;
    youtube: string;
    tiktok: string;
    twitch: string;
    reddit: string;
    discord: string;
};

const mapBiography = (entry: RawBiographyEntry): BiographyEntry => ({
    handle: entry.handle,
    displayName: entry.display_name,
    bio: entry.bio,
    wikipedia: entry.wikipedia,
    website: entry.website,
    twitter: entry.twitter,
    instagram: entry.instagram,
    facebook: entry.facebook,
    threads: entry.threads,
    youtube: entry.youtube,
    tiktok: entry.tiktok,
    twitch: entry.twitch,
    reddit: entry.reddit,
    discord: entry.discord,
});

export async function getBiographies(): Promise<BiographyEntry[]> {
    const rows = await invoke("get_biographies") as RawBiographyEntry[];
    return rows.map(mapBiography);
}

export async function getBiography(handle: string): Promise<BiographyEntry | null> {
    const row = await invoke("get_biography", { handle }) as RawBiographyEntry | null;
    return row ? mapBiography(row) : null;
}

export async function updateBiography(entry: BiographyEntry): Promise<void> {
    await invoke("update_biography", {
        handle: entry.handle,
        bio: entry.bio,
        wikipedia: entry.wikipedia,
        website: entry.website,
        twitter: entry.twitter,
        instagram: entry.instagram,
        facebook: entry.facebook,
        threads: entry.threads,
        youtube: entry.youtube,
        tiktok: entry.tiktok,
        twitch: entry.twitch,
        reddit: entry.reddit,
        discord: entry.discord,
    });
}

export async function openExternalUrl(url: string): Promise<void> {
    await openUrl(url);
}

export interface CustomPrompt {
    handle: string;
    localPromptText: string | null;
    cloudPromptText: string | null;
}

export async function getCustomPrompt(handle: string): Promise<[string | null, string | null]> {
    return await invoke("get_custom_prompt", { handle });
}

export async function getAllCustomPrompts(): Promise<CustomPrompt[]> {
    const prompts = await invoke("get_all_custom_prompts") as [string, string | null, string | null][];
    return prompts.map(([handle, localPromptText, cloudPromptText]) => ({
        handle,
        localPromptText,
        cloudPromptText,
    }));
}

export async function setCustomPrompt(handle: string, localPromptText: string | null, cloudPromptText: string | null): Promise<void> {
    await invoke("set_custom_prompt", { handle, localPromptText, cloudPromptText });
}

export async function deleteCustomPrompt(handle: string): Promise<void> {
    await invoke("delete_custom_prompt", { handle });
}

export async function getUniqueHandles(): Promise<string[]> {
    return await invoke("get_unique_handles");
}

/// Converts a video's stored WDBS value (storage encoding, e.g. "θψUAP_GERB_PND") into the
/// human-facing Warp Drive designator form (":UAP-GERB-PND") for display in an edit control.
/// Mirrors the encoding update_wdbs applies in reverse; returns '' for unassigned ("Universe").
export function decodeWdbs(stored: string | undefined | null): string {
    if (!stored || !stored.startsWith('θψ')) return '';
    const body = stored.slice(2);
    // A bare "θψ" with nothing after it (e.g. a production default-population trigger's
    // "no specific drive yet" sentinel) has no real designator to show — without this check
    // it would decode to a bare ":", which passed the caller's `|| "N/A"` fallback because ":"
    // is a non-empty, truthy string.
    if (!body) return '';
    return ':' + body.replace(/_/g, '-');
}

/// The inverse of decodeWdbs — mirrors the ':' -> 'θψ' / '-' -> '_' transform update_wdbs applies
/// server-side, so a caller that just successfully saved a display-format value (e.g.
/// Sidebar.tsx's handleSaveWdbs) can optimistically update local state without waiting on a
/// refetch. Returns '' for a blank/cleared input.
export function encodeWdbs(display: string): string {
    const trimmed = display.trim();
    if (!trimmed.startsWith(':') || trimmed.length < 2) return '';
    // Uppercased to mirror what commands::wdbs::encode_wdbs_display stores server-side, so this
    // optimistic local update matches what a refetch would actually return.
    return 'θψ' + trimmed.slice(1).toUpperCase().replace(/-/g, '_');
}

// Updates a video's canonical Warp Drive (the one shown by decodeWdbs(video.wdbs)), or clears it
// back to unassigned ("N/A") when `wdbs` is empty. To have the video additionally show up under
// OTHER Warp Drives without changing this one, see add/removeVideoWdbsLink below.
export async function updateVideoWdbs(videoId: string, wdbs: string): Promise<void> {
    await invoke("update_wdbs", { videoId, wdbs });
}

// One node of the Warp Drive taxonomy tree (see components/WdbsTreePanel.tsx). `path` is the
// storage-encoded prefix to pass to getVideosByWdbs; `count` includes every distinct video at
// this node and everywhere beneath it (canonical assignment or symlink — see
// add/removeVideoWdbsLink). There is deliberately no "Universe"/unassigned node — that's what
// the Library/Portal grid is already for.
export interface WdbsNode {
    segment: string;
    path: string;
    count: number;
    children: WdbsNode[];
    // The node's curated display alias (tblWDBS.WDInfo), when one's been set and differs from
    // `segment` — null both when nothing's been curated and when the database doesn't have the
    // production tblWDBS schema at all. See setWdbsAlias.
    alias: string | null;
    // The node's curated icon (tblWDBS.WDIcon) — one of WDBS_ICON_KEYS, or null when unset/
    // unrecognized/no tblWDBS. See setWdbsIcon.
    icon: string | null;
}

// The fixed set of icons a Warp Drive taxonomy node's WDIcon can hold — must match the Rust side's
// db::WDBS_ICONS exactly (that's what commands::wdbs::set_wdbs_icon validates against). Order here
// is just the order they're offered in WdbsIconMenu's picker.
export const WDBS_ICON_KEYS = [
    "star", "company", "person", "music", "sports", "gaming", "podcast", "fitness", "food",
    "news", "education", "comedy", "tech", "finance", "guides",
    "health", "privacy", "repair", "coding", "art", "reading", "project", "ai",
] as const;
export type WdbsIconKey = typeof WDBS_ICON_KEYS[number];

export async function getWdbsTree(): Promise<WdbsNode[]> {
    return await invoke("get_wdbs_tree");
}

// Sets (or clears, given '') the curated display alias for one Warp Drive taxonomy node — shown
// as a tooltip/detail alongside its raw segment name (see components/WdbsTreePanel.tsx's "Edit
// Alias" context menu). `path` is a WdbsNode.path value. A no-op against a database without the
// production tblWDBS schema.
export async function setWdbsAlias(path: string, alias: string): Promise<void> {
    await invoke("set_wdbs_alias", { path, alias });
}

// Sets (or clears, given '') the curated icon for one Warp Drive taxonomy node — shown to the left
// of its segment name in the tree (see components/WdbsTreePanel.tsx's "Edit Icon" context menu).
// `path` is a WdbsNode.path value; `icon` must be one of WDBS_ICON_KEYS or ''. A no-op against a
// database without the production tblWDBS schema.
export async function setWdbsIcon(path: string, icon: string): Promise<void> {
    await invoke("set_wdbs_icon", { path, icon });
}

// `wdbsPath` is a WdbsNode.path value (or any encoded prefix) — selects that category and
// everything nested beneath it.
// `query` narrows the category's videos via the same FTS5 search the Library/Portal grid's own
// search box uses, just scoped to this category instead of the whole library — pass '' for none.
export async function getVideosByWdbs(wdbsPath: string, query: string, opts?: LibraryQueryOptions): Promise<SearchResponse> {
    return await invoke("fetch_videos_by_wdbs", {
        wdbsPrefix: wdbsPath,
        query,
        filterKind: opts?.filterKind,
        sortField: opts?.sortField,
        sortOrder: opts?.sortOrder,
        limit: opts?.limit,
        offset: opts?.offset,
    });
}

// Every Warp Drive path currently assigned to at least one video (storage-encoded) — decode with
// decodeWdbs() before showing as autocomplete suggestions in a Warp Drive editor.
export async function getWdbsSuggestions(): Promise<string[]> {
    return await invoke("get_wdbs_suggestions");
}

// A video's current canonical Warp Drive (WDBS), storage-encoded — null if unassigned or if the
// video isn't saved locally. A Video object opened from Search comes straight from the YouTube
// API and never carries its own `wdbs` field, even if that video is already saved with one, so
// Sidebar.tsx looks this up once it confirms the video exists in the database.
export async function getVideoWdbs(videoId: string): Promise<string | null> {
    return await invoke("get_video_wdbs", { videoId });
}

// A video's symlinked (non-canonical) Warp Drives, storage-encoded.
export async function getVideoWdbsLinks(videoId: string): Promise<string[]> {
    return await invoke("get_video_wdbs_links", { videoId });
}

// Links a video to an additional Warp Drive (":UAP-GERB-VVV" display format) without touching
// its canonical one. Resolves to the storage-encoded value that was added.
export async function addVideoWdbsLink(videoId: string, wdbs: string): Promise<string> {
    return await invoke("add_video_wdbs_link", { videoId, wdbs });
}

// `wdbs` must be the storage-encoded value (as returned by addVideoWdbsLink/getVideoWdbsLinks),
// not the ":..." display form.
export async function removeVideoWdbsLink(videoId: string, wdbs: string): Promise<void> {
    await invoke("remove_video_wdbs_link", { videoId, wdbs });
}

export interface BulkWdbsResult {
    succeeded: string[];
    // [videoId, errorMessage] pairs — one bad video can't abort the whole batch, so a partial
    // result is reported instead of an all-or-nothing failure.
    failed: [string, string][];
}

// Assigns every video in `videoIds` to `wdbs` (display format, ":UAP-GERB-VVV") in one round
// trip, or clears them all back to unassigned when `wdbs` is empty — see App.tsx's Bulk Assign
// Mode in the Library/Portal grid.
export async function bulkUpdateVideoWdbs(videoIds: string[], wdbs: string): Promise<BulkWdbsResult> {
    return await invoke("bulk_update_wdbs", { videoIds, wdbs });
}

export interface PixabayImage {
    id: number;
    url: string;
    thumbnail: string;
    width: number;
    height: number;
    tags: string;
}

export async function searchPixabay(query: string): Promise<PixabayImage[]> {
    return await invoke("search_pixabay", { query });
}

export async function uploadToImgur(imageUrl: string): Promise<string> {
    return await invoke("upload_to_imgur", { imageUrl });
}

export async function getPixabayApiKey(): Promise<string | null> {
    return await invoke("get_pixabay_api_key");
}

export async function setPixabayApiKey(key: string): Promise<void> {
    await invoke("set_pixabay_api_key", { apiKey: key });
}

export async function generateImage(prompt: string): Promise<string> {
    return await invoke("generate_image", { prompt });
}

export async function fetchImageAsDataUri(url: string): Promise<string> {
    return await invoke("fetch_image_as_data_uri", { url });
}

export async function saveImage(path: string, contentsBase64: string): Promise<void> {
    await invoke("save_image", { path, contentsBase64 });
}

// ─── Sync ────────────────────────────────────────────────────────────────────

export interface SyncManifest {
    server_name: string;
    protocol_version: number;
    min_client_version: string;
    pack_version: number;
    revision: number;
    retention_revision: number;
    capabilities: { content: boolean; policy: boolean; license: string[] };
    license_mode: string;
}

export interface LicenseInfo {
    /** Providers reachable through the server's proxy: "venice", "youtube", "pixabay". */
    providers: string[];
    /** "fallback" (the user's own key wins) or "enforce" (always use the proxy). */
    mode: string;
}

export interface SyncStatus {
    connected: boolean;
    running: boolean;
    server_url: string;
    server_name: string;
    has_token: boolean;
    last_sync_at: string;
    last_error: string;
    cursor: number;
    auto_sync: boolean;
    interval_minutes: number;
    owned_counts: Record<string, number>;
    locked_settings: string[];
    license: LicenseInfo;
}

export interface SyncReport {
    full: boolean;
    cancelled: boolean;
    revision: number;
    pages: number;
    upserted: number;
    unchanged: number;
    deleted: number;
    disowned: number;
    skipped: number;
    error_count: number;
    errors: string[];
    policy_applied: number;
    policy_dropped: number;
}

export interface SyncProgress {
    phase: "connecting" | "applying" | "policy" | "done";
    message: string;
    page: number;
    upserted: number;
    deleted: number;
}

export interface SyncDisconnectResult {
    upserted: number;
    unchanged: number;
    deleted: number;
    disowned: number;
    skipped: number;
    errors: string[];
}

export interface SyncPackOptions {
    taxonomy: boolean;
    videos: boolean;
    transcripts: boolean;
    glossary: boolean;
    biographies: boolean;
    prompts: boolean;
    settings: boolean;
}

export interface SyncPackExportSummary {
    path: string;
    counts: Record<string, number>;
    settings: number;
    bytes: number;
}

export interface SyncPackImportSummary {
    pack_app: string;
    pack_generated_at: string;
    imported: number;
    skipped: number;
    error_count: number;
    errors: string[];
    settings_applied: number;
    settings_skipped: number;
    counts: Record<string, number>;
}

export async function syncTest(url: string, token: string): Promise<SyncManifest> {
    return await invoke("sync_test", { url, token });
}

export async function syncConnect(url: string, token: string): Promise<SyncManifest> {
    return await invoke("sync_connect", { url, token });
}

export async function syncRun(forceFull: boolean): Promise<SyncReport> {
    return await invoke("sync_run", { forceFull });
}

export async function syncCancel(): Promise<void> {
    await invoke("sync_cancel");
}

export async function getSyncStatus(): Promise<SyncStatus> {
    return await invoke("sync_status");
}

export async function syncSetOptions(autoSync: boolean, intervalMinutes: number): Promise<void> {
    await invoke("sync_set_options", { autoSync, intervalMinutes });
}

export async function syncDisconnect(keepData: boolean): Promise<SyncDisconnectResult> {
    return await invoke("sync_disconnect", { keepData });
}

/** Setting keys the connected sync server locks against local edits. */
export async function getLockedSettings(): Promise<string[]> {
    return await invoke("get_locked_settings");
}

export interface ProviderStatus {
    /** The user has their own key stored. */
    own_key: boolean;
    /** The connected sync server offers a license for this provider. */
    licensed: boolean;
    /** A call would work right now (own key or license). */
    available: boolean;
    /** The license, not the user's own key, is what a call would use. */
    via_license: boolean;
}

export interface KeyStatus {
    server_name: string;
    youtube: ProviderStatus;
    venice: ProviderStatus;
    pixabay: ProviderStatus;
}

/** Whether each provider is reachable, by the user's own key or by a sync-server license. */
export async function getKeyStatus(): Promise<KeyStatus> {
    return await invoke("get_key_status");
}

/** Writes the pack to `filePath` (from the Save As dialog). A `.gz` name is compressed. */
export async function exportSyncPack(filePath: string, options: SyncPackOptions): Promise<SyncPackExportSummary> {
    return await invoke("export_sync_pack", { filePath, options });
}

/** The Save As dialog for a sync pack; null if cancelled. */
export async function selectPackSavePath(defaultName: string, startDir?: string | null): Promise<string | null> {
    return await invoke("select_pack_save_path", { defaultName, startDir: startDir ?? null });
}

export async function importSyncPack(filePath: string, applySettings: boolean): Promise<SyncPackImportSummary> {
    return await invoke("import_sync_pack", { filePath, applySettings });
}

export async function selectPackFile(): Promise<string | null> {
    return await invoke("select_pack_file");
}
