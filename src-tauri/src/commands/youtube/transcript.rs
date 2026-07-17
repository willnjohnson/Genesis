use tauri::command;
use crate::{get_db_path, db};
use crate::youtube::{self, YouTubeClient, ClientType};

/// Fetches a video's transcript from YouTube, retrying transient failures a few times and
/// rejecting bot-detection/rate-limit pages that can slip through as transcript text.
pub(crate) async fn fetch_transcript_with_retries(video_id: &str) -> Result<String, String> {
    let client_android = YouTubeClient::new(ClientType::Android);

    let mut transcript = String::new();
    let mut attempts = 0;
    loop {
        attempts += 1;
        let p = client_android.player(video_id).await?;
        match youtube::fetch_transcript(&p).await {
            Ok(Some(t)) if !t.trim().is_empty() => { transcript = t; break; }
            Ok(_) | Err(_) if attempts < 3 => {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
            _ => break,
        }
    }

    if transcript.is_empty() {
        return Err("Cannot fetch transcript for this video.".to_string());
    }

    // Reject transcript if it contains YouTube's bot-detection / rate-limit text. This catches
    // cases where the error slipped through XML parsing as text nodes.
    let transcript_lower = transcript.to_lowercase();
    if youtube::contains_bot_detection_text(&transcript_lower) {
        return Err("YouTube returned a bot-detection page instead of a transcript. Please wait a moment and try again.".to_string());
    }

    Ok(transcript)
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

    fetch_transcript_with_retries(&video_id).await
}

#[command]
pub async fn save_transcript(app: tauri::AppHandle, video_id: String, transcript: String) -> Result<(), String> {
    let db_path = get_db_path(&app);

    // An empty transcript (e.g. the user cleared the "." placeholder left after transcript
    // text was freed post-summarization) means "re-pull this from YouTube", not "save empty".
    let transcript = if transcript.trim().is_empty() {
        fetch_transcript_with_retries(&video_id).await?
    } else {
        transcript
    };

    db::save_transcript(&db_path, &video_id, &transcript).map_err(|e| e.to_string())
}
