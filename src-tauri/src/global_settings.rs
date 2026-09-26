//! Machine-global display preferences: window resolution and position, fullscreen, video list
//! layout, and navigation orientation. Unlike the rest of `Settings` (per-workspace, stored in each
//! workspace's own SQLite database) these carry over across every workspace opened on this
//! device, stored once as a JSON file under the app's config directory.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

use crate::{db, get_db_path};

const FILE_NAME: &str = "global_settings.json";

/// Serializes read-modify-write cycles: the window-state saver and the Settings commands both
/// rewrite this one file, and must not overwrite each other's fields.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub(crate) struct GlobalDisplaySettings {
    /// "WxH" in logical pixels. Either one of Settings > Display's choices or, once the user has
    /// dragged the window's edge, the custom size they left it at.
    pub resolution: String,
    pub fullscreen: bool,
    pub video_list_mode: String,
    pub navigation_orientation: String,
    /// Where the window's top-left sat when it was last closed (physical pixels on the whole
    /// desktop). None until the window has been moved or resized at least once.
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    /// The window was maximized when it was last closed (its `resolution` is then the size it
    /// restores to, not the maximized one).
    pub maximized: bool,
    /// Windows: closing the main window hides it to the tray icon instead of quitting (see tray.rs).
    pub close_to_tray: bool,
}

impl Default for GlobalDisplaySettings {
    fn default() -> Self {
        Self {
            resolution: "1440x900".to_string(),
            fullscreen: false,
            video_list_mode: "grid".to_string(),
            navigation_orientation: "horizontal".to_string(),
            window_x: None,
            window_y: None,
            maximized: false,
            close_to_tray: false,
        }
    }
}

fn file_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join(FILE_NAME)
}

fn read_or_migrate(app: &tauri::AppHandle) -> GlobalDisplaySettings {
    let path = file_path(app);
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(settings) = serde_json::from_slice(&bytes) {
            return settings;
        }
    }

    let db_path = get_db_path(app);
    let defaults = GlobalDisplaySettings::default();
    let migrated = if db_path.is_empty() {
        defaults
    } else {
        let get = |key: &str, default: &str| -> String {
            db::get_setting(&db_path, key).unwrap_or(None).unwrap_or_else(|| default.to_string())
        };
        GlobalDisplaySettings {
            resolution: get("resolution", &defaults.resolution),
            fullscreen: db::get_setting(&db_path, "fullscreen").unwrap_or(None).map(|s| s == "true").unwrap_or(defaults.fullscreen),
            video_list_mode: get("video_list_mode", &defaults.video_list_mode),
            navigation_orientation: get("navigation_orientation", &defaults.navigation_orientation),
            ..defaults
        }
    };
    write(app, &migrated);
    migrated
}

fn write(app: &tauri::AppHandle, settings: &GlobalDisplaySettings) {
    let path = file_path(app);
    if let Ok(json) = serde_json::to_vec_pretty(settings) {
        let _ = std::fs::write(path, json);
    }
}

/// Reads the global settings file, migrating once from the currently-active workspace's own
/// values the first time this runs (so upgrading doesn't reset an existing user's window size,
/// fullscreen choice, list layout, or nav orientation back to defaults).
pub(crate) fn load(app: &tauri::AppHandle) -> GlobalDisplaySettings {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    read_or_migrate(app)
}

/// Changes some of the settings and saves, without disturbing the fields `change` leaves alone.
pub(crate) fn update(app: &tauri::AppHandle, change: impl FnOnce(&mut GlobalDisplaySettings)) {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut settings = read_or_migrate(app);
    change(&mut settings);
    write(app, &settings);
}
