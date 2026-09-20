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

fn caption_tracks(player_json: &Value) -> Option<&Vec<Value>> {
    let captions = &player_json["captions"];
    captions["playerCaptionsTracklistRenderer"]["captionTracks"]
        .as_array()
        // Fallback if the above path is missing
        .or_else(|| captions["captionTracks"].as_array())
}

/// Whether the video has any caption tracks at all (a video without any has no transcript to fetch,
/// as opposed to one whose transcript couldn't be fetched right now).
pub fn has_caption_tracks(player_json: &Value) -> bool {
    caption_tracks(player_json).is_some_and(|t| !t.is_empty())
}

/// Why YouTube won't play (or describe) this video, when it won't: private, removed, age-restricted,
/// not available in the region. `None` when it's fine.
pub fn playability_problem(player_json: &Value) -> Option<String> {
    let status = &player_json["playabilityStatus"];
    match status["status"].as_str() {
        Some("OK") | None => None,
        Some(other) => Some(
            status["reason"].as_str().map(str::to_string).unwrap_or_else(|| format!("its status is {other}")),
        ),
    }
}

/// The URL to read a transcript from. English is preferred: the uploader's own captions first, then
/// YouTube's automatic ones. A video with neither gets the first track that YouTube can translate,
/// asked for in English; failing that, whatever the first track is.
pub fn pick_track_url(tracks: &[Value]) -> Option<String> {
    let english = |t: &&Value| t["languageCode"].as_str().unwrap_or("").starts_with("en");
    let automatic = |t: &&Value| t["kind"].as_str() == Some("asr");
    let url = |t: &Value| t["baseUrl"].as_str().map(str::to_string);

    if let Some(t) = tracks.iter().filter(english).find(|t| !automatic(t)) {
        return url(t);
    }
    if let Some(t) = tracks.iter().find(english) {
        return url(t);
    }
    if let Some(t) = tracks.iter().find(|t| t["isTranslatable"].as_bool() == Some(true)) {
        return url(t).map(|u| format!("{u}&tlang=en"));
    }
    tracks.first().and_then(url)
}

pub async fn fetch_transcript(player_json: &Value) -> Result<Option<String>, String> {
    if let Some(tracks) = caption_tracks(player_json) {
        if let Some(base_url) = pick_track_url(tracks) {
            let base_url = base_url.as_str();

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

            // An empty body is YouTube declining to serve this track to this client, not an empty video.
            if text.trim().is_empty() {
                return Err("YouTube returned an empty caption file.".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn track(lang: &str, kind: Option<&str>, translatable: bool) -> Value {
        let mut t = json!({"languageCode": lang, "baseUrl": format!("https://x/{lang}{}", kind.unwrap_or("")), "isTranslatable": translatable});
        if let Some(k) = kind {
            t["kind"] = json!(k);
        }
        t
    }

    #[test]
    fn the_uploaders_english_captions_beat_automatic_ones_and_other_languages() {
        let tracks = vec![track("ar", None, true), track("en", Some("asr"), true), track("en", None, true), track("fr", None, true)];
        assert_eq!(pick_track_url(&tracks).as_deref(), Some("https://x/en"));
        // A regional English counts as English.
        let tracks = vec![track("de", None, true), track("en-GB", None, true)];
        assert_eq!(pick_track_url(&tracks).as_deref(), Some("https://x/en-GB"));
    }

    #[test]
    fn automatic_english_is_used_when_that_is_all_there_is() {
        let tracks = vec![track("es", None, true), track("en", Some("asr"), true)];
        assert_eq!(pick_track_url(&tracks).as_deref(), Some("https://x/enasr"));
    }

    #[test]
    fn a_video_without_english_gets_a_translation_when_it_can_and_its_own_language_when_not() {
        let tracks = vec![track("ja", None, true), track("ko", None, true)];
        assert_eq!(pick_track_url(&tracks).as_deref(), Some("https://x/ja&tlang=en"));
        let tracks = vec![track("ja", None, false)];
        assert_eq!(pick_track_url(&tracks).as_deref(), Some("https://x/ja"));
        assert_eq!(pick_track_url(&[]), None);
    }

    #[test]
    fn captionless_and_unplayable_videos_are_told_apart() {
        let none = json!({"playabilityStatus": {"status": "OK"}});
        assert!(!has_caption_tracks(&none));
        assert_eq!(playability_problem(&none), None);
        let with = json!({"captions": {"playerCaptionsTracklistRenderer": {"captionTracks": [track("en", None, true)]}}});
        assert!(has_caption_tracks(&with));
        let private = json!({"playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "This video is private"}});
        assert_eq!(playability_problem(&private).as_deref(), Some("This video is private"));
        let odd = json!({"playabilityStatus": {"status": "ERROR"}});
        assert_eq!(playability_problem(&odd).as_deref(), Some("its status is ERROR"));
    }

    #[test]
    fn a_youtube_caption_file_is_read_line_by_line() {
        // The shape YouTube serves ("format 3"): one <p> per caption line.
        let xml = "<?xml version=\"1.0\" encoding=\"utf-8\" ?><timedtext format=\"3\"><body>            <p t=\"0\" d=\"2000\">So in college, I was a government major,</p>            <p t=\"2000\" d=\"2500\">which means I had to write a lot of papers.</p>            </body></timedtext>";
        let text = parse_xml_transcript(xml).unwrap().unwrap();
        assert_eq!(text, "So in college, I was a government major,
which means I had to write a lot of papers.");
    }
}
