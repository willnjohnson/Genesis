use tauri::command;
use crate::{get_db_path, history};

#[command]
pub fn add_search_history(app: tauri::AppHandle, query: String) -> Result<(), String> {
    let path = get_db_path(&app);
    // A DB owner can turn history recording off (saveSearchHistory = false).
    if !crate::db::get_flag(&path, "saveSearchHistory", true) {
        return Ok(());
    }
    // Old entries go before a new one is added, per the "clear after" setting.
    let _ = history::apply_retention(&path);
    history::add_history(&path, &query).map_err(|e| e.to_string())
}

#[command]
pub fn get_search_history(app: tauri::AppHandle, limit: Option<i64>) -> Result<Vec<history::HistoryEntry>, String> {
    let path = get_db_path(&app);
    // The list should never show entries the "clear after" setting says are already gone.
    let _ = history::apply_retention(&path);
    history::get_history(&path, limit.unwrap_or(20)).map_err(|e| e.to_string())
}

#[command]
pub fn clear_history_before_date(app: tauri::AppHandle, date: String) -> Result<usize, String> {
    let path = get_db_path(&app);
    history::clear_history_before(&path, &date).map_err(|e| e.to_string())
}

#[command]
pub fn delete_history_entry(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let path = get_db_path(&app);
    history::delete_history_entry(&path, id).map_err(|e| e.to_string())
}

#[command]
pub fn clear_all_history(app: tauri::AppHandle) -> Result<(), String> {
    let path = get_db_path(&app);
    history::clear_all_history(&path).map_err(|e| e.to_string())
}
