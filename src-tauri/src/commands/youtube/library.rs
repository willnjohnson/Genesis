use tauri::command;
use crate::{get_db_path, db, types::*};
use crate::youtube::{YouTubeClient, ClientType, decode_html};
use super::transcript::fetch_transcript_with_retries;
use super::metadata::fetch_subscriber_count;

/// Strips anything but ASCII digits before parsing — YouTube has, rarely, been observed to
/// return numeric fields (video length, view count) with stray thousands-separator commas
/// ("1,234") on malformed/incomplete fetches. Silently parsing that with `.parse::<i32>()` alone
/// would fail and fall back to 0, quietly corrupting the value; stripping non-digits first
/// recovers the real number instead. Also matters now that the production `videos` table runs in
/// SQLite STRICT mode, where inserting non-numeric text into an INTEGER column is a hard error
/// rather than a silently-coerced one.
fn sanitize_int(raw: &str) -> i32 {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<i32>().unwrap_or(0)
}

/// Falls back to -1 (a real subscriber count is never negative, so it's an unambiguous
/// "unknown/needs backfill" sentinel — see the schema handoff doc) whenever the YouTube Data API
/// doesn't return a usable subscriber count: no API key configured, the request fails, the
/// channel hides its count, or channel_id couldn't be resolved at all.
const UNKNOWN_SUBSCRIBER_COUNT: i64 = -1;

/// Seeds a biography row the first time a given handle is saved, resolving and capturing
/// YouTube's immutable channel ID and current subscriber count at that moment — both are cheap
/// to skip on every subsequent save (upsert_biography_from_video's ON CONFLICT branch never
/// touches them again anyway), so this only does the extra channel-id/subscriber-count network
/// work when the handle is genuinely new. `known_channel_id` lets a caller that already extracted
/// the channel ID from a player response (the fresh-fetch path below) skip the redundant
/// channel-page scrape that `youtube::extract_channel_id` would otherwise need to do.
async fn ensure_biography_seeded(db_path: &str, handle: &str, author: &str, known_channel_id: Option<&str>) {
    let already_exists = db::get_biography_by_handle(db_path, handle).ok().flatten().is_some();
    if already_exists {
        let _ = db::upsert_biography_from_video(db_path, handle, author, None, UNKNOWN_SUBSCRIBER_COUNT);
        return;
    }

    let channel_id = match known_channel_id {
        Some(id) if !id.trim().is_empty() => Some(id.to_string()),
        _ => crate::youtube::extract_channel_id(handle).await.ok().flatten(),
    };

    let route = crate::sync::license::route(db_path, "youtube");
    let subscriber_count = match (&channel_id, &route) {
        (Some(cid), Some(route)) => fetch_subscriber_count(route, cid).await.unwrap_or(UNKNOWN_SUBSCRIBER_COUNT),
        _ => UNKNOWN_SUBSCRIBER_COUNT,
    };

    let _ = db::upsert_biography_from_video(db_path, handle, author, channel_id.as_deref(), subscriber_count);
}

