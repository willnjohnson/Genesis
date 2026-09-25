use tauri::command;
use crate::{db, get_db_path};

#[command]
pub fn add_glossary_term(app: tauri::AppHandle, term: String, definition: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::add_glossary_term(&db_path, &term, &definition).map_err(|e| e.to_string())
}

#[command]
pub fn get_glossary_terms(app: tauri::AppHandle) -> Result<Vec<db::GlossaryEntry>, String> {
    let db_path = get_db_path(&app);
    db::get_glossary_terms(&db_path).map_err(|e| e.to_string())
}

/// Deletes one entry: the term's rows in each of `drives` ('' = the uncategorized row).
#[command]
pub fn delete_glossary_term(app: tauri::AppHandle, term: String, drives: Vec<String>) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::delete_glossary_group(&db_path, &term, &drives).map_err(|e| e.to_string())
}

/// Adds or edits one definition and the top-level Drives it's filed under (one row per Drive).
/// `original_term`/`original_drives` are the entry's current term and Drives when editing.
#[command]
pub fn save_glossary_term(
    app: tauri::AppHandle,
    original_term: Option<String>,
    original_drives: Option<Vec<String>>,
    term: String,
    definition: String,
    drives: Vec<String>,
) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let original_drives = original_drives.unwrap_or_default();
    let original = original_term.as_deref().map(|t| (t, original_drives.as_slice()));
    db::save_glossary_group(&db_path, original, &term, &definition, &drives).map_err(|e| e.to_string())
}

/// The top-level Drives a term can be filed under. Async on a blocking thread because it's worked
/// out from every video: a plain (non-async) command runs on the main thread and would freeze the
/// window for as long as that takes on a big library.
#[command]
pub async fn get_wdbs_roots(app: tauri::AppHandle) -> Result<Vec<db::WdbsRoot>, String> {
    let db_path = get_db_path(&app);
    tokio::task::spawn_blocking(move || db::get_wdbs_roots(&db_path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
