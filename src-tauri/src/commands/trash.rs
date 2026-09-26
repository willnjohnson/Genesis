use tauri::command;

use crate::trash::{self, TrashEntry, TrashKind};
use crate::get_db_path;

fn kind_of(kind: &str) -> Result<TrashKind, String> {
    TrashKind::parse(kind).ok_or_else(|| format!("Unknown trash kind: {kind}"))
}

/// What was deleted from this workspace during this run of the app, newest first ("video" or "glossary").
#[command]
pub fn trash_list(app: tauri::AppHandle, kind: String) -> Result<Vec<TrashEntry>, String> {
    Ok(trash::list(trash::store(&app), &get_db_path(&app), kind_of(&kind)?))
}

/// Puts a deleted item back (with its links). An error says why it couldn't be, and the item stays in the Trash.
#[command]
pub async fn trash_restore(app: tauri::AppHandle, id: u64) -> Result<(), String> {
    let db_path = get_db_path(&app);
    tokio::task::spawn_blocking(move || trash::restore(trash::store(&app), &db_path, id)).await.map_err(|e| e.to_string())?
}

/// Lets one item in the Trash go for good.
#[command]
pub fn trash_discard(app: tauri::AppHandle, id: u64) {
    trash::discard(trash::store(&app), &get_db_path(&app), id);
}

/// Empties the Trash of one kind.
#[command]
pub fn trash_empty(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    trash::empty(trash::store(&app), &get_db_path(&app), kind_of(&kind)?);
    Ok(())
}
