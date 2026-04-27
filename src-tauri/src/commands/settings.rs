use tauri::command;
use crate::{get_db_path, db, ConfManager, DbPathState};
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
pub async fn select_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().clone();
    tauri_plugin_dialog::FileDialogBuilder::new(dialog).pick_folder(move |f| {
        let _ = tx.send(f.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}

#[command]
pub fn set_db_path_override(app: tauri::AppHandle, folder_path: String) -> Result<String, String> {
    use tauri::Manager;
    let state = app.state::<DbPathState>();
    let mut guard = state.0.lock().unwrap();

    let old_db_path = if let Some(ref path) = *guard {
        path.clone()
    } else {
        get_db_path(&app)
    };

    let folder = std::path::PathBuf::from(&folder_path);
    if !folder.exists() {
        std::fs::create_dir_all(&folder).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let db_full_path = folder.join("kinesis_data.db").to_string_lossy().to_string();
    if old_db_path == db_full_path {
        return Ok(db_full_path);
    }

    let old_path_buf = std::path::PathBuf::from(&old_db_path);
    if old_path_buf.exists() {
        std::fs::copy(&old_db_path, &db_full_path)
            .map_err(|e| format!("Failed to migrate database: {}", e))?;
    }

    ConfManager::write_attr(&app, "db_path", &folder_path)?;
    *guard = Some(db_full_path.clone());
    db::init_db(&db_full_path).map_err(|e| format!("Failed to initialize DB at new location: {}", e))?;

    if old_path_buf.exists() {
        let _ = std::fs::remove_file(&old_db_path);
        crate::ensure_no_ghost_db(&old_db_path);
    }

    Ok(db_full_path)
}

#[command]
pub fn get_db_details(app: tauri::AppHandle) -> Result<DbDetails, String> {
    let path = get_db_path(&app);
    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let video_count = db::get_db_stats(&path).map_err(|e| e.to_string())?;
    let history_count = db::get_history_stats(&path).map_err(|e| e.to_string())?;
    Ok(DbDetails { path, size_bytes, video_count, history_count })
}

#[command]
pub fn get_display_settings(app: tauri::AppHandle) -> Result<DisplaySettings, String> {
    let db_path = get_db_path(&app);
    let get = |key: &str, default: &str| -> String {
        db::get_setting(&db_path, key).unwrap_or(None).unwrap_or_else(|| default.to_string())
    };
    Ok(DisplaySettings {
        resolution: get("resolution", "1440x900"),
        fullscreen: db::get_setting(&db_path, "fullscreen").unwrap_or(None).map(|s| s == "true").unwrap_or(false),
        theme: get("theme", "dark"),
        video_list_mode: get("video_list_mode", "grid"),
        navigation_orientation: get("navigation_orientation", "horizontal"),
    })
}

#[command]
pub fn set_display_settings(app: tauri::AppHandle, settings: DisplaySettings) -> Result<(), String> {
    use tauri::Manager;
    let db_path = get_db_path(&app);

    let current_resolution = db::get_setting(&db_path, "resolution")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "1440x900".to_string());
    let resolution_changed = current_resolution != settings.resolution;

    db::set_setting(&db_path, "resolution", &settings.resolution).map_err(|e| e.to_string())?;
    db::set_setting(&db_path, "fullscreen", &settings.fullscreen.to_string()).map_err(|e| e.to_string())?;
    db::set_setting(&db_path, "theme", &settings.theme).map_err(|e| e.to_string())?;
    db::set_setting(&db_path, "video_list_mode", &settings.video_list_mode).map_err(|e| e.to_string())?;
    db::set_setting(&db_path, "navigation_orientation", &settings.navigation_orientation).map_err(|e| e.to_string())?;

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
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, &key).map_err(|e| e.to_string())
}

#[command]
pub async fn set_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, &key, &value).map_err(|e| e.to_string())
}
