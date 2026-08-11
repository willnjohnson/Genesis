use serde_json::Value;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, CONTENT_TYPE};
use html_escape;

use super::identifiers::extract_handle_from_text;
use crate::types::extract_handle_from_url;

/// Decode HTML entities in a string (e.g., &amp; -> &, &#39; -> ')
pub(crate) fn decode_html(text: &str) -> String {
    html_escape::decode_html_entities(text).to_string()
}

#[derive(Debug, Clone, Copy)]
pub enum ClientType {
    Web,
    Android,
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
        };
        headers.insert(USER_AGENT, HeaderValue::from_str(ua).unwrap());
        headers
    }

    pub async fn search(&self, query: &str) -> Result<Value, String> {
        let mut body = self.get_context();
        body["query"] = serde_json::json!(query);

        let res = self.client.post("https://www.youtube.com/youtubei/v1/search")
            .headers(self.get_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        res.json::<Value>().await.map_err(|e| e.to_string())
    }

    pub async fn browse(&self, browse_id: Option<String>, continuation: Option<String>) -> Result<Value, String> {
        let mut body = self.get_context();
        if let Some(id) = browse_id {
            body["browseId"] = serde_json::json!(id);
        }
        if let Some(c) = continuation {
            body["continuation"] = serde_json::json!(c);
        }

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

pub fn extract_video_basic_info(renderer: &Value) -> Option<Value> {
    let video_id = renderer["videoId"].as_str()?;
    let title = decode_html(renderer["title"]["runs"][0]["text"].as_str().unwrap_or("Unknown"));

    let thumbs = renderer["thumbnail"]["thumbnails"].as_array();
    let thumbnail = thumbs.and_then(|t| t.last())
        .and_then(|t| t["url"].as_str())
        .unwrap_or("");

    let published_text = renderer["publishedTimeText"]["simpleText"].as_str().unwrap_or("");

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
        "handle": handle
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
             published_at = info[2]["text"].as_str().unwrap_or("").to_string();
        } else if !info.is_empty() {
             view_count = info[0]["text"].as_str().unwrap_or("").to_string();
        }
    }

    Some(serde_json::json!({
        "id": video_id,
        "title": title,
        "thumbnail": thumbnail,
        "publishedAt": published_at,
        "viewCount": view_count,
        "author": owner_text,
        "handle": handle
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
    let published_at = row_text(1, 1).unwrap_or("").to_string();

    let handle = rows
        .and_then(|r| r.first())
        .and_then(|row| row["metadataParts"].as_array())
        .and_then(|parts| parts.first())
        .and_then(|part| part["text"]["commandRuns"].as_array())
        .and_then(|runs| runs.first())
        .and_then(|run| run["onTap"]["innertubeCommand"]["browseEndpoint"]["canonicalBaseUrl"].as_str())
        .and_then(extract_handle_from_url);

    Some(serde_json::json!({
        "id": video_id,
        "title": title,
        "thumbnail": thumbnail,
        "publishedAt": published_at,
        "viewCount": view_count,
        "author": owner_text,
        "handle": handle
    }))
}
