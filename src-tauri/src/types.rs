use serde::{Deserialize, Serialize};

/// Parse view count string (e.g., "1.5M", "100K") into i64
pub fn parse_view_count(view_count_str: &str) -> i64 {
    let cleaned = view_count_str
        .replace(" views", "")
        .replace(" view", "")
        .replace(",", "");

    let multiplier: i64 = if cleaned.ends_with('M') || cleaned.ends_with('m') {
        1_000_000
    } else if cleaned.ends_with('K') || cleaned.ends_with('k') {
        1_000
    } else {
        1
    };

    let num_str = cleaned.trim_end_matches(|c| c == 'M' || c == 'm' || c == 'K' || c == 'k');

    num_str.parse::<i64>().unwrap_or(0) * multiplier
}

/// Extract YouTube handle from URL (e.g., "https://www.youtube.com/@handle")
pub fn extract_handle_from_url(url: &str) -> Option<String> {
    if url.contains("@") {
        let parts: Vec<&str> = url.split('@').collect();
        if parts.len() > 1 {
            let handle_part = parts[1];
            let handle = handle_part.trim_end_matches('/');
            if !handle.is_empty() {
                return Some(format!("@{}", handle));
            }
        }
    }
    if url.contains("/c/") {
        let parts: Vec<&str> = url.split("/c/").collect();
        if parts.len() > 1 {
            let handle = parts[1].trim_end_matches('/');
            if !handle.is_empty() {
                return Some(format!("@{}", handle));
            }
        }
    }
    None
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Video {
    pub id: String,
    pub title: String,
    pub thumbnail: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "viewCount")]
    pub view_count: String,
    pub author: Option<String>,
    pub handle: Option<String>,
    pub status: Option<String>,
    #[serde(rename = "dateAdded")]
    pub date_added: Option<String>,
    #[serde(rename = "lengthSeconds")]
    pub length_seconds: Option<i32>,
    #[serde(rename = "videoType")]
    pub video_type: Option<String>,
    pub transcript: Option<String>,
    pub tags: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChannelInfo {
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[serde(rename = "channelName")]
    pub channel_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VideoResponse {
    pub videos: Vec<Video>,
    pub continuation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_count: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySettings {
    pub resolution: String,
    pub fullscreen: bool,
    pub theme: String,
    pub video_list_mode: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DbDetails {
    pub path: String,
    pub size_bytes: u64,
    pub video_count: i64,
    pub history_count: i64,
}
