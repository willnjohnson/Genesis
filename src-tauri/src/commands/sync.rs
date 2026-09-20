use kinesis_sync_proto::Manifest;
use tauri::{command, AppHandle, Emitter, State};

use crate::db::sync::ApplyStats;
use crate::sync::http::{normalize_server_url, ServerApi};
use crate::sync::{self, SyncReport, SyncState, SyncStatus};
use crate::{db, get_db_path};

fn clean_token(token: Option<String>) -> Option<String> {
    token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// "Test connection": reaches the server and checks compatibility, saving nothing.
#[command]
pub async fn sync_test(url: String, token: Option<String>) -> Result<Manifest, String> {
    let base = normalize_server_url(&url)?;
    let api = ServerApi::new(&base, clean_token(token))?;
    let manifest = api.manifest().await.map_err(|e| e.to_string())?;
    sync::check_manifest(&manifest)?;
    Ok(manifest)
}

/// Tests, then saves the server address and token. Switching servers requires disconnecting
/// first: a snapshot from a different server would otherwise sweep the previous server's rows.
#[command]
pub async fn sync_connect(app: AppHandle, url: String, token: Option<String>) -> Result<Manifest, String> {
    let db_path = get_db_path(&app);
    let base = normalize_server_url(&url)?;
    if let Some(existing) = sync::load_config(&db_path) {
        if existing.url != base {
            return Err(format!("Already connected to {}. Disconnect from it first.", existing.url));
        }
    }
    let token = clean_token(token);
    let api = ServerApi::new(&base, token.clone())?;
    let manifest = api.manifest().await.map_err(|e| e.to_string())?;
    sync::check_manifest(&manifest)?;

    db::set_setting(&db_path, sync::KEY_URL, &base).map_err(|e| e.to_string())?;
    match token {
        Some(t) => db::set_setting(&db_path, sync::KEY_TOKEN, &t).map_err(|e| e.to_string())?,
        None => db::delete_setting(&db_path, sync::KEY_TOKEN).map_err(|e| e.to_string())?,
    }
    db::set_setting(&db_path, sync::KEY_SERVER_NAME, &manifest.server_name).map_err(|e| e.to_string())?;
    Ok(manifest)
}

#[command]
pub async fn sync_run(app: AppHandle, state: State<'_, SyncState>, force_full: bool) -> Result<SyncReport, String> {
    let db_path = get_db_path(&app);
    let emitter = app.clone();
    sync::run_core(&db_path, &state, force_full, move |p| {
        let _ = emitter.emit("sync_progress", p);
    })
    .await
}

#[command]
pub fn sync_cancel(state: State<'_, SyncState>) {
    state.cancel();
}

#[command]
pub fn sync_status(app: AppHandle, state: State<'_, SyncState>) -> Result<SyncStatus, String> {
    sync::status(&get_db_path(&app), &state)
}

#[command]
pub fn sync_set_options(app: AppHandle, auto_sync: bool, interval_minutes: u32) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let minutes = interval_minutes.max(sync::MIN_INTERVAL_MINUTES);
    db::set_setting(&db_path, sync::KEY_AUTO, &auto_sync.to_string()).map_err(|e| e.to_string())?;
    db::set_setting(&db_path, sync::KEY_INTERVAL, &minutes.to_string()).map_err(|e| e.to_string())
}

#[command]
pub async fn sync_disconnect(app: AppHandle, state: State<'_, SyncState>, keep_data: bool) -> Result<ApplyStats, String> {
    if state.is_running() {
        return Err("A sync is running. Cancel it first.".into());
    }
    let db_path = get_db_path(&app);
    tokio::task::spawn_blocking(move || sync::disconnect(&db_path, keep_data))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether each provider can be reached right now, and whether that's via the server's license.
/// The Settings UI and the "is an API key set" gates use this instead of reading the raw key.
#[command]
pub fn get_key_status(app: AppHandle) -> sync::license::KeyStatus {
    sync::license::key_status(&get_db_path(&app))
}

/// Save As for the Obsidian vault. The name chosen is the vault FOLDER itself (default
/// "Kinesis_<Workspace_Name>_Vault"), which the export creates fresh; `export_to_obsidian` picks a free "name (2)" if
/// that name is already taken, whatever the OS dialog said about replacing.
#[command]
pub async fn select_vault_path(app: AppHandle, default_name: String, start_dir: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Name your Obsidian vault folder")
        .set_file_name(default_name);
    if let Some(dir) = start_dir.filter(|d| std::path::Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    dialog.save_file(move |f| {
        let _ = tx.send(f.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}

/// Setting keys the connected server locks, so the UI can disable the matching controls.
#[command]
pub fn get_locked_settings(app: AppHandle) -> Result<Vec<String>, String> {
    db::get_locked_settings(&get_db_path(&app)).map_err(|e| e.to_string())
}
