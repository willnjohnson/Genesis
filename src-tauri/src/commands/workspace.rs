use std::collections::HashMap;
use tauri::command;
use crate::{db, get_db_path};

/// Every customizable name with defaults filled in (see db/workspace.rs).
#[command]
pub fn get_workspace_labels(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let db_path = get_db_path(&app);
    db::get_workspace_labels(&db_path).map_err(|e| e.to_string())
}

/// Sets one name (an empty value resets it) and returns the value now in effect.
#[command]
pub fn set_workspace_label(app: tauri::AppHandle, key: String, value: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    let saved = db::set_workspace_label(&db_path, &key, &value)?;
    // The workspace name leads the window title.
    if key == db::WORKSPACE_NAME_KEY {
        crate::refresh_window_title(&app);
    }
    Ok(saved)
}
