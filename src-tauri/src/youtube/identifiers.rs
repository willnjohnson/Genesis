use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};

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
pub(crate) fn extract_handle_from_text(text: &str) -> Option<String> {
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
