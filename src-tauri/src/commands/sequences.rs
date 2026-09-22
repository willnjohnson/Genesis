use crate::{db, get_db_path};
use tauri::command;

// Every command runs on a blocking thread: a plain (non-async) command would run on the main thread
// and freeze the window while it waits on the database.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> rusqlite::Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Where `video_id` stands in the sequence of each Drive in `drives` (display paths): its position,
/// how many videos the sequence has, and the first / previous / next video's id.
#[command]
pub async fn get_video_sequences(app: tauri::AppHandle, video_id: String, drives: Vec<String>) -> Result<Vec<db::DriveSequenceState>, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::get_video_sequence_states(&db_path, &video_id, &drives)).await
}

/// The Drives one level beneath `drive` (its sub-drives), for stepping down from the sequence list's breadcrumb.
#[command]
pub async fn get_child_drives(app: tauri::AppHandle, drive: String) -> Result<Vec<db::ChildDrive>, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::get_child_drives(&db_path, &drive)).await
}

/// A Drive's sequence in order, for the list that jumps around it and reorders it.
#[command]
pub async fn get_drive_sequence(app: tauri::AppHandle, drive: String) -> Result<Vec<db::SequenceEntry>, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::get_drive_sequence(&db_path, &drive)).await
}

/// Appends videos to a Drive's sequence. Ones already in it, or not filed at or beneath the Drive,
/// are skipped and counted in the result. Appended in the order given, or, when `sort` is set
/// ("published", "added" or "title"), ordered by that (ascending unless `descending`).
#[command]
pub async fn add_to_drive_sequence(
    app: tauri::AppHandle,
    drive: String,
    video_ids: Vec<String>,
    sort: Option<String>,
    descending: Option<bool>,
) -> Result<db::AddOutcome, String> {
    let db_path = get_db_path(&app);
    blocking(move || match sort {
        Some(sort) => db::add_to_drive_sequence_sorted(&db_path, &drive, &video_ids, &sort, descending.unwrap_or(false)),
        None => db::add_to_drive_sequence(&db_path, &drive, &video_ids),
    })
    .await
}

/// Adds every video the picker would list for `query` (all pages) to the end of a Drive's sequence,
/// ordered by `sort`, except the ones in `excluded`: "select all, then untick". `tail` is for ones
/// unticked and then ticked again: they go after all the rest, in the order given (and are in
/// `excluded` too, so the ordered pass skips them).
#[command]
pub async fn add_matching_to_drive_sequence(
    app: tauri::AppHandle,
    drive: String,
    query: Option<String>,
    sort: String,
    descending: Option<bool>,
    excluded: Vec<String>,
    tail: Option<Vec<String>>,
) -> Result<db::AddOutcome, String> {
    let db_path = get_db_path(&app);
    let query = query.unwrap_or_default();
    let tail = tail.unwrap_or_default();
    blocking(move || {
        db::add_matching_to_drive_sequence(&db_path, &drive, &query, &sort, descending.unwrap_or(false), &excluded, &tail)
    })
    .await
}

/// Videos that could be added to a Drive's sequence: those filed at or beneath the Drive that aren't
/// in it yet, ordered by `sort` ("published" by default, "added" or "title"; ascending unless
/// `descending`), optionally narrowed by `query`. One page plus the count across pages.
#[command]
pub async fn list_drive_videos_for_sequence(
    app: tauri::AppHandle,
    drive: String,
    query: Option<String>,
    sort: Option<String>,
    descending: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<DriveVideoPage, String> {
    let db_path = get_db_path(&app);
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let offset = offset.unwrap_or(0).max(0);
    let query = query.unwrap_or_default();
    let sort = sort.unwrap_or_else(|| "published".to_string());
    let descending = descending.unwrap_or(false);
    let (videos, total) = blocking(move || db::list_drive_videos_for_sequence(&db_path, &drive, &query, &sort, descending, limit, offset)).await?;
    Ok(DriveVideoPage { videos, total })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveVideoPage {
    pub videos: Vec<db::DriveVideo>,
    pub total: i64,
}

#[command]
pub async fn remove_from_drive_sequence(app: tauri::AppHandle, drive: String, video_id: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    blocking(move || db::remove_from_drive_sequence(&db_path, &drive, &video_id)).await
}

/// Puts a Drive's sequence in a new order (the same videos, each once).
#[command]
pub async fn set_drive_sequence_order(app: tauri::AppHandle, drive: String, video_ids: Vec<String>) -> Result<(), String> {
    let db_path = get_db_path(&app);
    blocking(move || db::set_drive_sequence_order(&db_path, &drive, &video_ids)).await
}

#[command]
pub async fn clear_drive_sequence(app: tauri::AppHandle, drive: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    blocking(move || db::clear_drive_sequence(&db_path, &drive)).await
}
