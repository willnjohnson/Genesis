use tauri::command;
use crate::{db, get_db_path};

#[command]
pub fn add_glossary_term(app: tauri::AppHandle, term: String, definition: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::add_glossary_term(&db_path, &term, &definition).map_err(|e| e.to_string())
}

#[command]
pub fn get_glossary_terms(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let db_path = get_db_path(&app);
    db::get_glossary_terms(&db_path).map_err(|e| e.to_string())
}

#[command]
pub fn delete_glossary_term(app: tauri::AppHandle, term: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::delete_glossary_term(&db_path, &term).map_err(|e| e.to_string())
}

/// Adds or edits a term and the top-level Drives it's filed under, in one step. `original_term` is
/// the term's current name when editing (a different `term` renames it).
#[command]
pub fn save_glossary_term(
    app: tauri::AppHandle,
    original_term: Option<String>,
    term: String,
    definition: String,
    drives: Vec<String>,
) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::save_glossary_term(&db_path, original_term.as_deref(), &term, &definition, &drives).map_err(|e| e.to_string())
}

/// Every (term, drive root) assignment, e.g. ("Halving", ":CRYPTO").
#[command]
pub fn get_glossary_drive_links(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let db_path = get_db_path(&app);
    db::get_glossary_drive_links(&db_path).map_err(|e| e.to_string())
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
