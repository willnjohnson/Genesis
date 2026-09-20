//! Commands for the launcher: listing, creating, opening, locating and forgetting workspaces.
//! The rules live in workspaces.rs; this only checks it's safe to switch and reports to the UI.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{command, AppHandle, Manager, State};

use crate::sync::SyncState;
use crate::workspaces::{self as ws, WorkspaceInfo};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    /// The open workspace, or none while the launcher is showing.
    pub current: Option<WorkspaceInfo>,
    /// Why nothing was opened at startup (the most recent workspace was missing, say).
    pub notice: Option<String>,
    /// Most recently opened first.
    pub recents: Vec<WorkspaceInfo>,
    /// Where a new workspace is stored unless the user picks another place.
    pub default_location: String,
}

#[derive(Serialize)]
pub struct NameCheck {
    pub ok: bool,
    /// A workspace with this name already exists (`ok` is then false, as a new one can't take the name).
    pub taken: bool,
    pub error: Option<String>,
    /// The name as it would be saved (trimmed, spaces collapsed).
    pub name: String,
    /// A free name close to the one typed.
    pub suggestion: String,
}

fn ensure_can_switch(app: &AppHandle, sync: &SyncState) -> Result<(), String> {
    if sync.is_running() {
        return Err("A sync is running. Cancel it first, then switch workspaces.".into());
    }
    ws::ensure_not_busy(app)
}

fn clear_notice(app: &AppHandle) {
    *app.state::<ws::StartupNoticeState>().0.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Opens `dir` on a worker thread (the schema upgrade can take a moment on a big library) and
/// applies that workspace's window settings.
async fn open_dir(app: &AppHandle, dir: PathBuf) -> Result<WorkspaceInfo, String> {
    let handle = app.clone();
    let opened = tokio::task::spawn_blocking(move || ws::activate(&handle, &dir)).await.map_err(|e| e.to_string())??;
    crate::apply_window_prefs(app);
    clear_notice(app);
    Ok(opened)
}

#[command]
pub fn get_workspace_status(app: AppHandle) -> Result<WorkspaceStatus, String> {
    let root = ws::app_root(&app);
    let current_dir = ws::current_folder(&app);
    let current = current_dir.as_ref().map(|dir| {
        let mut i = ws::info(dir);
        i.current = true;
        i
    });
    let mut recents = ws::list(&root, false);
    for w in recents.iter_mut() {
        w.current = current.as_ref().is_some_and(|c| c.folder == w.folder);
    }
    let notice = app.state::<ws::StartupNoticeState>().0.lock().unwrap_or_else(|p| p.into_inner()).clone();
    Ok(WorkspaceStatus { current, notice, recents, default_location: root.to_string_lossy().into_owned() })
}

/// Live check for the name box: is it a legal folder name, and is it free?
#[command]
pub fn check_workspace_name(app: AppHandle, name: String) -> NameCheck {
    let root = ws::app_root(&app);
    match ws::validate_name(&name) {
        Err(error) => NameCheck { ok: false, taken: false, error: Some(error), name: name.trim().to_string(), suggestion: ws::unique_name(&root, "New Workspace") },
        Ok(clean) if ws::name_taken(&root, &clean) => NameCheck {
            ok: false,
            taken: true,
            error: Some(format!("A workspace named \"{clean}\" already exists.")),
            suggestion: ws::unique_name(&root, &clean),
            name: clean,
        },
        Ok(clean) => NameCheck { ok: true, taken: false, error: None, suggestion: clean.clone(), name: clean },
    }
}

/// A new, empty workspace, opened straight away. `location` is a parent folder to keep the data in
/// instead of the app data directory (an external drive); the data goes in `<location>/<name>`.
#[command]
pub async fn create_workspace(
    app: AppHandle,
    sync: State<'_, SyncState>,
    name: String,
    location: Option<String>,
) -> Result<WorkspaceInfo, String> {
    ensure_can_switch(&app, &sync)?;
    let root = ws::app_root(&app);
    let dir = tokio::task::spawn_blocking(move || {
        ws::create(&root, &name, location.as_deref().map(std::path::Path::new))
    })
    .await
    .map_err(|e| e.to_string())??;
    open_dir(&app, dir).await
}

#[command]
pub async fn open_workspace(app: AppHandle, sync: State<'_, SyncState>, folder: String) -> Result<WorkspaceInfo, String> {
    ensure_can_switch(&app, &sync)?;
    let dir = ws::workspace_dir(&ws::app_root(&app), &folder)?;
    open_dir(&app, dir).await
}

/// "Open existing workspace": a folder holding a `kinesis_data.db` (or a workspace folder). It's added
/// to the list, once, and opened.
#[command]
pub async fn open_existing_workspace(app: AppHandle, sync: State<'_, SyncState>, path: String) -> Result<WorkspaceInfo, String> {
    ensure_can_switch(&app, &sync)?;
    let root = ws::app_root(&app);
    let dir = tokio::task::spawn_blocking(move || ws::register_existing(&root, std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())??;
    open_dir(&app, dir).await
}

/// "Remove from list". The data is never deleted, and the open workspace can't be removed.
#[command]
pub fn forget_workspace(app: AppHandle, folder: String) -> Result<(), String> {
    let dir = ws::workspace_dir(&ws::app_root(&app), &folder)?;
    if ws::current_folder(&app).as_deref() == Some(dir.as_path()) {
        return Err("That's the workspace you have open. Switch to another one first.".into());
    }
    ws::forget(&dir)
}

/// "Locate…": point a workspace whose database went missing (a drive that changed letter, a moved
/// folder) at its new folder.
#[command]
pub fn relocate_workspace(app: AppHandle, folder: String, path: String) -> Result<WorkspaceInfo, String> {
    let dir = ws::workspace_dir(&ws::app_root(&app), &folder)?;
    if ws::current_folder(&app).as_deref() == Some(dir.as_path()) {
        return Err("That's the workspace you have open. Use Database → Change DB Path to move it.".into());
    }
    ws::relocate(&dir, std::path::Path::new(&path))?;
    Ok(ws::info(&dir))
}

/// Shows a workspace's data folder in the file manager.
#[command]
pub fn reveal_workspace(app: AppHandle, folder: String) -> Result<(), String> {
    let dir = ws::data_dir(&ws::workspace_dir(&ws::app_root(&app), &folder)?);
    if !dir.is_dir() {
        return Err(format!("{} isn't available right now.", dir.display()));
    }
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    Ok(())
}
