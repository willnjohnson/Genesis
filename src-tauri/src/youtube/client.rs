use serde_json::Value;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, CONTENT_TYPE};
use html_escape;

use super::identifiers::extract_handle_from_text;
use crate::types::{extract_handle_from_url, normalize_published_at};

/// Decode HTML entities in a string (e.g., &amp; -> &, &#39; -> ')
pub(crate) fn decode_html(text: &str) -> String {
    html_escape::decode_html_entities(text).to_string()
}

#[derive(Debug, Clone, Copy)]
pub enum ClientType {
    Web,
    Android,
    Ios,
}

pub struct YouTubeClient {
    client: reqwest::Client,
    client_type: ClientType,
}

impl YouTubeClient {
    pub fn new(client_type: ClientType) -> Self {
        Self {
            client: reqwest::Client::new(),
            client_type,
        }
    }

    fn get_context(&self) -> Value {
        match self.client_type {
            ClientType::Web => {
                serde_json::json!({
                    "context": {
                        "client": {
                            "clientName": "WEB",
                            "clientVersion": "2.20230301.09.00",
                            "hl": "en",
                            "gl": "US",
                            "utcOffsetMinutes": 0,
                        }
                    }
                })
            }
            ClientType::Ios => {
                serde_json::json!({
                    "context": {
                        "client": {
                            "clientName": "IOS",
                            "clientVersion": "20.10.4",
                            "deviceModel": "iPhone16,2",
                            "osName": "iPhone",
                            "osVersion": "18.3.2.22D82",
                            "hl": "en",
                            "gl": "US",
                            "utcOffsetMinutes": 0,
                        }
                    }
                })
            }
            ClientType::Android => {
                serde_json::json!({
                    "context": {
                        "client": {
                            "clientName": "ANDROID",
                            "clientVersion": "21.02.35",
                            "hl": "en",
                            "gl": "US",
                            "utcOffsetMinutes": 0,
                            "androidSdkVersion": 34,
                        }
                    }
                })
            }
        }
    }

