//! The Manage Drive window's commands (see db/drive_manage.rs). Each runs on a blocking thread, like
//! the sequence commands: a rename or merge touches every table that names a Drive.

use crate::{db, get_db_path};
use tauri::command;

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

/// Every Drive, empty ones included, with what's filed at each.
#[command]
pub async fn get_drive_manage_tree(app: tauri::AppHandle) -> Result<Vec<db::ManageNode>, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::get_drive_manage_tree(&db_path)).await
}

/// Every Drive that has a sequence.
#[command]
pub async fn list_drive_sequences(app: tauri::AppHandle) -> Result<Vec<db::SequenceSummary>, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::list_drive_sequences(&db_path)).await
}

/// One Drive's sequence (display path): its size and current first video, for a sequence link's "playlist" card.
/// None when the Drive has no sequence (any more).
#[command]
pub async fn get_sequence_summary(app: tauri::AppHandle, drive: String) -> Result<Option<db::SequenceSummary>, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::get_sequence_summary(&db_path, &drive)).await
}

/// The videos filed at a Drive (and beneath it, with `include_sub`), one row per home or "Also in" link.
#[command]
pub async fn list_drive_members(app: tauri::AppHandle, drive: String, include_sub: bool) -> Result<Vec<db::DriveMember>, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::list_drive_members(&db_path, &drive, include_sub)).await
}

/// Adds a Drive named `name` under `parent` (a display path), or at the top level. Returns its display path.
#[command]
pub async fn create_drive(app: tauri::AppHandle, parent: Option<String>, name: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::create_drive(&db_path, parent.as_deref(), &name)).await
}

/// Renames, moves or merges a Drive (see db::relocate_drive). `dry_run` reports without changing anything.
#[command]
pub async fn relocate_drive(app: tauri::AppHandle, from: String, to: String, dry_run: bool) -> Result<db::RelocateReport, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::relocate_drive(&db_path, &from, &to, dry_run)).await
}

/// Deletes an empty Drive and everything beneath it (see db::delete_drive).
#[command]
pub async fn delete_drive(app: tauri::AppHandle, drive: String, dry_run: bool) -> Result<db::DeleteReport, String> {
    let db_path = get_db_path(&app);
    blocking(move || db::delete_drive(&db_path, &drive, dry_run)).await
}