#[command]
pub async fn save_video(
    app: tauri::AppHandle,
    video_id: String,
    summary: Option<String>,
    title: Option<String>,
    author: Option<String>,
    handle: Option<String>,
    thumbnail: Option<String>,
    length_seconds: Option<i32>,
    view_count: Option<String>,
    published_at: Option<String>,
    transcript: Option<String>,
) -> Result<Video, String> {
    use crate::types::{parse_view_count, extract_handle_from_url};
    let db_path = get_db_path(&app);

    if let Ok(Some(v_data)) = db::get_video_full(&db_path, &video_id) {
        // Update summary if provided
        if let Some(ref s) = summary {
            let _ = db::save_summary(&db_path, &video_id, s);
        }

        let has_transcript = !v_data.4.trim().is_empty();
        let has_summary = db::has_real_summary(&v_data.9);
        return Ok(Video {
            id: v_data.0,
            title: v_data.1,
            thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id),
            published_at: v_data.6,
            view_count: v_data.5.to_string(),
            author: Some(v_data.2),
            handle: Some(v_data.7),
            status: Some("exists".to_string()),
            date_added: Some(v_data.8),
            length_seconds: Some(v_data.3),
            transcript: Some(v_data.4),
            summary: Some(v_data.9),
            tags: Some(v_data.10),
            has_transcript: Some(has_transcript),
            has_summary: Some(has_summary),
            wdbs: None,
        });
    }

    // The frontend already has this video's metadata + transcript from when it was first
    // opened (search results, plus the transcript/handle fetch done at select-time) — use that
    // directly instead of re-hitting YouTube. Without this, every Save click redundantly
    // re-fetched from YouTube even though nothing new needed fetching, so a single flaky
    // network/VPN hiccup on that redundant call turned one successful Save into many failed
    // retries. Falls through to a fresh fetch below only when the caller didn't supply this
    // (e.g. bulk_save_videos, which saves by id alone with no prior client-side fetch).
    if let (Some(title_val), Some(transcript_val)) = (title.as_deref(), transcript.as_deref()) {
        if !title_val.trim().is_empty() && !transcript_val.trim().is_empty() {
            // A valid, non-empty handle is required before Kinesis will save a video — YouTube
            // occasionally returns malformed/missing metadata on a fetch (rare, per the schema
            // handoff doc), and saving with a blank handle would silently orphan the video from
            // the Biography feature. Surfacing this as an error (rather than saving with handle
            // = "") forces the caller to refetch instead.
            let handle = match handle.as_deref().map(str::trim) {
                Some(h) if !h.is_empty() => h.to_string(),
                _ => return Err("YouTube did not return a valid channel handle for this video. Please refetch it and try again.".to_string()),
            };

            let author = author.unwrap_or_else(|| "Unknown".to_string());
            let length = length_seconds.unwrap_or(0);
            let view_count = view_count.as_deref().map(parse_view_count).unwrap_or(0);
            let published_at = published_at.unwrap_or_default();
            let has_summary = summary.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);

            ensure_biography_seeded(&db_path, &handle, &author, None).await;
            db::save_video(&db_path, &video_id, title_val, &author, length, transcript_val, view_count, &published_at, &handle, summary.as_deref())
                .map_err(|e| e.to_string())?;

            let date_added = {
                let conn = rusqlite::Connection::open(&db_path).ok();
                conn.and_then(|c| {
                    c.query_row("SELECT date_added FROM Videos WHERE video_id = ?", rusqlite::params![video_id], |row| row.get::<_, Option<String>>(0)).ok().flatten()
                })
            };

            return Ok(Video {
                thumbnail: thumbnail.unwrap_or_else(|| format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id)),
                id: video_id,
                title: title_val.to_string(),
                published_at,
                view_count: view_count.to_string(),
                author: Some(author),
                handle: Some(handle),
                status: Some("saved".to_string()),
                date_added,
                length_seconds: Some(length),
                transcript: Some(transcript_val.to_string()),
                summary,
                tags: None,
                has_transcript: Some(true),
                has_summary: Some(has_summary),
                wdbs: None,
            });
        }
    }

    let client_web = YouTubeClient::new(ClientType::Web);
    let player_web = client_web.player(&video_id).await?;
    let details = &player_web["videoDetails"];

    // Fail fast if YouTube returned an empty/bot-check response
    if details.is_null() || details["title"].as_str().map(|t| t.is_empty()).unwrap_or(true) {
        return Err(format!("YouTube returned incomplete data for video '{}'. It may be unavailable, private, or geo-restricted.", video_id));
    }

    let mut handle: Option<String> = None;
    // Captured alongside handle resolution since it's already sitting right here in the player
    // response — YouTube's immutable channel ID, needed for ensure_biography_seeded below so it
    // doesn't have to redundantly re-scrape the channel page to get the same value.
    let mut known_channel_id: Option<String> = None;
    if let Some(authors) = details["author"].as_array() {
        if let Some(first) = authors.first() {
            if let Some(channel_id) = first["channel_id"].as_str() {
                known_channel_id = Some(channel_id.to_string());
                handle = crate::youtube::extract_handle_from_channel_id(channel_id).await.ok().flatten();
            }
        }
    }

    let transcript = fetch_transcript_with_retries(&video_id).await?;

    let title = decode_html(details["title"].as_str().unwrap_or("Unknown"));
    let author = if let Some(authors) = details["author"].as_array() {
        decode_html(authors.first().and_then(|a| a["name"].as_str()).unwrap_or("Unknown"))
    } else {
        decode_html(details["author"].as_str().unwrap_or("Unknown"))
    };

    // Guard: reject records with placeholder/failed metadata from YouTube
    // These indicate a bot-check, geo-block, or API parse failure
    if title == "Unknown" || title.trim().is_empty() {
        return Err("Failed to fetch video metadata: title could not be retrieved from YouTube. The video may be unavailable, region-locked, or YouTube returned an unexpected response.".to_string());
    }

    for try_handle in [
        player_web["microformat"]["playerMicroformatRenderer"]["ownerProfileUrl"].as_str().and_then(extract_handle_from_url),
        details["author"].as_array().and_then(|a| a.first()).and_then(|f| f["url"].as_str()).and_then(extract_handle_from_url),
    ] {
        if handle.is_none() { handle = try_handle; }
    }

    // A valid, non-empty handle is required before Kinesis will save a video (see the fast-path
    // branch above for the full rationale) — force a refetch rather than saving one with a blank
    // handle and silently orphaning it from the Biography feature.
    let handle = match handle.as_deref().map(str::trim) {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => return Err("YouTube did not return a valid channel handle for this video. Please refetch it and try again.".to_string()),
    };

    let length = sanitize_int(details["lengthSeconds"].as_str().unwrap_or("0"));
    let view_count = parse_view_count(details["viewCount"].as_str().unwrap_or("0"));
    let published_at = player_web["microformat"]["playerMicroformatRenderer"]["publishDate"].as_str().unwrap_or("");
    let has_summary = summary
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // Upsert the biography row before saving the video so save_video's channel-info footer
    // (joined against biographies.handle) can find it on this very first save.
    ensure_biography_seeded(&db_path, &handle, &author, known_channel_id.as_deref()).await;
    db::save_video(&db_path, &video_id, &title, &author, length, &transcript, view_count, published_at, &handle, summary.as_deref())
        .map_err(|e| e.to_string())?;

    let date_added = {
        let conn = rusqlite::Connection::open(&db_path).ok();
        conn.and_then(|c| {
            c.query_row("SELECT date_added FROM Videos WHERE video_id = ?", rusqlite::params![video_id], |row| row.get::<_, Option<String>>(0)).ok().flatten()
        })
    };

    Ok(Video {
        thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id),
        id: video_id,
        title: title.to_string(),
        published_at: published_at.to_string(),
        view_count: view_count.to_string(),
        author: Some(author.to_string()),
        handle: Some(handle),
        status: Some("saved".to_string()),
        date_added,
        length_seconds: Some(length),
        transcript: Some(transcript),
        summary: summary,
        tags: None,
        has_transcript: Some(true),
        has_summary: Some(has_summary),
        wdbs: None,
    })
}

