use tauri::command;
use crate::{get_db_path, db};
use crate::youtube::{self, YouTubeClient, ClientType};

/// Fetches a video's transcript from YouTube, with no API key: it comes from the video's own caption
/// tracks, which YouTube serves to anyone. It asks as the Android app first and, if that gets nowhere,
/// as the iOS app, retrying a transient failure once, and rejects bot-detection/rate-limit pages that
/// can slip through as transcript text. When there's no transcript it says why: the video has no
/// captions, YouTube won't play it, or YouTube is limiting requests right now.
pub(crate) async fn fetch_transcript_with_retries(video_id: &str) -> Result<String, String> {
    let mut saw_captionless_video = false;
    let mut unplayable: Option<String> = None;
    let mut blocked: Option<String> = None;

    for client_type in [ClientType::Android, ClientType::Ios] {
        let client = YouTubeClient::new(client_type);
        for attempt in 1..=2 {
            let player = match client.player(video_id).await {
                Ok(p) => p,
                Err(e) => {
                    blocked = Some(e);
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    continue;
                }
            };
            // A video YouTube won't play won't hand out captions either; asking again changes nothing.
            if let Some(reason) = youtube::playability_problem(&player) {
                unplayable = Some(reason);
                break;
            }
            match youtube::fetch_transcript(&player).await {
                Ok(Some(t)) if !t.trim().is_empty() => {
                    // Bot-detection / rate-limit text can arrive as if it were a transcript.
                    if youtube::contains_bot_detection_text(&t.to_lowercase()) {
                        blocked = Some("YouTube returned a bot-detection page instead of a transcript.".to_string());
                        break;
                    }
                    return Ok(t);
                }
                Ok(_) if !youtube::has_caption_tracks(&player) => {
                    saw_captionless_video = true;
                    break;
                }
                Ok(_) => {}
                Err(e) => blocked = Some(e),
            }
            if attempt < 2 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
    }

    Err(if saw_captionless_video {
        "This video has no captions, so there's no transcript to get.".to_string()
    } else if let Some(reason) = unplayable {
        format!("YouTube won't provide this video's transcript: {reason}.")
    } else if let Some(problem) = blocked {
        format!("Couldn't get the transcript right now. {problem}")
    } else {
        "Cannot fetch transcript for this video.".to_string()
    })
}

#[command]
pub async fn fetch_transcript(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    let video_id = video_id.trim().to_string();
    let db_path = get_db_path(&app);

    if let Ok(Some(t)) = db::get_transcript(&db_path, &video_id) {
        if !t.trim().is_empty() { return Ok(t); }
    }

    // No API key needed: a transcript comes from the video's own caption tracks, not the Data API.
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

#[cfg(test)]
mod live_tests {
    use super::*;

    /// `cargo test --lib live_ -- --ignored --nocapture` asks YouTube. No API key is involved anywhere.
    #[tokio::test]
    #[ignore]
    async fn live_transcript_without_an_api_key() {
        // A TED talk with English captions.
        let text = fetch_transcript_with_retries("arj7oStGLkU").await.expect("a transcript");
        println!("{} characters; starts: {}", text.len(), text.chars().take(120).collect::<String>().replace('\n', " / "));
        assert!(text.len() > 5_000);
        assert!(text.to_lowercase().contains("procrastinat"));
        // Not an HTML error page or bot-check text.
        assert!(!crate::youtube::contains_bot_detection_text(&text.to_lowercase()));
    }
}
