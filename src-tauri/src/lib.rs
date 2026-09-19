use std::path::PathBuf;
use tauri::Manager;
use std::sync::Mutex;
mod http_server;

#[cfg(feature = "genesis")]
const APP_NAME: &str = "Genesis";
#[cfg(not(feature = "genesis"))]
const APP_NAME: &str = "Kinesis";

const VERSION: &str = "0.4.3";

/// "<Workspace name> - Kinesis v0.4.2": the workspace's own name (see db/workspace.rs) leads, so
/// several open workspaces are easy to tell apart.
fn get_window_title(db_path: &str) -> String {
    let workspace = db::get_workspace_labels(db_path)
        .ok()
        .and_then(|mut labels| labels.remove(db::WORKSPACE_NAME_KEY))
        .unwrap_or_else(|| "New Workspace".to_string());
    format!("{} - {} v{}", workspace, APP_NAME, VERSION)
}

/// Re-reads the workspace name and updates the main window's title, after it was renamed or the
/// database was switched.
pub(crate) fn refresh_window_title(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&get_window_title(&get_db_path(app)));
    }
}

mod db;
mod flags;
mod youtube;
mod history;
mod types;
mod ollama;
mod venice;
mod commands;
mod sync;

pub use types::{Video, ChannelInfo, VideoResponse, DisplaySettings, DbDetails};
pub use types::{parse_view_count, extract_handle_from_url};


// â”€â”€â”€ App state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub(crate) struct DbPathState(pub Mutex<Option<String>>);
pub(crate) struct EmbedServerPortState(pub Mutex<Option<u16>>);

// â”€â”€â”€ Config file manager â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub(crate) struct ConfManager;
impl ConfManager {
    fn get_path(app: &tauri::AppHandle) -> PathBuf {
        app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("init.conf")
    }

    pub fn read_attr(app: &tauri::AppHandle, key: &str) -> Option<String> {
        let conf_path = Self::get_path(app);
        if !conf_path.exists() { return None; }
        if let Ok(content) = std::fs::read_to_string(conf_path) {
            for line in content.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    if k.trim() == key { return Some(v.trim().to_string()); }
                }
            }
        }
        None
    }

    pub fn write_attr(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
        let conf_path = Self::get_path(app);
        let mut map = std::collections::HashMap::new();
        if conf_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&conf_path) {
                for line in content.lines() {
                    if let Some((k, v)) = line.split_once(':') {
                        map.insert(k.trim().to_string(), v.trim().to_string());
                    }
                }
            }
        }
        map.insert(key.to_string(), value.to_string());
        let new_content: String = map.iter().map(|(k, v)| format!("{}: {}\n", k, v)).collect();
        let dir = conf_path.parent().unwrap();
        if !dir.exists() { let _ = std::fs::create_dir_all(dir); }
        std::fs::write(conf_path, new_content).map_err(|e| e.to_string())
    }
}

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub(crate) fn ensure_no_ghost_db(path: &str) {
    let p = PathBuf::from(path);
    if p.exists() {
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.len() == 0 { let _ = std::fs::remove_file(&p); }
        }
    }
}

pub(crate) fn get_db_path(app: &tauri::AppHandle) -> String {
    let state = app.state::<DbPathState>();
    let mut guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(ref path) = *guard {
        return path.clone();
    }

    let dir = if let Some(saved_path) = ConfManager::read_attr(app, "db_path") {
        PathBuf::from(saved_path)
    } else {
        app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
    };
    if !dir.exists() { let _ = std::fs::create_dir_all(&dir); }
    let db_file_path = dir.join("kinesis_data.db");

    let path_str = db_file_path.to_string_lossy().to_string();
    *guard = Some(path_str.clone());
    if let Err(e) = db::init_db(&path_str) {
        log::error!("Failed to initialize database at {}: {}", path_str, e);
    }
    path_str
}

#[tauri::command]
fn get_app_info() -> serde_json::Value {
    serde_json::json!({ "name": APP_NAME, "version": VERSION })
}

#[tauri::command]
fn get_embed_server_port(app: tauri::AppHandle) -> Option<u16> {
    let state = app.state::<EmbedServerPortState>();
    let guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard
}

