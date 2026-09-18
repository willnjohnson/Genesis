use crate::{db, get_db_path, Video};
use tauri::command;

const DEFAULT_LIMIT: i64 = 10;
const MAX_LIMIT: i64 = 50;

/// "More like this" for the Sidebar's Similar Videos tab — see db::get_similar_videos for the
/// actual BM25-over-ftsVideos ranking logic.
#[command]
pub async fn get_similar_videos(app: tauri::AppHandle, video_id: String, limit: Option<i64>) -> Result<Vec<Video>, String> {
    let db_path = get_db_path(&app);
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    db::get_similar_videos(&db_path, &video_id, limit).map_err(|e| e.to_string())
}
