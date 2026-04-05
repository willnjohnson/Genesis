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
