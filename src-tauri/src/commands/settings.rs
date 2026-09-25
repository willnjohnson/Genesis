use tauri::command;
use crate::{get_db_path, db};
use crate::types::{DbDetails, DisplaySettings};

#[command]
pub fn get_api_key(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, "api_key").map_err(|e| e.to_string())
}

#[command]
pub fn set_api_key(app: tauri::AppHandle, api_key: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "api_key", &api_key).map_err(|e| e.to_string())
}

#[command]
pub fn remove_api_key(app: tauri::AppHandle) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::delete_setting(&db_path, "api_key").map_err(|e| e.to_string())
}

#[command]
pub fn open_db_location(app: tauri::AppHandle) -> Result<(), String> {
    let db_path = get_db_path(&app);
    if let Some(dir) = std::path::PathBuf::from(&db_path).parent() {
        #[cfg(target_os = "windows")]
        let _ = std::process::Command::new("explorer").arg(dir).spawn();
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("open").arg(dir).spawn();
        #[cfg(target_os = "linux")]
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
    Ok(())
}

#[command]
pub async fn select_folder(app: tauri::AppHandle, start_dir: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().clone();
    let mut builder = tauri_plugin_dialog::FileDialogBuilder::new(dialog);
    // Open where the caller last was, when that folder still exists.
    if let Some(dir) = start_dir.filter(|d| std::path::Path::new(d).is_dir()) {
        builder = builder.set_directory(dir);
    }
    builder.pick_folder(move |f| {
        let _ = tx.send(f.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}

/// Moves the open workspace's database to `folder_path` (an external drive, say) and records the new
/// place in the workspace's own `init.conf`. Refuses to touch a folder that already holds a Kinesis
/// database: overwriting one silently is how someone loses a library.
#[command]
pub fn set_db_path_override(
    app: tauri::AppHandle,
    sync: tauri::State<'_, crate::sync::SyncState>,
    folder_path: String,
) -> Result<String, String> {
    use crate::workspaces as ws;
    if sync.is_running() {
        return Err("A sync is running. Cancel it first, then move the database.".into());
    }
    ws::ensure_not_busy(&app)?;
    let ws_dir = ws::current_folder(&app).ok_or_else(|| "No workspace is open.".to_string())?;
    let old_db = std::path::PathBuf::from(get_db_path(&app));
    let folder = std::path::PathBuf::from(&folder_path);
    let new_db = folder.join(ws::DB_FILE);

    if folder.join(ws::DB_FILE).exists() && old_db.exists() && same_file(&old_db, &new_db) {
        return Ok(new_db.to_string_lossy().to_string());
    }
    if new_db.exists() {
        return Err(format!(
            "There's already a Kinesis database in {}. Choose an empty folder, or open that one as its own workspace.",
            folder.display()
        ));
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("Failed to create directory: {}", e))?;

    // Copy, check, switch, and only then delete the original: at no point is the only copy at risk.
    let old_conf = ws::read_conf(&ws_dir);
    if let Err(e) = std::fs::copy(&old_db, &new_db) {
        let _ = std::fs::remove_file(&new_db);
        return Err(format!("Failed to move the database: {e}"));
    }
    let same_size = std::fs::metadata(&old_db).ok().map(|m| m.len()) == std::fs::metadata(&new_db).ok().map(|m| m.len());
    if !same_size {
        let _ = std::fs::remove_file(&new_db);
        return Err("The copy of the database came out a different size, so nothing was changed.".into());
    }
    let rollback = |e: String| {
        let _ = ws::write_conf(&ws_dir, &old_conf);
        let _ = ws::repoint_active(&app, &ws_dir);
        let _ = std::fs::remove_file(&new_db);
        e
    };
    ws::set_data_dir(&ws_dir, &folder).map_err(&rollback)?;
    ws::repoint_active(&app, &ws_dir).map_err(&rollback)?;
    let db_full_path = new_db.to_string_lossy().to_string();
    db::init_db(&db_full_path).map_err(|e| rollback(format!("Failed to initialize DB at new location: {}", e)))?;
    // The new database has its own workspace name.
    crate::refresh_window_title(&app);

    let _ = std::fs::remove_file(&old_db);
    if let Some(old_dir) = old_db.parent() {
        let _ = std::fs::remove_file(old_dir.join(".kinesis.lock"));
    }
    crate::ensure_no_ghost_db(&old_db.to_string_lossy());
    Ok(db_full_path)
}

fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[command]
pub fn get_db_details(app: tauri::AppHandle) -> Result<DbDetails, String> {
    let path = get_db_path(&app);
    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let video_count = db::get_db_stats(&path).map_err(|e| e.to_string())?;
    let history_count = db::get_history_stats(&path).map_err(|e| e.to_string())?;
    let stats = db::get_library_stats(&path).map_err(|e| e.to_string())?;
    Ok(DbDetails {
        path,
        size_bytes,
        video_count,
        history_count,
        channel_count: stats.channel_count,
        drive_count: stats.drive_count,
        glossary_count: stats.glossary_count,
        quick_tag_count: stats.quick_tag_count,
        biography_count: stats.biography_count,
        attachment_count: stats.attachment_count,
        attachment_bytes: stats.attachment_bytes,
    })
}

#[command]
pub fn get_display_settings(app: tauri::AppHandle) -> Result<DisplaySettings, String> {
    let db_path = get_db_path(&app);
    let global = crate::global_settings::load(&app);
    Ok(DisplaySettings {
        resolution: global.resolution,
        fullscreen: global.fullscreen,
        theme: db::get_setting(&db_path, "theme").unwrap_or(None).unwrap_or_else(|| "dark".to_string()),
        video_list_mode: global.video_list_mode,
        navigation_orientation: global.navigation_orientation,
    })
}

#[command]
pub fn set_display_settings(app: tauri::AppHandle, settings: DisplaySettings) -> Result<(), String> {
    use tauri::Manager;
    let db_path = get_db_path(&app);

    let current = crate::global_settings::load(&app);
    let resolution_changed = current.resolution != settings.resolution;

    // update(), not a whole-struct save: the window's remembered position isn't part of what the
    // Settings screen edits, and must survive this write.
    crate::global_settings::update(&app, |g| {
        g.resolution = settings.resolution.clone();
        g.fullscreen = settings.fullscreen;
        g.video_list_mode = settings.video_list_mode.clone();
        g.navigation_orientation = settings.navigation_orientation.clone();
    });
    db::set_setting(&db_path, "theme", &settings.theme).map_err(|e| e.to_string())?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_fullscreen(settings.fullscreen);
        if !settings.fullscreen && resolution_changed {
            let parts: Vec<&str> = settings.resolution.split('x').collect();
            if parts.len() == 2 {
                if let (Ok(w), Ok(h)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                }
            }
        }
    }
    Ok(())
}

#[command]
pub async fn get_setting(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    // The sync access token is write-only from the webview's point of view.
    if key == crate::sync::KEY_TOKEN {
        return Err("This setting can't be read.".to_string());
    }
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, &key).map_err(|e| e.to_string())
}

#[command]
pub async fn set_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, &key, &value).map_err(|e| e.to_string())
}

/// Several settings at once, for the UI's feature flags (the sync policy is applied).
#[command]
pub async fn get_settings(app: tauri::AppHandle, keys: Vec<String>) -> Result<std::collections::HashMap<String, Option<String>>, String> {
    let db_path = get_db_path(&app);
    // The sync token is write-only from the webview, like in get_setting.
    let keys: Vec<String> = keys.into_iter().filter(|k| k != crate::sync::KEY_TOKEN).collect();
    db::get_settings(&db_path, &keys).map_err(|e| e.to_string())
}
