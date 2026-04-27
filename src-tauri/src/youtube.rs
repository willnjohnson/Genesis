use serde_json::Value;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, CONTENT_TYPE};
use html_escape;

/// Decode HTML entities in a string (e.g., &amp; -> &, &#39; -> ')
fn decode_html(text: &str) -> String {
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

#[allow(dead_code)]
pub fn extract_video_id(url_or_id: &str) -> String {
    if url_or_id.contains("v=") {
        let parts: Vec<&str> = url_or_id.split("v=").collect();
        if parts.len() > 1 {
            return parts[1].split('&').next().unwrap_or("").to_string();
        }
    }
    url_or_id.to_string()
}

pub fn extract_playlist_id(url_or_id: &str) -> String {
    if url_or_id.contains("list=") {
        let parts: Vec<&str> = url_or_id.split("list=").collect();
        if parts.len() > 1 {
            return parts[1].split('&').next().unwrap_or("").to_string();
        }
    }
    url_or_id.to_string()
}

pub async fn extract_channel_id(url_or_handle: &str) -> Result<Option<String>, String> {
    if url_or_handle.starts_with("UC") && url_or_handle.len() == 24 {
        return Ok(Some(url_or_handle.to_string()));
    }

    if url_or_handle.contains("youtube.com/channel/") {
        let parts: Vec<&str> = url_or_handle.split("youtube.com/channel/").collect();
        if parts.len() > 1 {
            return Ok(Some(parts[1].split('/').next().unwrap_or("").split('?').next().unwrap_or("").to_string()));
        }
    }

    let mut handle = url_or_handle.to_string();
    if url_or_handle.contains("youtube.com/@") {
        let parts: Vec<&str> = url_or_handle.split("youtube.com/@").collect();
        if parts.len() > 1 {
            handle = parts[1].split('/').next().unwrap_or("").split('?').next().unwrap_or("").to_string();
        }
    } else if url_or_handle.starts_with('@') {
        handle = url_or_handle[1..].to_string();
    } else if url_or_handle.contains("youtube.com/c/") {
        let parts: Vec<&str> = url_or_handle.split("youtube.com/c/").collect();
        if parts.len() > 1 {
            handle = parts[1].split('/').next().unwrap_or("").split('?').next().unwrap_or("").to_string();
        }
    }

    let client = reqwest::Client::new();
    let url = format!("https://www.youtube.com/@{}", handle);
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"));
    headers.insert(reqwest::header::ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"));
    headers.insert(reqwest::header::ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));

    let res = client.get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = res.text().await.map_err(|e| e.to_string())?;
    
    // Try multiple regex patterns for channel ID, prioritizing canonical and meta tags
    let patterns = [
        r#"<meta itemprop="identifier" content="(UC[^"]+)">"#,
        r#"link rel="canonical" href="https://www.youtube.com/channel/(UC[^"]+)""#,
        r#"meta property="og:url" content="https://www.youtube.com/channel/(UC[^"]+)""#,
        r#""channelId":"(UC[^"]+)""#,
    ];

    for pattern in patterns {
        let re = regex::Regex::new(pattern).unwrap();
        if let Some(caps) = re.captures(&text) {
            return Ok(Some(caps.get(1).unwrap().as_str().to_string()));
        }
    }

    Ok(None)
}

pub fn channel_id_to_uploads_playlist(channel_id: &str) -> String {
    if channel_id.starts_with("UC") {
        return format!("UU{}", &channel_id[2..]);
    }
    channel_id.to_string()
}

/// Extract YouTube handle from text like "Channel Name (@handle)"
fn extract_handle_from_text(text: &str) -> Option<String> {
    if let Some(at_pos) = text.find("(@") {
        let handle_part = &text[at_pos..];
        // Find the end of the handle (could be at end of string or before another parenthesis)
        let end = handle_part.find(')').unwrap_or(handle_part.len());
        let handle = &handle_part[1..end]; // Skip the '@' character
        if !handle.is_empty() {
            return Some(format!("@{}", handle));
        }
    }
    None
}

pub async fn extract_handle_from_channel_id(channel_id: &str) -> Result<Option<String>, String> {
    if !channel_id.starts_with("UC") || channel_id.len() != 24 {
        return Ok(None);
    }
    
    let client = reqwest::Client::new();
    let url = format!("https://www.youtube.com/channel/{}", channel_id);
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"));
    headers.insert(reqwest::header::ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"));
    headers.insert(reqwest::header::ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));

    let res = client.get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = res.text().await.map_err(|e| e.to_string())?;
    
    // Try to find @handle in the page
    // Pattern 1: canonical URL with @handle
    let canonical_pattern = r#"link rel="canonical" href="https://www.youtube.com/(@[^""]+)"#;
    let re = regex::Regex::new(canonical_pattern).unwrap();
    if let Some(caps) = re.captures(&text) {
        return Ok(Some(caps.get(1).unwrap().as_str().to_string()));
    }
    
    // Pattern 2: og:url with @handle
    let og_pattern = r#"meta property="og:url" content="https://www.youtube.com/(@[^""]+)"#;
    let re = regex::Regex::new(og_pattern).unwrap();
    if let Some(caps) = re.captures(&text) {
        return Ok(Some(caps.get(1).unwrap().as_str().to_string()));
    }
    
    // Pattern 3: external_id in script
    let script_pattern = r#""externalId":"(UC[^"]+)"#;
    let re = regex::Regex::new(script_pattern).unwrap();
    if re.is_match(&text) {
        // This is the channel ID, not handle - return None since we couldn't find handle
        return Ok(None);
    }
    
    Ok(None)
}

pub async fn fetch_transcript(player_json: &Value) -> Result<Option<String>, String> {
    let captions = &player_json["captions"];
    let mut caption_tracks = captions["playerCaptionsTracklistRenderer"]["captionTracks"].as_array();
    
    // Fallback if the above path is missing
    if caption_tracks.is_none() {
        caption_tracks = captions["captionTracks"].as_array();
    }
    
    if let Some(tracks) = caption_tracks {
        let track = tracks.iter()
            .find(|t| t["languageCode"].as_str().unwrap_or("").starts_with("en"))
            .or_else(|| tracks.first());

        if let Some(track) = track {
            let base_url = track["baseUrl"].as_str().ok_or("No base URL for transcript")?;
            
            let mut headers = HeaderMap::new();
            headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"));
            
            let client = reqwest::Client::new();
            let res = client.get(base_url)
                .headers(headers)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let text = res.text().await.map_err(|e| e.to_string())?;

            // Detect YouTube's bot-check / rate-limit error pages.
            // These are returned as HTML/plain-text instead of XML/JSON and must
            // never be stored as transcript content.
            let lower = text.to_lowercase();
            let bot_phrases = [
                "but your computer or network may be sending automated queries",
                "our systems have detected unusual traffic",
                "to protect our users, we can't process your request right now",
                "please solve this captcha",
                "unusual traffic from your computer network",
                "this page checks to see if it's really you sending the requests",
            ];
            if bot_phrases.iter().any(|phrase| lower.contains(phrase)) {
                return Err("YouTube rate-limit or bot-detection triggered; transcript unavailable right now.".to_string());
            }

            // Also reject obvious HTML error pages (no valid XML/JSON transcript starts with <!DOCTYPE or <html)
            let trimmed = text.trim_start();
            if trimmed.starts_with("<!") || trimmed.to_lowercase().starts_with("<html") {
                return Err("YouTube returned an HTML page instead of a transcript; the request may have been blocked.".to_string());
            }

            if text.trim().starts_with('{') {
                let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                let mut lines: Vec<String> = Vec::new();
                
                if let Some(events) = data["events"].as_array() {
                    for event in events {
                        if let Some(segs) = event["segs"].as_array() {
                            let line: String = segs.iter()
                                .map(|s| s["utf8"].as_str().unwrap_or(""))
                                .collect::<Vec<_>>()
                                .join("");
                            if !line.trim().is_empty() {
                                lines.push(line);
                            }
                        }
                    }
                }
                
                if lines.is_empty() {
                    collect_transcript_lines(&data, &mut lines);
                }
                
                return Ok(Some(lines.join("\n")));
            } else {
                return parse_xml_transcript(&text);
            }
        }
    }
    Ok(None)
}

fn collect_transcript_lines(val: &Value, lines: &mut Vec<String>) {
    if let Some(obj) = val.as_object() {
        if let Some(text) = obj.get("text").and_then(|t| t.as_str()) {
            lines.push(text.to_string());
        } else if let Some(utf8) = obj.get("utf8").and_then(|t| t.as_str()) {
             lines.push(utf8.to_string());
        }
        
        if let Some(st) = obj.get("simpleText").and_then(|t| t.as_str()) {
            lines.push(st.to_string());
        }

        for v in obj.values() {
            collect_transcript_lines(v, lines);
        }
    } else if let Some(arr) = val.as_array() {
        for v in arr {
            collect_transcript_lines(v, lines);
        }
    }
}

fn parse_xml_transcript(xml: &str) -> Result<Option<String>, String> {
    let mut lines = Vec::new();
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut current_line = Vec::new();
    let mut in_p = false;
    let mut in_s = false;
    let mut in_text = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(ref e)) => {
                match e.name().as_ref() {
                    b"p" => {
                        in_p = true;
                        current_line.clear();
                    }
                    b"s" => in_s = true,
                    b"text" => {
                        in_text = true;
                        current_line.clear();
                    }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::Text(e)) => {
                if in_s || in_text || (in_p && !xml.contains("</s>")) { 
                     let text = e.unescape().map_err(|e| e.to_string())?;
                     current_line.push(text.into_owned());
                }
            }
            Ok(quick_xml::events::Event::End(ref e)) => {
                match e.name().as_ref() {
                    b"p" => {
                        in_p = false;
                        if !current_line.is_empty() {
                            lines.push(current_line.iter().map(|s| s.trim()).collect::<Vec<_>>().join(" "));
                        }
                    }
                    b"s" => in_s = false,
                    b"text" => {
                        in_text = false;
                        if !current_line.is_empty() {
                            lines.push(current_line.join(" "));
                        }
                    }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
        buf.clear();
    }

    if lines.is_empty() {
        Ok(None)
    } else {
        Ok(Some(lines.join("\n")))
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