// â”€â”€â”€ App entry point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub fn run() {
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_openurl::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_localhost::Builder::new(1430).build())
        .invoke_handler(tauri::generate_handler![
            // Settings
            commands::get_api_key,
            commands::set_api_key,
            commands::remove_api_key,
            commands::open_db_location,
            commands::select_folder,
            commands::set_db_path_override,
            commands::get_db_details,
            commands::get_display_settings,
            commands::set_display_settings,
            commands::get_setting,
            commands::get_settings,
            commands::get_workspace_labels,
            commands::set_workspace_label,
            commands::set_setting,
            // YouTube
            commands::resolve_channel,
            commands::fetch_videos,
            commands::fetch_channel_videos_v3,
            commands::fetch_view_count,
            commands::fetch_video_info,
            commands::fetch_transcript,
            commands::fetch_video_handle,
            commands::save_video,
            commands::fetch_saved_videos,
            commands::search_library,
            commands::delete_video,
            commands::check_video_exists,
            commands::bulk_save_videos,
            commands::search_videos,
            commands::update_wdbs,
            commands::get_wdbs_tree,
            commands::fetch_videos_by_wdbs,
            commands::get_wdbs_suggestions,
            commands::get_video_wdbs,
            commands::get_video_wdbs_links,
            commands::add_video_wdbs_link,
            commands::remove_video_wdbs_link,
            commands::bulk_update_wdbs,
            commands::set_wdbs_alias,
            commands::set_wdbs_icon,
            // AI / Summarize / Ollama / Venice
            commands::check_ollama,
            commands::check_model_pulled,
            commands::pull_model,
            commands::delete_model,
            commands::install_ollama,
            commands::get_ollama_model,
            commands::set_ollama_model,
            commands::get_ollama_prompt,
            commands::set_ollama_prompt,
            commands::get_chunk_enabled,
            commands::set_chunk_enabled,
            commands::get_chunk_size,
            commands::set_chunk_size,
            commands::get_max_chunks,
            commands::set_max_chunks,
            commands::summarize_transcript,
            commands::save_summary,
            commands::save_tags,
            commands::save_transcript,
            commands::get_summary,
            commands::get_summarized_count,
            commands::get_videos_with_summaries,
            commands::summarize_all_videos,
            commands::get_venice_api_key,
            commands::set_venice_api_key,
            commands::remove_venice_api_key,
            commands::get_venice_prompt,
            commands::set_venice_prompt,
            commands::generate_image,
            commands::search_pixabay,
            commands::upload_to_imgur,
            commands::get_pixabay_api_key,
            commands::set_pixabay_api_key,
            commands::fetch_image_as_data_uri,
            commands::get_custom_prompt,
            commands::get_all_custom_prompts,
            commands::set_custom_prompt,
            commands::delete_custom_prompt,
            commands::get_unique_handles,
            // History
            commands::add_search_history,
            commands::get_search_history,
            commands::clear_history_before_date,
            commands::delete_history_entry,
            commands::clear_all_history,
            // IO
            commands::save_image,
            // Misc
            commands::add_glossary_term,
            commands::get_glossary_terms,
            commands::delete_glossary_term,
            commands::save_glossary_term,
            commands::get_glossary_drive_links,
            commands::get_wdbs_roots,
            commands::get_handle_drives,
            commands::get_wdbs_aliases,
            commands::get_video_by_id,
            commands::get_video_attachments,
            commands::save_video_note,
            commands::pick_attachment_files,
            commands::add_attachments,
            commands::remove_attachment,
            commands::open_attachment,
            commands::save_attachment_as,
            // Biography
            commands::get_biographies,
            commands::get_biography,
            commands::update_biography,
            // Export
            commands::export_to_obsidian,
            // Similar Videos
            commands::get_similar_videos,
            // Sync
            commands::sync_test,
            commands::sync_connect,
            commands::sync_run,
            commands::sync_cancel,
            commands::sync_status,
            commands::sync_set_options,
            commands::sync_disconnect,
            commands::get_locked_settings,
            commands::get_key_status,
            commands::export_sync_pack,
            commands::import_sync_pack,
            commands::select_pack_file,
            commands::select_pack_save_path,
            commands::select_vault_path,
            get_app_info,
            get_embed_server_port,
        ])
        .manage(DbPathState(Mutex::new(None)))
        .manage(EmbedServerPortState(Mutex::new(None)))
        .manage(sync::SyncState::default())
        .setup(move |app| {
            let app_handle = app.handle();
            let db_path = get_db_path(app_handle);

            // Start HTTP server for YouTube embeds
            match http_server::start_server() {
                Ok(port) => {
                    eprintln!("YouTube embed server started on port {}", port);
                    let port_state = app_handle.state::<EmbedServerPortState>();
                    *port_state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(port);
                }
                Err(e) => {
                    log::error!("Failed to start YouTube embed HTTP server; embeds will be unavailable: {}", e);
                }
            }

            // Attachments opened in other apps are temporary copies; start clean.
            commands::clear_attachment_temp();

            // Get saved window settings
            let resolution = db::get_setting(&db_path, "resolution").unwrap_or(None).unwrap_or_else(|| "1440x900".to_string());
            let fullscreen = db::get_setting(&db_path, "fullscreen").unwrap_or(None).map(|s| s == "true").unwrap_or(false);
            
            // Parse resolution
            let (width, height) = {
                let parts: Vec<&str> = resolution.split('x').collect();
                if parts.len() == 2 {
                    if let (Ok(w), Ok(h)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                        (w, h)
                    } else {
                        (1440.0, 900.0)
                    }
                } else {
                    (1440.0, 900.0)
                }
            };
            
            // Load from bundled index.html
            let url = WebviewUrl::App("index.html".into());
            
            // Create the main window
            WebviewWindowBuilder::new(app_handle, "main", url)
                .title(&get_window_title(&db_path))
                .inner_size(width, height)
                .fullscreen(fullscreen)
                .build()?;
            
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // On exit, we can perform cleanup tasks here if needed;
                // Forego this feature for now.
                // let db_path = get_db_path(app_handle);
                // let _ = db::vacuum_db(&db_path);
            }
        });
}
