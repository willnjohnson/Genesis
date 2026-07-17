use serde_json::Value;
use tauri::command;
use crate::{get_db_path, db, types::*};
use crate::youtube::{self, YouTubeClient, ClientType, decode_html};

/// Parses an ISO-8601 duration as returned by the Data API's contentDetails.duration
/// (e.g. "PT1H2M30S", "PT45S") into whole seconds.
fn parse_iso8601_duration_secs(s: &str) -> Option<i32> {
    let mut secs: i64 = 0;
    let mut num = String::new();
    let mut in_time = false;
    for c in s.chars() {
        match c {
            'P' => {}
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            _ => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                secs += n * match (c, in_time) {
                    ('D', _) => 86400,
                    ('H', _) => 3600,
                    ('M', true) => 60,
                    ('S', _) => 1,
                    _ => return None,
                };
            }
        }
    }
    Some(secs.min(i32::MAX as i64) as i32)
}

/// Fetches statistics + contentDetails for `video_ids` from the YouTube Data API and patches
/// each matching entry in `videos` in place: view count, length_seconds, and video_type
/// ("short" for 0 < length <= 60, matching the save-time rule in commands::youtube::library).
/// Used after both the channel-uploads and keyword-search endpoints, neither of which returns
/// view counts or durations in their own response.
async fn fetch_video_details(client: &reqwest::Client, api_key: &str, video_ids: &[String], videos: &mut [Video]) {
    if video_ids.is_empty() {
        return;
    }
    let stats_url = format!(
        "https://youtube.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id={}&key={}",
        video_ids.join(","), api_key
    );
    if let Ok(stats_res) = client.get(&stats_url).send().await {
        if let Ok(stats_data) = stats_res.json::<Value>().await {
            if let Some(items) = stats_data["items"].as_array() {
                for item in items {
                    if let Some(vid) = item["id"].as_str() {
                        if let Some(v) = videos.iter_mut().find(|v| v.id == vid) {
                            v.view_count = item["statistics"]["viewCount"].as_str().unwrap_or("0").to_string();
                            if let Some(len) = item["contentDetails"]["duration"].as_str().and_then(parse_iso8601_duration_secs) {
                                v.length_seconds = Some(len);
                                v.video_type = Some(if len > 0 && len <= 60 { "short" } else { "standard" }.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
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

    fetch_video_details(&client, &api_key, &video_ids, &mut videos).await;

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
                    // The Data API search response has no @handle field, only channelTitle; handle
                    // stays unresolved here (see fetch_video_handle for the on-demand lookup path).
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

        fetch_video_details(&client, &key, &video_ids, &mut videos).await;

        // Shorts filtering only applies to keyword search — channel/handle browsing
        // (fetch_channel_videos_v3) intentionally shows a channel's full uploads. Filtering
        // happens after the fetch, so a page may carry fewer than 50 items; the continuation
        // token still advances normally.
        let hide_shorts = db::get_setting(&db_path, "hideShortsInSearch")
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true);
        if hide_shorts {
            videos.retain(|v| v.video_type.as_deref() != Some("short"));
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
