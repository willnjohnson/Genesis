use std::collections::HashSet;
use serde_json::Value;
use tauri::command;
use crate::{get_db_path, db, types::*};
use crate::sync::license::{self, Route};
use crate::youtube::{self, YouTubeClient, ClientType, decode_html};

/// The bad-key message. The Search screen turns its "YouTube API key" into a link to the API Key
/// settings (VideoList.tsx matches this exact text), so change them together.
const BAD_KEY_MESSAGE: &str = "Your YouTube API key isn't valid.";

/// Why a Data API call failed, as a sentence for the person searching. The API answers a bad key
/// with an ordinary error body (HTTP 400, reason `keyInvalid`), so there's no separate "check my key"
/// call: the first real request says. Anything not recognized keeps Google's own message.
fn youtube_api_error(res: &Value) -> String {
    let error = &res["error"];
    let message = error["message"].as_str().unwrap_or("Unknown");
    // The reason sits in `errors[0].reason` (e.g. "keyInvalid"), and newer responses repeat it in
    // `details[].reason` (e.g. "API_KEY_INVALID").
    let reasons: Vec<&str> = error["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["reason"].as_str())
        .chain(error["details"].as_array().into_iter().flatten().filter_map(|d| d["reason"].as_str()))
        .collect();
    let has = |wanted: &[&str]| reasons.iter().any(|r| wanted.contains(r));
    if has(&["keyInvalid", "API_KEY_INVALID"]) || message.contains("API key not valid") {
        BAD_KEY_MESSAGE.to_string()
    } else if has(&["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "RATE_LIMIT_EXCEEDED"]) {
        "Your YouTube API quota has run out. It resets daily (midnight Pacific time).".to_string()
    } else if has(&["accessNotConfigured", "SERVICE_DISABLED"]) {
        "The YouTube Data API v3 isn't enabled for this API key's Google Cloud project. Enable it there, then try again.".to_string()
    } else if has(&["ipRefererBlocked", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_ANDROID_APP_BLOCKED", "API_KEY_IOS_APP_BLOCKED"]) {
        "This YouTube API key has restrictions (IP address or referrer) that block Kinesis. Remove them or use an unrestricted key.".to_string()
    } else {
        format!("API Error: {message}")
    }
}

/// A problem with the key or the account itself, which no other request will get around (unlike a
/// missing playlist, where searching instead may still work): worth stopping on rather than trying
/// the costlier fallback.
fn is_key_problem(res: &Value) -> bool {
    !youtube_api_error(res).starts_with("API Error:")
}

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

/// Fetches statistics + contentDetails for `video_ids` from the YouTube Data API and patches each
/// matching entry in `videos` in place: view count and length_seconds. Used after both the
/// channel-uploads and keyword-search endpoints, neither of which returns view counts or
/// durations in their own response.
///
/// Returns the ids among `video_ids` that aren't published yet (a live stream in progress, or one
/// that's scheduled), per each video's `snippet.liveBroadcastContent`. Callers drop those: the
/// channel-uploads endpoint, unlike keyword search, doesn't say whether a video is live.
async fn fetch_video_details(client: &reqwest::Client, route: &Route, video_ids: &[String], videos: &mut [Video]) -> HashSet<String> {
    let mut unpublished = HashSet::new();
    if video_ids.is_empty() {
        return unpublished;
    }
    let stats_url = route.url(&format!(
        "youtube/v3/videos?part=statistics,contentDetails,snippet&id={}",
        video_ids.join(",")
    ));
    if let Ok(stats_res) = route.apply(client.get(&stats_url)).send().await {
        if let Ok(stats_data) = stats_res.json::<Value>().await {
            if let Some(items) = stats_data["items"].as_array() {
                for item in items {
                    if let Some(vid) = item["id"].as_str() {
                        if is_unpublished_broadcast(item["snippet"]["liveBroadcastContent"].as_str()) {
                            unpublished.insert(vid.to_string());
                        }
                        if let Some(v) = videos.iter_mut().find(|v| v.id == vid) {
                            v.view_count = item["statistics"]["viewCount"].as_str().unwrap_or("0").to_string();
                            if let Some(len) = item["contentDetails"]["duration"].as_str().and_then(parse_iso8601_duration_secs) {
                                v.length_seconds = Some(len);
                            }
                        }
                    }
                }
            }
        }
    }
    unpublished
}

/// The Data API's `liveBroadcastContent` is "live" or "upcoming" for a stream that's in progress or
/// scheduled, and "none" for everything published (including a finished livestream).
fn is_unpublished_broadcast(value: Option<&str>) -> bool {
    matches!(value, Some("live") | Some("upcoming"))
}

/// Looks up a channel's current subscriber count via the YouTube Data API. Returns `None` (the
/// caller falls back to the 9999 "unknown" sentinel) whenever the request fails, the channel
/// doesn't exist, or the channel has hidden its subscriber count — the Data API simply omits the
/// field in that case rather than erroring. The digit-filter mirrors sanitize_int in
/// commands::youtube::library: defends against a stray non-numeric character in the response
/// tripping up the parse.
pub(crate) async fn fetch_subscriber_count(route: &Route, channel_id: &str) -> Option<i64> {
    let client = reqwest::Client::new();
    let url = route.url(&format!("youtube/v3/channels?part=statistics&id={}", channel_id));
    let res = route.apply(client.get(&url)).send().await.ok()?;
    let data: Value = res.json().await.ok()?;
    let raw = data["items"][0]["statistics"]["subscriberCount"].as_str()?;
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { None } else { digits.parse::<i64>().ok() }
}

#[command]
pub async fn resolve_channel(_app: tauri::AppHandle, query: String) -> Result<ChannelInfo, String> {
    match youtube::extract_channel_id(&query).await? {
        Some(id) => Ok(ChannelInfo { channel_id: id, channel_name: query }),
        None => Err("Could not resolve channel.".to_string()),
    }
}

/// The page's videos as the UI's `Video` type (JSON that doesn't fit is dropped, not fatal).
fn videos_from_page(items: Vec<Value>) -> Vec<Video> {
    items
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Video>(v).ok())
        .map(|mut v| {
            v.date_added = None;
            v
        })
        .collect()
}

/// A playlist, page by page, without an API key. The first call takes the playlist (or its URL); the
/// next ones take the continuation token the previous page returned.
#[command]
pub async fn fetch_videos(
    _app: tauri::AppHandle,
    id: String,
    is_playlist: bool,
    continuation: Option<String>,
) -> Result<VideoResponse, String> {
    let client = YouTubeClient::new(ClientType::Web);
    let data = match continuation.as_deref() {
        Some(token) => client.browse_continuation(token).await?,
        None => {
            let playlist_id = if is_playlist {
                youtube::extract_playlist_id(&id)
            } else {
                // A channel is listed as its regular videos (YouTube's UULF playlist); the older "all
                // uploads" playlist (UU...) now errors for anonymous visitors.
                let channel_id = youtube::extract_channel_id(&id).await?.ok_or("Channel not found")?;
                youtube::channel_id_to_uploads_playlist(&channel_id)
            };
            let browse_id = if playlist_id.starts_with("VL") { playlist_id } else { format!("VL{}", playlist_id) };
            client.browse(Some(browse_id), None).await?
        }
    };
    if let Some(problem) = youtube::response_problem(&data) {
        return Err(problem);
    }
    let page = youtube::parse_browse_page(&data);
    Ok(VideoResponse { videos: videos_from_page(page.videos), continuation: page.continuation, total_count: None })
}

/// A channel's videos, newest first, without an API key: the same list as the channel's Videos tab on
/// YouTube, which keeps going for as long as the channel has videos. Pass the continuation token
/// from the previous page to get the next one.
#[command]
pub async fn fetch_channel_videos_keyless(
    _app: tauri::AppHandle,
    query: String,
    continuation: Option<String>,
) -> Result<VideoResponse, String> {
    let client = YouTubeClient::new(ClientType::Web);
    let data = match continuation.as_deref() {
        Some(token) => client.browse_continuation(token).await?,
        None => {
            let channel_id = youtube::extract_channel_id(&query).await?.ok_or("Channel not found")?;
            client.browse_tab(&channel_id, youtube::CHANNEL_VIDEOS_TAB).await?
        }
    };
    if let Some(problem) = youtube::response_problem(&data) {
        return Err(problem);
    }
    let mut page = youtube::parse_browse_page(&data);

    // If the Videos tab came back empty (YouTube changed how it's asked for), fall back to the
    // channel's regular-videos playlist, which lists the same thing.
    if continuation.is_none() && page.videos.is_empty() {
        if let Some(channel_id) = youtube::extract_channel_id(&query).await? {
            let playlist = youtube::channel_id_to_uploads_playlist(&channel_id);
            let data = client.browse(Some(format!("VL{playlist}")), None).await?;
            page = youtube::parse_browse_page(&data);
        }
    }
    Ok(VideoResponse { videos: videos_from_page(page.videos), continuation: page.continuation, total_count: None })
}

#[command]
pub async fn fetch_channel_videos_v3(
    app: tauri::AppHandle,
    query: String,
    continuation: Option<String>,
) -> Result<VideoResponse, String> {
    let db_path = get_db_path(&app);
    let route = license::route(&db_path, "youtube").ok_or("API Key not found")?;
    let channel_id = youtube::extract_channel_id(&query).await?.unwrap_or(query);
    let client = reqwest::Client::new();

    let uploads_playlist_id = if channel_id.starts_with("UC") {
        format!("UU{}", &channel_id[2..])
    } else {
        channel_id.clone()
    };

    // Built without a key: `route.url` adds it (own key) or routes through the sync server's proxy.
    let mut path = format!(
        "youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId={}",
        uploads_playlist_id
    );
    if let Some(token) = continuation.as_ref() {
        path = format!("{}&pageToken={}", path, token);
    }
    let url = route.url(&path);

    let mut res: Value = route.apply(client.get(&url)).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;

    if res.get("error").is_some() {
        // A bad key or spent quota would fail the same way on the fallback below (and searching
        // costs far more quota than listing a playlist), so say so now.
        if is_key_problem(&res) {
            return Err(youtube_api_error(&res));
        }
        let mut search_path = format!(
            "youtube/v3/search?part=snippet&maxResults=50&channelId={}&order=date&type=video",
            channel_id
        );
        if let Some(token) = continuation {
            search_path = format!("{}&pageToken={}", search_path, token);
        }
        let search_url = route.url(&search_path);
        res = route.apply(client.get(&search_url)).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        if res.get("error").is_some() {
            return Err(youtube_api_error(&res));
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
                    length_seconds: None, transcript: None,
                    summary: None, tags: None, has_transcript: None, has_summary: None, wdbs: None,
                });
            }
        }
    }

    // The uploads playlist includes streams that are live or scheduled; the details call tells us
    // which, so only published videos are returned. A page may therefore carry fewer than 50
    // items; the continuation token still advances normally.
    let unpublished = fetch_video_details(&client, &route, &video_ids, &mut videos).await;
    videos.retain(|v| !unpublished.contains(&v.id));

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
        length_seconds: None, transcript: None,
        summary: None, tags: None, has_transcript: None, has_summary: None, wdbs: None,
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
    let route = license::route(&db_path, "youtube");

    log::info!("Search called - query: {}, continuation: {:?}, api access present: {}", query, continuation, route.is_some());

    // If API access is available (own key or a sync-server license), use the YouTube Data API with pagination
    if let Some(route) = route {
        let client = reqwest::Client::new();
        let mut path = format!(
            "youtube/v3/search?part=snippet&maxResults=50&q={}&type=video",
            urlencoding::encode(&query)
        );
        if let Some(token) = continuation.as_ref() {
            path = format!("{}&pageToken={}", path, token);
        }
        let url = route.url(&path);

        let res: Value = route.apply(client.get(&url)).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;

        if res.get("error").is_some() {
            return Err(youtube_api_error(&res));
        }

        let next_page_token = res["nextPageToken"].as_str().map(|s| s.to_string());
        let mut videos = Vec::new();
        let mut video_ids = Vec::new();

        if let Some(items) = res["items"].as_array() {
            for item in items {
                let snippet = &item["snippet"];
                // Search results say up front whether a video is live or scheduled. Only videos
                // that are actually published belong in the results.
                if is_unpublished_broadcast(snippet["liveBroadcastContent"].as_str()) {
                    continue;
                }
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
                        length_seconds: None, transcript: None,
                        summary: None, tags: None, has_transcript: None, has_summary: None, wdbs: None,
                    });
                }
            }
        }

        // Belt and braces: the details call also reports live/scheduled status per video.
        let unpublished = fetch_video_details(&client, &route, &video_ids, &mut videos).await;
        videos.retain(|v| !unpublished.contains(&v.id));

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
            videos.retain(|v| !is_short_length(v.length_seconds));
        }

        return Ok(VideoResponse { videos, continuation: next_page_token, total_count: None });
    }

    // No API access: the same results YouTube's own site shows, page by page (each page hands back a
    // token for the next one, which "Load more" passes back in).
    let client = YouTubeClient::new(ClientType::Web);
    let data = client.search(&query, continuation.as_deref()).await?;
    if let Some(problem) = youtube::response_problem(&data) {
        return Err(problem);
    }
    let page = youtube::parse_search_page(&data);
    let mut videos = videos_from_page(page.videos);

    // The same Shorts filter as the API path; the length comes with each result.
    let hide_shorts = db::get_setting(&db_path, "hideShortsInSearch")
        .ok()
        .flatten()
        .map(|v| v != "false")
        .unwrap_or(true);
    if hide_shorts {
        videos.retain(|v| !is_short_length(v.length_seconds));
    }

    Ok(VideoResponse { videos, continuation: page.continuation, total_count: None })
}

