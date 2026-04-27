use serde_json::Value;
use tauri::command;
use crate::{get_db_path, db, types::*};
use crate::youtube::{self, YouTubeClient, ClientType};
use html_escape;

/// Decode HTML entities in a string
fn decode_html(text: &str) -> String {
    html_escape::decode_html_entities(text).to_string()
}

#[command]
pub async fn resolve_channel(_app: tauri::AppHandle, query: String) -> Result<ChannelInfo, String> {
    match youtube::extract_channel_id(&query).await? {
        Some(id) => Ok(ChannelInfo { channel_id: id, channel_name: query }),
        None => Err("Could not resolve channel.".to_string()),
    }
}

#[command]
pub async fn fetch_videos(
    _app: tauri::AppHandle,
    id: String,
    is_playlist: bool,
    continuation: Option<String>,
) -> Result<VideoResponse, String> {
    let client = YouTubeClient::new(ClientType::Web);
    let playlist_id = if is_playlist {
        youtube::extract_playlist_id(&id)
    } else {
        let channel_id = youtube::extract_channel_id(&id).await?.ok_or("Channel not found")?;
        youtube::channel_id_to_uploads_playlist(&channel_id)
    };

    let browse_id = if playlist_id.starts_with("VL") { playlist_id } else { format!("VL{}", playlist_id) };
    let data = client.browse(Some(browse_id), continuation).await?;
    let mut videos = Vec::new();

    if let Some(tabs) = data["contents"]["twoColumnBrowseResultsRenderer"]["tabs"].as_array() {
        if let Some(contents) = tabs[0]["tabRenderer"]["content"]["sectionListRenderer"]["contents"].as_array() {
            if let Some(items) = contents[0]["itemSectionRenderer"]["contents"][0]["playlistVideoListRenderer"]["contents"].as_array() {
                for item in items {
                    if let Some(v_renderer) = item.get("playlistVideoRenderer") {
                        if let Some(v_json) = youtube::extract_playlist_video_info(v_renderer) {
                            if let Ok(mut v) = serde_json::from_value::<Video>(v_json) {
                                v.date_added = None;
                                videos.push(v);
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(actions) = data["onResponseReceivedActions"].as_array() {
        if let Some(items) = actions[0]["appendContinuationItemsAction"]["continuationItems"].as_array() {
            for item in items {
                if let Some(v_renderer) = item.get("playlistVideoRenderer") {
                    if let Some(v_json) = youtube::extract_playlist_video_info(v_renderer) {
                        if let Ok(mut v) = serde_json::from_value::<Video>(v_json) {
                            v.date_added = None;
                            videos.push(v);
                        }
                    }
                }
            }
        }
    }

    Ok(VideoResponse { videos, continuation: None, total_count: None })
}

#[command]
pub async fn fetch_channel_videos_v3(
    app: tauri::AppHandle,
    query: String,
    continuation: Option<String>,
) -> Result<VideoResponse, String> {
    let db_path = get_db_path(&app);
    let api_key = db::get_setting(&db_path, "api_key").unwrap_or(None).ok_or("API Key not found")?;
    let channel_id = youtube::extract_channel_id(&query).await?.unwrap_or(query);
    let client = reqwest::Client::new();

    let uploads_playlist_id = if channel_id.starts_with("UC") {
        format!("UU{}", &channel_id[2..])
    } else {
        channel_id.clone()
    };

    let mut url = format!(
        "https://youtube.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId={}&key={}",
        uploads_playlist_id, api_key
    );
    if let Some(token) = continuation.as_ref() {
        url = format!("{}&pageToken={}", url, token);
    }

    let mut res: Value = client.get(&url).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;

    if res.get("error").is_some() {
        let mut search_url = format!(
            "https://youtube.googleapis.com/youtube/v3/search?part=snippet&maxResults=50&channelId={}&order=date&type=video&key={}",
            channel_id, api_key
        );
        if let Some(token) = continuation {
            search_url = format!("{}&pageToken={}", search_url, token);
        }
        res = client.get(&search_url).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        if res.get("error").is_some() {
            return Err(format!("API Error: {}", res["error"]["message"].as_str().unwrap_or("Unknown")));
        }
    }

    let next_page_token = res["nextPageToken"].as_str().map(|s| s.to_string());
    let mut videos = Vec::new();
    let mut video_ids = Vec::new();

    if let Some(items) = res["items"].as_array() {
        for item in items {
            let snippet = &item["snippet"];
            let vid = item["contentDetails"]["videoId"].as_str()
                .or_else(|| item["id"]["videoId"].as_str())
                .or_else(|| item["id"].as_str());
            if let Some(vid) = vid {
                video_ids.push(vid.to_string());
                videos.push(Video {
                    id: vid.to_string(),
                    title: decode_html(&snippet["title"].as_str().unwrap_or("Unknown").to_string()),
                    thumbnail: snippet["thumbnails"]["high"]["url"].as_str()
                        .or(snippet["thumbnails"]["default"]["url"].as_str())
                        .unwrap_or("").to_string(),
                    published_at: snippet["publishedAt"].as_str().unwrap_or("").to_string(),
                    view_count: "0".to_string(),
                    author: snippet["channelTitle"].as_str().map(|s| decode_html(s)),
                    handle: None, status: None, date_added: None,
                    length_seconds: None, video_type: None, transcript: None,
                    summary: None, tags: None, has_transcript: None, has_summary: None,
                });
            }
        }
    }

    if !video_ids.is_empty() {
        let stats_url = format!(
            "https://youtube.googleapis.com/youtube/v3/videos?part=statistics&id={}&key={}",
            video_ids.join(","), api_key
        );
        if let Ok(stats_res) = client.get(&stats_url).send().await {
            if let Ok(stats_data) = stats_res.json::<Value>().await {
                if let Some(items) = stats_data["items"].as_array() {
                    for item in items {
                        if let Some(vid) = item["id"].as_str() {
                            if let Some(v) = videos.iter_mut().find(|v| v.id == vid) {
                                v.view_count = item["statistics"]["viewCount"].as_str().unwrap_or("0").to_string();
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(VideoResponse { videos, continuation: next_page_token, total_count: None })
}

#[command]
pub async fn fetch_view_count(_app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    let client = YouTubeClient::new(ClientType::Web);
    let data = client.player(&video_id).await?;
    Ok(data["videoDetails"]["viewCount"].as_str().unwrap_or("0").to_string())
}

#[command]
pub async fn fetch_video_info(_app: tauri::AppHandle, video_id: String) -> Result<Video, String> {
    use crate::types::{parse_view_count, extract_handle_from_url};
    let client = YouTubeClient::new(ClientType::Web);
    let data = client.player(&video_id).await?;
    let details = &data["videoDetails"];
    let published_at = data["microformat"]["playerMicroformatRenderer"]["publishDate"].as_str().unwrap_or("").to_string();

    let author = if let Some(authors) = details["author"].as_array() {
        authors.first().and_then(|a| a["name"].as_str()).map(|s| s.to_string())
    } else {
        details["author"].as_str().map(|s| s.to_string())
    };

    let mut handle: Option<String> = None;
    if let Some(url) = data["microformat"]["playerMicroformatRenderer"]["ownerProfileUrl"].as_str() {
        handle = extract_handle_from_url(url);
    }
    if handle.is_none() {
        if let Some(authors) = details["author"].as_array() {
            if let Some(first) = authors.first() {
                if let Some(url) = first["url"].as_str() {
                    handle = extract_handle_from_url(url);
                }
            }
        }
    }

    Ok(Video {
        id: details["videoId"].as_str().unwrap_or(&video_id).to_string(),
        title: decode_html(details["title"].as_str().unwrap_or("Unknown").as_ref()),
        thumbnail: details["thumbnail"]["thumbnails"].as_array()
            .and_then(|a| a.last())
            .and_then(|t| t["url"].as_str())
            .unwrap_or("").to_string(),
        published_at,
        view_count: parse_view_count(details["viewCount"].as_str().unwrap_or("0")).to_string(),
        author, handle, status: None, date_added: None,
        length_seconds: None, video_type: None, transcript: None,
        summary: None, tags: None, has_transcript: None, has_summary: None,
    })
}

#[command]
pub async fn fetch_video_handle(_app: tauri::AppHandle, video_id: String) -> Result<Option<String>, String> {
    let client = YouTubeClient::new(ClientType::Web);
    let player = client.player(&video_id).await?;
    let details = &player["videoDetails"];

    let mut handle: Option<String> = None;
    
    // Try to get handle from author array
    if let Some(authors) = details["author"].as_array() {
        if let Some(first) = authors.first() {
            if let Some(channel_id) = first["channel_id"].as_str() {
                handle = youtube::extract_handle_from_channel_id(channel_id).await.ok().flatten();
            }
        }
    }

    // Try other methods to get handle
    for try_handle in [
        player["microformat"]["playerMicroformatRenderer"]["ownerProfileUrl"].as_str().and_then(extract_handle_from_url),
        details["author"].as_array().and_then(|a| a.first()).and_then(|f| f["url"].as_str()).and_then(extract_handle_from_url),
    ] {
        if handle.is_none() { handle = try_handle; }
    }

    Ok(handle)
}

#[command]
pub async fn fetch_transcript(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    let video_id = video_id.trim().to_string();
    let db_path = get_db_path(&app);

    if let Ok(Some(t)) = db::get_transcript(&db_path, &video_id) {
        if !t.trim().is_empty() { return Ok(t); }
    }

    let api_key = db::get_setting(&db_path, "api_key").unwrap_or(None);
    if api_key.is_none() || api_key.unwrap().trim().is_empty() {
        return Err("API_KEY_MISSING".to_string());
    }

    let client = YouTubeClient::new(ClientType::Android);
    let mut attempts = 0;
    loop {
        attempts += 1;
        match client.player(&video_id).await {
            Ok(player_json) => match youtube::fetch_transcript(&player_json).await {
                Ok(Some(t)) if !t.trim().is_empty() => return Ok(t),
                Ok(_) | Err(_) if attempts < 3 => {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    continue;
                }
                Ok(_) => return Err("No transcript available for this video.".to_string()),
                Err(e) => return Err(format!("Transcript error: {}", e)),
            },
            Err(e) => {
                if attempts < 3 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    continue;
                }
                return Err(format!("Player API error: {}", e));
            }
        }
    }
}

#[command]
pub async fn save_transcript(app: tauri::AppHandle, video_id: String, transcript: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::save_transcript(&db_path, &video_id, &transcript).map_err(|e| e.to_string())
}

#[command]
pub async fn save_video(app: tauri::AppHandle, video_id: String, summary: Option<String>) -> Result<Video, String> {
    use crate::types::{parse_view_count, extract_handle_from_url};
    let db_path = get_db_path(&app);

    if let Ok(Some(v_data)) = db::get_video_full(&db_path, &video_id) {
        // Update summary if provided
        if let Some(ref s) = summary {
            let _ = db::save_summary(&db_path, &video_id, s);
        }

        let has_transcript = !v_data.4.trim().is_empty();
        let has_summary = !v_data.10.trim().is_empty();
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

    let client_web = YouTubeClient::new(ClientType::Web);
    let client_android = YouTubeClient::new(ClientType::Android);
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
                handle = youtube::extract_handle_from_channel_id(channel_id).await.ok().flatten();
            }
        }
    }

    let mut transcript = String::new();
    let mut attempts = 0;
    loop {
        attempts += 1;
        let p = client_android.player(&video_id).await?;
        match youtube::fetch_transcript(&p).await {
            Ok(Some(t)) if !t.trim().is_empty() => { transcript = t; break; }
            Ok(_) | Err(_) if attempts < 3 => {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
            _ => break,
        }
    }

    if transcript.is_empty() {
        return Err("Cannot save video without transcript.".to_string());
    }

    // Final guard: reject transcript if it contains YouTube's bot-detection / rate-limit text.
    // This catches cases where the error slipped through XML parsing as text nodes.
    let transcript_lower = transcript.to_lowercase();
    let bot_phrases = [
        "but your computer or network may be sending automated queries",
        "our systems have detected unusual traffic",
        "to protect our users, we can't process your request right now",
        "please solve this captcha",
        "unusual traffic from your computer network",
    ];
    if bot_phrases.iter().any(|phrase| transcript_lower.contains(phrase)) {
        return Err("YouTube returned a bot-detection page instead of a transcript. Please wait a moment and try again.".to_string());
    }

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

    db::save_video(&db_path, &video_id, &title, &author, length, &transcript, view_count, published_at, handle.as_deref().unwrap_or(""), video_type, summary.as_deref())
        .map_err(|e| e.to_string())?;
    if let Some(ref h) = handle {
        let _ = db::upsert_biography_from_video(&db_path, h, &author);
    }

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

#[command]
pub async fn fetch_saved_videos(
    app: tauri::AppHandle,
    video_type: Option<String>,
    include_content: Option<bool>,
) -> Result<VideoResponse, String> {
    let db_path = get_db_path(&app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let videos = db::list_videos(&db_path, video_type.as_deref(), include_content.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    Ok(VideoResponse { videos, continuation: None, total_count: None })
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
        match save_video(app.clone(), id, None).await {
            Ok(v) => results.push(serde_json::to_value(v).unwrap()),
            Err(e) => results.push(serde_json::json!({"error": e})),
        }
    }
    Ok(serde_json::Value::Array(results))
}

#[command]
pub async fn search_videos(app: tauri::AppHandle, query: String, continuation: Option<String>) -> Result<VideoResponse, String> {
    let db_path = get_db_path(&app);
    let api_key = db::get_setting(&db_path, "api_key").unwrap_or(None);

    log::info!("Search called - query: {}, continuation: {:?}, api_key present: {}", query, continuation, api_key.is_some());

    // If API key is available, use YouTube Data API with pagination
    if let Some(key) = api_key {
        let client = reqwest::Client::new();
        let mut url = format!(
            "https://youtube.googleapis.com/youtube/v3/search?part=snippet&maxResults=50&q={}&type=video&key={}",
            urlencoding::encode(&query), key
        );
        if let Some(token) = continuation.as_ref() {
            url = format!("{}&pageToken={}", url, token);
        }

        let res: Value = client.get(&url).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;

        if res.get("error").is_some() {
            return Err(format!("API Error: {}", res["error"]["message"].as_str().unwrap_or("Unknown")));
        }

        let next_page_token = res["nextPageToken"].as_str().map(|s| s.to_string());
        let mut videos = Vec::new();
        let mut video_ids = Vec::new();

        if let Some(items) = res["items"].as_array() {
            for item in items {
                let snippet = &item["snippet"];
                if let Some(vid) = item["id"]["videoId"].as_str() {
                    video_ids.push(vid.to_string());
                    let channel_title = snippet["channelTitle"].as_str().map(|s| decode_html(s));
                    // Try to extract handle from channel title (e.g., "MrBeast" -> check if we can get @handle)
                    // For API results, we don't get @handle directly, so we'll try to look it up when needed
                    videos.push(Video {
                        id: vid.to_string(),
                        title: decode_html(&snippet["title"].as_str().unwrap_or("Unknown").to_string()),
                        thumbnail: snippet["thumbnails"]["high"]["url"].as_str()
                            .or(snippet["thumbnails"]["default"]["url"].as_str())
                            .unwrap_or("").to_string(),
                        published_at: snippet["publishedAt"].as_str().unwrap_or("").to_string(),
                        view_count: "0".to_string(),
                        author: channel_title,
                        handle: None, status: None, date_added: None,
                        length_seconds: None, video_type: None, transcript: None,
                        summary: None, tags: None, has_transcript: None, has_summary: None,
                    });
                }
            }
        }

        // Fetch view counts
        if !video_ids.is_empty() {
            let stats_url = format!(
                "https://youtube.googleapis.com/youtube/v3/videos?part=statistics&id={}&key={}",
                video_ids.join(","), key
            );
            if let Ok(stats_res) = client.get(&stats_url).send().await {
                if let Ok(stats_data) = stats_res.json::<Value>().await {
                    if let Some(items) = stats_data["items"].as_array() {
                        for item in items {
                            if let Some(vid) = item["id"].as_str() {
                                if let Some(v) = videos.iter_mut().find(|v| v.id == vid) {
                                    v.view_count = item["statistics"]["viewCount"].as_str().unwrap_or("0").to_string();
                                }
                            }
                        }
                    }
                }
            }
        }

        return Ok(VideoResponse { videos, continuation: next_page_token, total_count: None });
    }

    // Fallback to web scraping without pagination
    let client = YouTubeClient::new(ClientType::Web);
    let data = client.search(&query).await?;
    let mut videos = Vec::new();

    if let Some(results) = data["contents"]["twoColumnSearchResultsRenderer"]["primaryContents"]["sectionListRenderer"]["contents"].as_array() {
        for section in results {
            if let Some(items) = section["itemSectionRenderer"]["contents"].as_array() {
                for item in items {
                    if let Some(v_renderer) = item.get("videoRenderer") {
                        if let Some(v_json) = youtube::extract_video_basic_info(v_renderer) {
                            if let Ok(mut v) = serde_json::from_value::<Video>(v_json) {
                                v.date_added = None;
                                videos.push(v);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(VideoResponse { videos, continuation: None, total_count: None })
}
