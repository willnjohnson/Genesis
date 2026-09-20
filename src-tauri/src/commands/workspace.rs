use std::collections::HashMap;
use tauri::command;
use crate::{db, get_db_path};

/// Every customizable name with defaults filled in (see db/workspace.rs).
#[command]
pub fn get_workspace_labels(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let db_path = get_db_path(&app);
    db::get_workspace_labels(&db_path).map_err(|e| e.to_string())
}

/// Sets one name (an empty value resets it) and returns the value now in effect. Renaming the
/// workspace also renames its folder, so the two never drift apart; a name another workspace already
/// uses (or one Windows reserves) is refused before anything changes.
#[command]
pub fn set_workspace_label(app: tauri::AppHandle, key: String, value: String) -> Result<String, String> {
    use crate::workspaces as ws;
    let db_path = get_db_path(&app);
    let renaming = key == db::WORKSPACE_NAME_KEY;
    if renaming {
        if let Some(dir) = ws::current_folder(&app) {
            let cleaned = db::normalize_label(&value, db::MAX_WORKSPACE_NAME_LEN)?;
            let target = if cleaned.is_empty() { db::DEFAULT_WORKSPACE_NAME.to_string() } else { cleaned };
            ws::check_rename(&ws::app_root(&app), &dir, &target)?;
        }
    }
    let saved = db::set_workspace_label(&db_path, &key, &value)?;
    // The workspace name leads the window title.
    if renaming {
        if let Some(dir) = ws::current_folder(&app) {
            rename_folder_to(&app, &dir, &saved);
        }
        crate::refresh_window_title(&app);
    }
    Ok(saved)
}

/// Best effort: the name is already saved, so a folder that can't be renamed (something has it open)
/// stays as it is and the launcher keeps showing the name from the database.
fn rename_folder_to(app: &tauri::AppHandle, dir: &std::path::Path, name: &str) {
    use crate::workspaces as ws;
    if dir.file_name().and_then(|n| n.to_str()) == Some(name) {
        return;
    }
    // A Kinpak job has files open in this folder; the name is saved, the folder keeps its old name.
    if ws::ensure_not_busy(app).is_err() {
        log::warn!("Left the workspace folder as it is: a Kinpak export or import is running.");
        return;
    }
    // The lock file sits in the folder being renamed, and Windows won't rename a folder holding an open file.
    ws::release_active(app);
    let renamed = ws::rename_folder(&ws::app_root(app), dir, name);
    let target = renamed.as_ref().map(|p| p.as_path()).unwrap_or(dir);
    if let Err(e) = &renamed {
        log::warn!("{e}");
    }
    if let Err(e) = ws::repoint_active(app, target) {
        log::error!("Couldn't reopen the workspace after renaming it: {e}");
    }
}
