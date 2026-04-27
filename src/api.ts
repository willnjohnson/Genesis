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
}

export interface SearchResponse {
    videos: Video[];
    continuation: string | null;
    totalCount?: number;
}

export interface DbDetails {
    path: string;
    size_bytes: number;
    video_count: number;
    history_count: number;
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

export async function saveVideo(id: string, summary?: string | null): Promise<Video> {
    return await invoke("save_video", { videoId: id, summary });
}

export async function searchVideos(query: string, continuation?: string | null): Promise<SearchResponse> {
    return await invoke("search_videos", { query, continuation });
}

export async function getSavedVideos(videoType?: string, includeContent?: boolean): Promise<SearchResponse> {
    return await invoke("fetch_saved_videos", { videoType, includeContent });
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

export async function checkVideoExists(id: string): Promise<boolean> {
    return await invoke("check_video_exists", { videoId: id });
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

export async function setSetting(key: string, value: string): Promise<void> {
    await invoke("set_setting", { key, value });
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

export async function selectFolder(): Promise<string | null> {
    return await invoke("select_folder");
}

export async function setDbPath(path: string): Promise<string> {
    return await invoke("set_db_path_override", { folderPath: path });
}

export interface AppInfo {
    name: string;
    version: string;
}

export async function getAppInfo(): Promise<AppInfo> {
    return await invoke("get_app_info");
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
