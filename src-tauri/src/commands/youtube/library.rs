use tauri::command;
use crate::{get_db_path, db, types::*};
use crate::youtube::{YouTubeClient, ClientType, decode_html};
use super::transcript::fetch_transcript_with_retries;

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
    video_type: Option<String>,
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
        let has_summary = db::has_real_summary(&v_data.10);
        return Ok(Video {
            id: v_data.0,
            title: v_data.1,
            thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id),
            published_at: v_data.6,
            view_count: v_data.5.to_string(),
            author: Some(v_data.2),
            handle: Some(v_data.7),
            status: Some("exists".to_string()),
            date_added: Some(v_data.9),
            length_seconds: Some(v_data.3),
            video_type: Some(v_data.8),
            transcript: Some(v_data.4),
            summary: Some(v_data.10),
            tags: Some(v_data.11),
            has_transcript: Some(has_transcript),
            has_summary: Some(has_summary),
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
            let author = author.unwrap_or_else(|| "Unknown".to_string());
            let length = length_seconds.unwrap_or(0);
            let video_type = video_type.unwrap_or_else(|| {
                if length > 0 && length <= 60 { "short" } else { "standard" }.to_string()
            });
            let view_count = view_count.as_deref().map(parse_view_count).unwrap_or(0);
            let published_at = published_at.unwrap_or_default();
            let has_summary = summary.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);

            if let Some(ref h) = handle {
                let _ = db::upsert_biography_from_video(&db_path, h, &author);
            }
            db::save_video(&db_path, &video_id, title_val, &author, length, transcript_val, view_count, &published_at, handle.as_deref().unwrap_or(""), &video_type, summary.as_deref())
                .map_err(|e| e.to_string())?;

            let date_added = {
                let conn = rusqlite::Connection::open(&db_path).ok();
                conn.and_then(|c| {
                    c.query_row("SELECT date_added FROM videos WHERE video_id = ?", rusqlite::params![video_id], |row| row.get::<_, Option<String>>(0)).ok().flatten()
                })
            };

            return Ok(Video {
                thumbnail: thumbnail.unwrap_or_else(|| format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id)),
                id: video_id,
                title: title_val.to_string(),
                published_at,
                view_count: view_count.to_string(),
                author: Some(author),
                handle,
                status: Some("saved".to_string()),
                date_added,
                length_seconds: Some(length),
                video_type: Some(video_type),
                transcript: Some(transcript_val.to_string()),
                summary,
                tags: None,
                has_transcript: Some(true),
                has_summary: Some(has_summary),
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
    if let Some(authors) = details["author"].as_array() {
        if let Some(first) = authors.first() {
            if let Some(channel_id) = first["channel_id"].as_str() {
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

    let length = details["lengthSeconds"].as_str().unwrap_or("0").parse::<i32>().unwrap_or(0);
    let view_count = parse_view_count(details["viewCount"].as_str().unwrap_or("0"));
    let published_at = player_web["microformat"]["playerMicroformatRenderer"]["publishDate"].as_str().unwrap_or("");
    let video_type = if length > 0 && length <= 60 { "short" } else { "standard" };
    let has_summary = summary
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // Upsert the biography row before saving the video so save_video's channel-info footer
    // (joined against biographies.handle) can find it on this very first save.
    if let Some(ref h) = handle {
        let _ = db::upsert_biography_from_video(&db_path, h, &author);
    }
    db::save_video(&db_path, &video_id, &title, &author, length, &transcript, view_count, published_at, handle.as_deref().unwrap_or(""), video_type, summary.as_deref())
        .map_err(|e| e.to_string())?;

    let date_added = {
        let conn = rusqlite::Connection::open(&db_path).ok();
        conn.and_then(|c| {
            c.query_row("SELECT date_added FROM videos WHERE video_id = ?", rusqlite::params![video_id], |row| row.get::<_, Option<String>>(0)).ok().flatten()
        })
    };

    Ok(Video {
        thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id),
        id: video_id,
        title: title.to_string(),
        published_at: published_at.to_string(),
        view_count: view_count.to_string(),
        author: Some(author.to_string()),
        handle,
        status: Some("saved".to_string()),
        date_added,
        length_seconds: Some(length),
        video_type: Some(video_type.to_string()),
        transcript: Some(transcript),
        summary: summary,
        tags: None,
        has_transcript: Some(true),
        has_summary: Some(has_summary),
    })
}

// Hard cap on Library page size, independent of whatever the frontend asks for — keeps a rogue
// or stale client from requesting a page large enough to reintroduce the "load the whole library
// into memory at once" problem this pagination exists to avoid.
const MAX_LIBRARY_PAGE_SIZE: i64 = 500;
const DEFAULT_LIBRARY_PAGE_SIZE: i64 = 100;

#[command]
pub async fn fetch_saved_videos(
    app: tauri::AppHandle,
    video_type: Option<String>,
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
        video_type.as_deref(),
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
    video_type: Option<String>,
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
        video_type.as_deref(),
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

#[command]
pub async fn check_video_exists(app: tauri::AppHandle, video_id: String) -> Result<bool, String> {
    let db_path = get_db_path(&app);
    db::check_video_exists(&db_path, &video_id).map_err(|e| e.to_string())
}

#[command]
pub async fn bulk_save_videos(app: tauri::AppHandle, video_ids: Vec<String>) -> Result<serde_json::Value, String> {
    let mut results = Vec::new();
    for id in video_ids {
        match save_video(app.clone(), id, None, None, None, None, None, None, None, None, None, None).await {
            Ok(v) => results.push(serde_json::to_value(v).unwrap()),
            Err(e) => results.push(serde_json::json!({"error": e})),
        }
    }
    Ok(serde_json::Value::Array(results))
}
