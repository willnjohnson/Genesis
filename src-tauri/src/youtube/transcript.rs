use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde_json::Value;

pub(crate) const BOT_DETECTION_PHRASES: &[&str] = &[
    "but your computer or network may be sending automated queries",
    "our systems have detected unusual traffic",
    "to protect our users, we can't process your request right now",
    "please solve this captcha",
    "unusual traffic from your computer network",
    "this page checks to see if it's really you sending the requests",
];

pub(crate) fn contains_bot_detection_text(lowercased: &str) -> bool {
    BOT_DETECTION_PHRASES.iter().any(|phrase| lowercased.contains(phrase))
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
            if contains_bot_detection_text(&lower) {
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