#[cfg(test)]
mod api_error_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_bad_key_is_reported_as_one() {
        let older = json!({"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.",
            "errors": [{"message": "API key not valid. Please pass a valid API key.", "domain": "global", "reason": "keyInvalid"}]}});
        let newer = json!({"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT",
            "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"}]}});
        for res in [older, newer] {
            assert!(youtube_api_error(&res).starts_with("Your YouTube API key isn't valid"), "{res}");
            assert!(is_key_problem(&res));
        }
    }

    #[test]
    fn quota_and_a_disabled_api_have_their_own_messages() {
        let quota = json!({"error": {"code": 403, "message": "The request cannot be completed because you have exceeded your quota.", "errors": [{"reason": "quotaExceeded"}]}});
        assert!(youtube_api_error(&quota).contains("quota has run out"));
        let disabled = json!({"error": {"code": 403, "message": "YouTube Data API v3 has not been used in project 1 before or it is disabled.", "errors": [{"reason": "accessNotConfigured"}]}});
        assert!(youtube_api_error(&disabled).contains("isn't enabled"));
    }

    #[test]
    fn anything_else_keeps_googles_message_and_still_allows_the_fallback() {
        let missing = json!({"error": {"code": 404, "message": "The playlist identified with the request's playlistId parameter cannot be found.", "errors": [{"reason": "playlistNotFound"}]}});
        assert!(youtube_api_error(&missing).starts_with("API Error: The playlist"));
        assert!(!is_key_problem(&missing), "a missing playlist may still be found by searching");
    }
}