// Hard cap on Library page size, independent of whatever the frontend asks for — keeps a rogue
// or stale client from requesting a page large enough to reintroduce the "load the whole library
// into memory at once" problem this pagination exists to avoid.
const MAX_LIBRARY_PAGE_SIZE: i64 = 500;
// Bumped from 100 -> 300 per the search revision doc ("empirically verified to work great in the
// Kinesis app").
const DEFAULT_LIBRARY_PAGE_SIZE: i64 = 300;

#[command]
pub async fn fetch_saved_videos(
    app: tauri::AppHandle,
    filter_kind: Option<String>,
    sort_field: Option<String>,
    sort_order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    include_content: Option<bool>,
) -> Result<VideoResponse, String> {
    let db_path = get_db_path(&app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(DEFAULT_LIBRARY_PAGE_SIZE).clamp(1, MAX_LIBRARY_PAGE_SIZE);
    let offset = offset.unwrap_or(0).max(0);
    let (videos, total_count) = db::list_videos(
        &db_path,
        filter_kind.as_deref(),
        sort_field.as_deref(),
        sort_order.as_deref(),
        limit,
        offset,
        include_content.unwrap_or(false),
    )
    .map_err(|e| e.to_string())?;
    Ok(VideoResponse { videos, continuation: None, total_count: Some(total_count) })
}

#[command]
pub async fn search_library(
    app: tauri::AppHandle,
    query: String,
    filter_kind: Option<String>,
    sort_field: Option<String>,
    sort_order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<VideoResponse, String> {
    let db_path = get_db_path(&app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(DEFAULT_LIBRARY_PAGE_SIZE).clamp(1, MAX_LIBRARY_PAGE_SIZE);
    let offset = offset.unwrap_or(0).max(0);
    let (videos, total_count) = db::search_library_videos(
        &db_path,
        &query,
        filter_kind.as_deref(),
        sort_field.as_deref(),
        sort_order.as_deref(),
        limit,
        offset,
    )
    .map_err(|e| e.to_string())?;
    Ok(VideoResponse { videos, continuation: None, total_count: Some(total_count) })
}

#[command]
pub async fn delete_video(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    db::delete_video(&db_path, &video_id).map_err(|e| e.to_string())?;
    Ok("Deleted".to_string())
}

/// One saved video (with its summary and transcript), for opening a link that points at it.
/// None when it isn't in this library.
#[command]
pub async fn get_video_by_id(app: tauri::AppHandle, video_id: String) -> Result<Option<crate::Video>, String> {
    let db_path = get_db_path(&app);
    db::get_video_by_id(&db_path, &video_id, true).map_err(|e| e.to_string())
}

#[command]
pub async fn check_video_exists(app: tauri::AppHandle, video_id: String) -> Result<bool, String> {
    let db_path = get_db_path(&app);
    db::check_video_exists(&db_path, &video_id).map_err(|e| e.to_string())
}

#[command]
pub async fn bulk_save_videos(app: tauri::AppHandle, video_ids: Vec<String>) -> Result<serde_json::Value, String> {
    let mut results = Vec::new();
    for id in video_ids {
        match save_video(app.clone(), id, None, None, None, None, None, None, None, None, None).await {
            Ok(v) => results.push(serde_json::to_value(v).unwrap()),
            Err(e) => results.push(serde_json::json!({"error": e})),
        }
    }
    Ok(serde_json::Value::Array(results))
}
