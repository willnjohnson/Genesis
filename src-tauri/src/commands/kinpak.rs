//! Commands for kinpak files: export, look inside, import as a new workspace, or merge into the open one.

use serde::Serialize;
use tauri::{command, AppHandle, Emitter, Manager, State};

use crate::kinpak::{self, ExportOptions, ExportSummary, ImportOptions, ImportSummary};
use crate::sync::SyncState;
use crate::workspaces::{self as ws, WorkspaceInfo};
use crate::{db, get_db_path};

const PROGRESS_EVENT: &str = "kinpak_progress";

/// Writes the workspace (never keys, tokens, sync-server state or folder paths) to the file chosen in
/// the Save As dialog. The name always ends in `.kinpak`.
#[command]
pub async fn export_kinpak(app: AppHandle, file_path: String, options: ExportOptions) -> Result<ExportSummary, String> {
    let db_path = get_db_path(&app);
    let label = format!("{} {}", crate::APP_NAME, crate::VERSION);
    let emitter = app.clone();
    let path = kinpak::resolve_pack_path(&file_path);
    // While this runs the app won't switch workspaces or move the database out from under it.
    let busy = ws::begin_task(&app, "export")?;
    tokio::task::spawn_blocking(move || {
        let _busy = busy;
        kinpak::export_pack(&db_path, &path, &label, crate::APP_NAME, &options, |m| {
            let _ = emitter.emit(PROGRESS_EVENT, m);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KinpakPreview {
    pub app: String,
    pub generated_at: String,
    pub workspace_name: Option<String>,
    pub counts: std::collections::BTreeMap<String, u64>,
    /// The name to offer for the workspace: the pack's own, cleaned up. If a workspace already has it,
    /// importing adds to that workspace.
    pub suggested_name: String,
    /// True when a workspace here already has that name.
    pub name_taken: bool,
}

/// What a pack is and which workspace it came from, read from its first lines (so it's instant
/// however large the file is), plus the name to offer for the workspace it will become.
#[command]
pub async fn inspect_kinpak(app: AppHandle, file_path: String) -> Result<KinpakPreview, String> {
    let root = ws::app_root(&app);
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&file_path);
        let info = kinpak::inspect_pack(path)?;
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Imported Workspace");
        let wanted = ws::sanitize_name(info.workspace_name.as_deref().unwrap_or(stem));
        Ok(KinpakPreview {
            name_taken: ws::name_taken(&root, &wanted),
            suggested_name: wanted,
            app: info.app,
            generated_at: info.generated_at,
            workspace_name: info.workspace_name,
            counts: info.counts,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct ImportedWorkspace {
    pub workspace: WorkspaceInfo,
    pub summary: ImportSummary,
    /// The pack was added to a workspace that already had its name, rather than making a new one.
    pub merged: bool,
}

/// Imports a pack under `name`. If a workspace with that name already exists, what's missing is added
/// to it: everything it already has is kept, nothing a connected sync server provides is touched, and
/// its settings and section names stay as they are. Otherwise the pack becomes a new workspace,
/// assembled beside the others and only put in place once the import worked, so a failure leaves
/// nothing behind. Nothing here deletes or replaces anything. `open` switches to the result.
#[command]
pub async fn import_kinpak(
    app: AppHandle,
    sync: State<'_, SyncState>,
    file_path: String,
    name: String,
    location: Option<String>,
    open: bool,
) -> Result<ImportedWorkspace, String> {
    if open && sync.is_running() {
        return Err("A sync is running. Cancel it first, then switch workspaces.".into());
    }
    let name = ws::validate_name(&name)?;
    // Held until this returns, so nothing else switches or moves things while the import runs.
    let _busy = ws::begin_task(&app, "import")?;
    let root = ws::app_root(&app);
    let current = ws::current_folder(&app);
    let emitter = app.clone();
    let (dir, summary, merged) = tokio::task::spawn_blocking(move || {
        let progress = |m: &str| {
            let _ = emitter.emit(PROGRESS_EVENT, m);
        };
        let pack = std::path::Path::new(&file_path);

        if let Some(existing) = ws::find_workspace(&root, &name) {
            let data = ws::data_dir(&existing);
            let db_file = data.join(ws::DB_FILE);
            if !db_file.is_file() {
                return Err(format!(
                    "\"{name}\" can't be reached right now ({} not found). Connect its drive, or use Locate in the workspace list, then try again.",
                    data.display()
                ));
            }
            // The open workspace already holds its lock; another one is locked for the length of the import.
            let is_current = current.as_deref().is_some_and(|c| ws::same_path(c, &existing));
            let _lock = if is_current { None } else { ws::acquire_lock(&data)? };
            let db_str = db_file.to_string_lossy().into_owned();
            db::init_db(&db_str).map_err(|e| format!("Couldn't open the database at {db_str}: {e}"))?;
            let summary = kinpak::import_pack(&db_str, pack, ImportOptions { apply_settings: false }, progress)?;
            return Ok((existing, summary, true));
        }

        let mut summary = None;
        let dir = ws::create_with(&root, &name, location.as_deref().map(std::path::Path::new), |db_file| {
            db::init_db(db_file).map_err(|e| format!("Couldn't create the database: {e}"))?;
            summary = Some(kinpak::import_pack(db_file, pack, ImportOptions { apply_settings: true }, progress)?);
            Ok(())
        })?;
        Ok::<_, String>((dir, summary.expect("import ran"), false))
    })
    .await
    .map_err(|e| e.to_string())??;

    let workspace = if open {
        let handle = app.clone();
        let target = dir.clone();
        let opened = tokio::task::spawn_blocking(move || ws::activate(&handle, &target)).await.map_err(|e| e.to_string())??;
        crate::apply_window_prefs(&app);
        *app.state::<ws::StartupNoticeState>().0.lock().unwrap_or_else(|p| p.into_inner()) = None;
        opened
    } else {
        ws::info(&dir)
    };
    Ok(ImportedWorkspace { workspace, summary, merged })
}

#[command]
pub async fn select_kinpak_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Packs from before the rename (.jsonl, .jsonl.gz) still import.
    app.dialog()
        .file()
        .set_title("Choose a Kinpak")
        .add_filter("Kinpak (.kinpak)", &[kinpak::EXTENSION])
        .add_filter("Older sync packs (.jsonl, .gz)", &["jsonl", "gz"])
        .pick_file(move |f| {
            let _ = tx.send(f.map(|p| p.to_string()));
        });
    rx.await.map_err(|e| e.to_string())
}

/// The "Save As" dialog for a kinpak. `start_dir` is where it opens (the folder of the last export),
/// when it still exists.
#[command]
pub async fn select_kinpak_save_path(app: AppHandle, default_name: String, start_dir: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export Kinpak")
        .set_file_name(default_name)
        .add_filter("Kinpak (.kinpak)", &[kinpak::EXTENSION]);
    if let Some(dir) = start_dir.filter(|d| std::path::Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    dialog.save_file(move |f| {
        let _ = tx.send(f.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}