    fn get_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let ua = match self.client_type {
            ClientType::Web => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            ClientType::Android => "com.google.android.youtube/21.02.35 (Linux; U; Android 14; en_US) gzip",
            ClientType::Ios => "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
        };
        headers.insert(USER_AGENT, HeaderValue::from_str(ua).unwrap());
        headers
    }

    /// A page of keyword search results: the first page for `query`, or (with a continuation token
    /// from the previous page) the next one. A continuation is asked for on its own, without the query.
    pub async fn search(&self, query: &str, continuation: Option<&str>) -> Result<Value, String> {
        let mut body = self.get_context();
        match continuation {
            Some(token) => body["continuation"] = serde_json::json!(token),
            None => body["query"] = serde_json::json!(query),
        }

        let res = self.client.post("https://www.youtube.com/youtubei/v1/search")
            .headers(self.get_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        res.json::<Value>().await.map_err(|e| e.to_string())
    }

    /// One of a channel's tabs (`params` says which, see `listing::CHANNEL_VIDEOS_TAB`).
    pub async fn browse_tab(&self, browse_id: &str, params: &str) -> Result<Value, String> {
        let mut body = self.get_context();
        body["browseId"] = serde_json::json!(browse_id);
        body["params"] = serde_json::json!(params);
        self.post_browse(body).await
    }

    /// The next page of a channel tab or playlist, from the token the previous page gave. A continuation
    /// stands on its own: sending the channel or playlist id along with it is refused.
    pub async fn browse_continuation(&self, token: &str) -> Result<Value, String> {
        let mut body = self.get_context();
        body["continuation"] = serde_json::json!(token);
        self.post_browse(body).await
    }

    pub async fn browse(&self, browse_id: Option<String>, continuation: Option<String>) -> Result<Value, String> {
        let mut body = self.get_context();
        if let Some(id) = browse_id {
            body["browseId"] = serde_json::json!(id);
        }
        if let Some(c) = continuation {
            body["continuation"] = serde_json::json!(c);
        }
        self.post_browse(body).await
    }

    async fn post_browse(&self, body: Value) -> Result<Value, String> {

        let res = self.client.post("https://www.youtube.com/youtubei/v1/browse")
            .headers(self.get_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        res.json::<Value>().await.map_err(|e| e.to_string())
    }

    pub async fn player(&self, video_id: &str) -> Result<Value, String> {
        let mut body = self.get_context();
        body["videoId"] = serde_json::json!(video_id);

        let res = self.client.post("https://www.youtube.com/youtubei/v1/player")
            .headers(self.get_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        res.json::<Value>().await.map_err(|e| e.to_string())
    }
}

/// True for a video that isn't published yet: a live stream in progress, or one that's scheduled
/// (a stream or premiere that hasn't started). Works on each renderer shape YouTube serves:
///   - search `videoRenderer` / channel `playlistVideoRenderer`: a `LIVE_NOW` badge, a time-status
///     overlay of `LIVE`/`UPCOMING`, or an `upcomingEventData` object;
///   - the newer `lockupViewModel`: a thumbnail badge styled `..._LIVE` (or reading LIVE/UPCOMING).
/// A finished livestream is an ordinary published video (normal duration, "Streamed ... ago") and
/// is NOT matched. Only badge/overlay structures are inspected, never text such as titles or
/// descriptions, which routinely contain the word "live".
///
/// The live markers and the search-result scheduled markers were taken from real responses. The
/// `lockupViewModel` scheduled markers below (badge text/style, "Scheduled for"/"Premieres" rows)
/// are the best-effort counterpart: no scheduled item was available to confirm that exact shape.
pub fn is_live_or_upcoming(renderer: &Value) -> bool {
    if renderer.get("upcomingEventData").is_some() {
        return true;
    }
    if let Some(badges) = renderer["badges"].as_array() {
        let live_badge = badges.iter().any(|b| {
            let m = &b["metadataBadgeRenderer"];
            m["style"].as_str() == Some("BADGE_STYLE_TYPE_LIVE_NOW") || m["icon"]["iconType"].as_str() == Some("LIVE")
        });
        if live_badge {
            return true;
        }
    }
    if let Some(overlays) = renderer["thumbnailOverlays"].as_array() {
        let time_status = overlays.iter().any(|o| {
            matches!(o["thumbnailOverlayTimeStatusRenderer"]["style"].as_str(), Some("LIVE") | Some("UPCOMING"))
        });
        if time_status {
            return true;
        }
    }

    // lockupViewModel
    if let Some(overlays) = renderer["contentImage"]["thumbnailViewModel"]["overlays"].as_array() {
        for overlay in overlays {
            let Some(badges) = overlay["thumbnailBottomOverlayViewModel"]["badges"].as_array() else { continue };
            for badge in badges {
                let b = &badge["thumbnailBadgeViewModel"];
                let style = b["badgeStyle"].as_str().unwrap_or("");
                let text = b["text"].as_str().unwrap_or("");
                if style.ends_with("_LIVE")
                    || style.ends_with("_UPCOMING")
                    || text.eq_ignore_ascii_case("LIVE")
                    || text.eq_ignore_ascii_case("UPCOMING")
                {
                    return true;
                }
            }
        }
    }
    // Row 0 of a lockup's metadata is the channel name, so scheduled-time text is only looked for
    // below it (a channel called "Premieres ..." must not hide its own videos).
    if let Some(rows) = renderer["metadata"]["lockupMetadataViewModel"]["metadata"]["contentMetadataViewModel"]["metadataRows"].as_array() {
        for row in rows.iter().skip(1) {
            if let Some(parts) = row["metadataParts"].as_array() {
                if parts.iter().any(|p| {
                    let t = p["text"]["content"].as_str().unwrap_or("");
                    t.starts_with("Scheduled for") || t.starts_with("Premieres ")
                }) {
                    return true;
                }
            }
        }
    }
    false
}

/// "9:11" or "1:02:03" (a duration as YouTube prints it on a thumbnail) in seconds.
pub(crate) fn duration_text_to_secs(text: &str) -> Option<i32> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.len() < 2 || parts.len() > 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let secs = parts.iter().try_fold(0i64, |acc, p| p.parse::<i64>().ok().map(|n| acc * 60 + n))?;
    i32::try_from(secs).ok()
}

pub fn extract_video_basic_info(renderer: &Value) -> Option<Value> {
    let video_id = renderer["videoId"].as_str()?;
    let title = decode_html(renderer["title"]["runs"][0]["text"].as_str().unwrap_or("Unknown"));

    let thumbs = renderer["thumbnail"]["thumbnails"].as_array();
    let thumbnail = thumbs.and_then(|t| t.last())
        .and_then(|t| t["url"].as_str())
        .unwrap_or("");

    let published_text = normalize_published_at(renderer["publishedTimeText"]["simpleText"].as_str().unwrap_or(""));

    let mut view_count_text = renderer["viewCountText"]["simpleText"].as_str().unwrap_or("").to_string();
    if view_count_text.is_empty() {
        if let Some(runs) = renderer["viewCountText"]["runs"].as_array() {
            view_count_text = runs.iter().map(|r| r["text"].as_str().unwrap_or("")).collect::<String>();
        }
    }

    let owner_text = decode_html(renderer["ownerText"]["runs"][0]["text"].as_str().unwrap_or(""));

    // Try to extract handle from ownerText (e.g., "Channel Name (@handle)")
    let handle = extract_handle_from_text(&owner_text);

    Some(serde_json::json!({
        "id": video_id,
        "title": title,
        "thumbnail": thumbnail,
        "publishedAt": published_text,
        "viewCount": view_count_text,
        "author": owner_text,
        "handle": handle,
        "lengthSeconds": renderer["lengthText"]["simpleText"].as_str().and_then(duration_text_to_secs)
    }))
}

pub fn extract_playlist_video_info(renderer: &Value) -> Option<Value> {
    let video_id = renderer["videoId"].as_str()?;
    let title = decode_html(renderer["title"]["runs"][0]["text"].as_str().unwrap_or("Unknown"));

    let thumbs = renderer["thumbnail"]["thumbnails"].as_array();
    let thumbnail = thumbs.and_then(|t| t.last())
        .and_then(|t| t["url"].as_str())
        .unwrap_or("");

    let owner_text = decode_html(renderer["shortBylineText"]["runs"][0]["text"].as_str().unwrap_or(""));

    let handle = extract_handle_from_text(&owner_text);

    let mut view_count = String::new();
    let mut published_at = String::new();

    if let Some(info) = renderer["videoInfo"]["runs"].as_array() {
        if info.len() >= 3 {
             view_count = info[0]["text"].as_str().unwrap_or("").to_string();
             published_at = normalize_published_at(info[2]["text"].as_str().unwrap_or(""));
        } else if !info.is_empty() {
             view_count = info[0]["text"].as_str().unwrap_or("").to_string();
        }
    }

    // A playlist item states its length in seconds (as a string).
    let length_seconds = renderer["lengthSeconds"].as_str().and_then(|s| s.parse::<i32>().ok());

    Some(serde_json::json!({
        "id": video_id,
        "title": title,
        "thumbnail": thumbnail,
        "publishedAt": published_at,
        "viewCount": view_count,
        "author": owner_text,
        "handle": handle,
        "lengthSeconds": length_seconds
    }))
}

/// YouTube has been rolling out a ViewModel-based renderer (`lockupViewModel`) in place of
/// `playlistVideoRenderer` for playlist/channel-uploads browse responses — same item, totally
/// different JSON shape (video id under `contentId` instead of `videoId`, title nested under
/// `metadata.lockupMetadataViewModel.title.content` instead of `title.runs[0].text`, etc).
/// Mirrors extract_playlist_video_info's output shape so callers can treat either renderer the
/// same way once extracted.
pub fn extract_lockup_video_info(lockup: &Value) -> Option<Value> {
    if lockup["contentType"].as_str() != Some("LOCKUP_CONTENT_TYPE_VIDEO") {
        return None;
    }
    let video_id = lockup["contentId"].as_str()?;

    let metadata = &lockup["metadata"]["lockupMetadataViewModel"];
    let title = decode_html(metadata["title"]["content"].as_str().unwrap_or("Unknown"));

    let thumbnail = lockup["contentImage"]["thumbnailViewModel"]["image"]["sources"]
        .as_array()
        .and_then(|sources| sources.last())
        .and_then(|t| t["url"].as_str())
        .unwrap_or("");

    let rows = metadata["metadata"]["contentMetadataViewModel"]["metadataRows"].as_array();
    let row_text = |row_idx: usize, part_idx: usize| -> Option<&str> {
        rows?.get(row_idx)?["metadataParts"].as_array()?.get(part_idx)?["text"]["content"].as_str()
    };

    let owner_text = decode_html(row_text(0, 0).unwrap_or(""));
    let view_count = row_text(1, 0).unwrap_or("").to_string();
    let published_at = normalize_published_at(row_text(1, 1).unwrap_or(""));

    let handle = rows
        .and_then(|r| r.first())
        .and_then(|row| row["metadataParts"].as_array())
        .and_then(|parts| parts.first())
        .and_then(|part| part["text"]["commandRuns"].as_array())
        .and_then(|runs| runs.first())
        .and_then(|run| run["onTap"]["innertubeCommand"]["browseEndpoint"]["canonicalBaseUrl"].as_str())
        .and_then(extract_handle_from_url);

    // The length is the badge on the thumbnail's bottom edge ("16:36").
    let length_seconds = lockup["contentImage"]["thumbnailViewModel"]["overlays"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o["thumbnailBottomOverlayViewModel"]["badges"].as_array())
        .flatten()
        .filter_map(|b| b["thumbnailBadgeViewModel"]["text"].as_str())
        .find_map(duration_text_to_secs);

    Some(serde_json::json!({
        "id": video_id,
        "title": title,
        "thumbnail": thumbnail,
        "publishedAt": published_at,
        "viewCount": view_count,
        "author": owner_text,
        "handle": handle,
        "lengthSeconds": length_seconds
    }))
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use serde_json::json;

    // Trimmed from real InnerTube responses (search and a channel's uploads playlist).

    #[test]
    fn a_live_stream_in_search_results_is_detected() {
        let live = json!({
            "videoId": "ExF83wcgErw",
            "badges": [
                {"metadataBadgeRenderer": {"icon": {"iconType": "LIVE"}, "style": "BADGE_STYLE_TYPE_LIVE_NOW", "label": "LIVE"}},
                {"metadataBadgeRenderer": {"style": "BADGE_STYLE_TYPE_SIMPLE", "label": "New"}}
            ],
            "thumbnailOverlays": []
        });
        assert!(is_live_or_upcoming(&live));
    }

    #[test]
    fn a_scheduled_stream_in_search_results_is_detected() {
        let upcoming = json!({
            "videoId": "9gDxG-pm1Zo",
            "badges": [{"metadataBadgeRenderer": {"style": "BADGE_STYLE_TYPE_SIMPLE", "label": "New"}}],
            "thumbnailOverlays": [{"thumbnailOverlayTimeStatusRenderer": {"text": {"simpleText": "Upcoming"}, "style": "UPCOMING"}}],
            "upcomingEventData": {"startTime": "1790583300", "upcomingEventText": {"runs": [{"text": "Scheduled for "}]}}
        });
        assert!(is_live_or_upcoming(&upcoming));
        // Either marker alone is enough.
        assert!(is_live_or_upcoming(&json!({"upcomingEventData": {"startTime": "1"}})));
        assert!(is_live_or_upcoming(&json!({"thumbnailOverlays": [{"thumbnailOverlayTimeStatusRenderer": {"style": "UPCOMING"}}]})));
        assert!(is_live_or_upcoming(&json!({"thumbnailOverlays": [{"thumbnailOverlayTimeStatusRenderer": {"style": "LIVE"}}]})));
    }

    #[test]
    fn a_live_stream_in_a_channel_listing_is_detected() {
        let lockup = json!({
            "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
            "contentId": "JcVqbivJCpQ",
            "contentImage": {"thumbnailViewModel": {"overlays": [
                {"thumbnailBottomOverlayViewModel": {"badges": [
                    {"thumbnailBadgeViewModel": {"text": "LIVE", "badgeStyle": "THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"}}
                ]}}
            ]}},
            "metadata": {"lockupMetadataViewModel": {"metadata": {"contentMetadataViewModel": {"metadataRows": [
                {"metadataParts": [{"text": {"content": "SGPC, Sri Amritsar"}}]},
                {"metadataParts": [{"text": {"content": "160K watching"}}]}
            ]}}}}
        });
        assert!(is_live_or_upcoming(&lockup));
    }

    #[test]
    fn ordinary_published_videos_are_never_matched() {
        let normal = json!({
            "videoId": "mefMdjvNxU4",
            "badges": [{"metadataBadgeRenderer": {"style": "BADGE_STYLE_TYPE_SIMPLE", "label": "New"}}],
            "thumbnailOverlays": [{"thumbnailOverlayTimeStatusRenderer": {"text": {"simpleText": "11:14"}, "style": "DEFAULT"}}]
        });
        assert!(!is_live_or_upcoming(&normal));

        // A finished livestream is a normal video: it has a duration and a "Streamed ... ago" date.
        let finished_stream = json!({
            "videoId": "abc",
            "publishedTimeText": {"simpleText": "Streamed 2 days ago"},
            "thumbnailOverlays": [{"thumbnailOverlayTimeStatusRenderer": {"text": {"simpleText": "3:12:45"}, "style": "DEFAULT"}}]
        });
        assert!(!is_live_or_upcoming(&finished_stream));

        let lockup = json!({
            "contentImage": {"thumbnailViewModel": {"overlays": [
                {"thumbnailBottomOverlayViewModel": {"badges": [{"thumbnailBadgeViewModel": {"text": "28:30", "badgeStyle": "THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT"}}]}}
            ]}},
            "metadata": {"lockupMetadataViewModel": {"metadata": {"contentMetadataViewModel": {"metadataRows": [
                {"metadataParts": [{"text": {"content": "SpaceX"}}]},
                {"metadataParts": [{"text": {"content": "384K views"}}, {"text": {"content": "7 hours ago"}}]}
            ]}}}}
        });
        assert!(!is_live_or_upcoming(&lockup));
    }

    #[test]
    fn the_word_live_in_titles_descriptions_or_a_channel_name_does_not_hide_a_video() {
        let tricky = json!({
            "videoId": "x",
            "title": {"runs": [{"text": "LIVE"}]},
            "detailedMetadataSnippets": [{"snippetText": {"runs": [{"text": "LIVE"}, {"text": "upcoming"}]}}],
            "thumbnailOverlays": [{"thumbnailOverlayTimeStatusRenderer": {"style": "DEFAULT"}}]
        });
        assert!(!is_live_or_upcoming(&tricky));

        // A lockup whose channel (row 0) is literally named "Premieres Weekly".
        let channel_named_premieres = json!({
            "metadata": {"lockupMetadataViewModel": {"metadata": {"contentMetadataViewModel": {"metadataRows": [
                {"metadataParts": [{"text": {"content": "Premieres Weekly"}}]},
                {"metadataParts": [{"text": {"content": "1K views"}}, {"text": {"content": "1 day ago"}}]}
            ]}}}}
        });
        assert!(!is_live_or_upcoming(&channel_named_premieres));
    }
}

#[cfg(test)]
mod duration_tests {
    use super::duration_text_to_secs;

    #[test]
    fn durations_as_printed_on_a_thumbnail_are_read() {
        assert_eq!(duration_text_to_secs("0:45"), Some(45));
        assert_eq!(duration_text_to_secs("9:11"), Some(551));
        assert_eq!(duration_text_to_secs("1:02:03"), Some(3723));
        assert_eq!(duration_text_to_secs("  16:36 "), Some(996));
        for bad in ["", "LIVE", "12", "1:2:3:4", "a:b", "5:", ":30", "UPCOMING", "3 views"] {
            assert_eq!(duration_text_to_secs(bad), None, "{bad:?}");
        }
    }
}
