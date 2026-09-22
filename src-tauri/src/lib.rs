use std::path::PathBuf;
use tauri::Manager;
use std::sync::Mutex;
mod http_server;

#[cfg(feature = "genesis")]
const APP_NAME: &str = "Genesis";
#[cfg(not(feature = "genesis"))]
const APP_NAME: &str = "Kinesis";

const VERSION: &str = "0.4.5";

/// The smallest the window can be dragged to (logical pixels). The width matches the smallest size
/// offered under Settings > Display (600x600), so every choice there still fits; below this the header
/// and the workspace screen start to overlap themselves.
const MIN_WINDOW_WIDTH: f64 = 600.0;
const MIN_WINDOW_HEIGHT: f64 = 500.0;

/// Windows and macOS: "<Workspace name> - Kinesis v0.4.2", the workspace's own name (see
/// db/workspace.rs) leading so several open workspaces are easy to tell apart. Linux: plain
/// "Kinesis v0.4.2", because the title didn't follow a rename there. Also plain while no
/// workspace is open (`db_path` is empty: the launcher is showing).
fn get_window_title(db_path: &str) -> String {
    if cfg!(target_os = "linux") || db_path.is_empty() {
        return format!("{} v{}", APP_NAME, VERSION);
    }
    let workspace = db::get_workspace_labels(db_path)
        .ok()
        .and_then(|mut labels| labels.remove(db::WORKSPACE_NAME_KEY))
        .unwrap_or_else(|| "New Workspace".to_string());
    format!("{} - {} v{}", workspace, APP_NAME, VERSION)
}

/// Re-reads the workspace name and updates the main window's title, after it was renamed or the
/// database was switched. Nothing to update on Linux, where the title never shows the name.
pub(crate) fn refresh_window_title(app: &tauri::AppHandle) {
    use tauri::Manager;
    if cfg!(target_os = "linux") {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.set_title(&get_window_title(&get_db_path(app))) {
            log::warn!("Couldn't update the window title: {}", e);
        }
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
mod workspaces;
mod kinpak;
mod drive_scope;

pub use types::{Video, ChannelInfo, VideoResponse, DisplaySettings, DbDetails};
pub use types::{parse_view_count, extract_handle_from_url};


// â”€â”€â”€ App state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub(crate) struct DbPathState(pub Mutex<Option<String>>);
pub(crate) struct EmbedServerPortState(pub Mutex<Option<u16>>);

// Which workspace is open, and why none was opened at startup, live in workspaces.rs.
pub(crate) use workspaces::{ActiveWorkspaceState, StartupNoticeState};

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub(crate) fn ensure_no_ghost_db(path: &str) {
    let p = PathBuf::from(path);
    if p.exists() {
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.len() == 0 { let _ = std::fs::remove_file(&p); }
        }
    }
}

/// The open workspace's database file, or an empty string while none is open (the launcher is
/// showing). Never creates anything: SQLite treats an empty path as a private throwaway database, so
/// a command that slips through before a workspace is chosen fails with "no such table" instead of
/// writing a stray file. Workspaces are opened in workspaces.rs.
pub(crate) fn get_db_path(app: &tauri::AppHandle) -> String {
    let state = app.state::<DbPathState>();
    let guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.clone().unwrap_or_default()
}

/// The window size and fullscreen choice saved in a workspace's settings (defaults when there's no
/// workspace open yet or the value is unreadable).
fn window_prefs(db_path: &str) -> (f64, f64, bool) {
    if db_path.is_empty() {
        return (1440.0, 900.0, false);
    }
    let resolution = db::get_setting(db_path, "resolution").unwrap_or(None).unwrap_or_else(|| "1440x900".to_string());
    let fullscreen = db::get_setting(db_path, "fullscreen").unwrap_or(None).map(|s| s == "true").unwrap_or(false);
    let parts: Vec<&str> = resolution.split('x').collect();
    let (w, h) = match (parts.get(0).and_then(|p| p.parse::<f64>().ok()), parts.get(1).and_then(|p| p.parse::<f64>().ok())) {
        (Some(w), Some(h)) if parts.len() == 2 => (w, h),
        _ => (1440.0, 900.0),
    };
    (w, h, fullscreen)
}

/// After switching workspaces: the new one's own window size and fullscreen choice take effect.
pub(crate) fn apply_window_prefs(app: &tauri::AppHandle) {
    let (w, h, fullscreen) = window_prefs(&get_db_path(app));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_fullscreen(fullscreen);
        if !fullscreen {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
        }
    }
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
            // Workspaces
            commands::get_workspace_status,
            commands::check_workspace_name,
            commands::create_workspace,
            commands::open_workspace,
            commands::open_existing_workspace,
            commands::forget_workspace,
            commands::relocate_workspace,
            commands::reveal_workspace,
            commands::inspect_kinpak,
            commands::import_kinpak,
            commands::select_kinpak_file,
            commands::select_kinpak_save_path,
            // YouTube
            commands::resolve_channel,
            commands::fetch_videos,
            commands::fetch_channel_videos_v3,
            commands::fetch_channel_videos_keyless,
            commands::fetch_view_count,
            commands::fetch_video_info,
            commands::fetch_transcript,
            commands::fetch_video_handle,
            commands::save_video,
            commands::fetch_saved_videos,
            commands::search_library,
            commands::get_tag_videos_preview,
            commands::get_video_sequences,
            commands::get_drive_sequence,
            commands::get_child_drives,
            commands::add_to_drive_sequence,
            commands::list_drive_videos_for_sequence,
            commands::add_matching_to_drive_sequence,
            commands::remove_from_drive_sequence,
            commands::set_drive_sequence_order,
            commands::clear_drive_sequence,
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
            commands::add_attachment_link,
            commands::get_attachment_link,
            commands::remove_attachment,
            commands::open_attachment,
            commands::save_attachment_as,
            // Biography
            commands::get_biographies,
            commands::get_biography,
            commands::update_biography,
            // Export
            commands::export_to_obsidian,
            commands::get_export_drives,
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
            commands::export_kinpak,
            commands::select_vault_path,
            get_app_info,
            get_embed_server_port,
        ])
        .manage(DbPathState(Mutex::new(None)))
        .manage(ActiveWorkspaceState(Mutex::new(None)))
        .manage(StartupNoticeState(Mutex::new(None)))
        .manage(workspaces::BusyState(Mutex::new(None)))
        .manage(EmbedServerPortState(Mutex::new(None)))
        .manage(sync::SyncState::default())
        .setup(move |app| {
            let app_handle = app.handle();
            // Opens the most recent workspace (adopting an older single-database install first).
            // When there isn't one, the launcher shows and the path stays empty.
            workspaces::startup(app_handle);
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

            let (width, height, fullscreen) = window_prefs(&db_path);


            // Load from bundled index.html
            let url = WebviewUrl::App("index.html".into());
            
            // Create the main window
            WebviewWindowBuilder::new(app_handle, "main", url)
                .title(&get_window_title(&db_path))
                .inner_size(width, height)
                .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
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
