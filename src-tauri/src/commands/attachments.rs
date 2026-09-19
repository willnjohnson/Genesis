use serde::Serialize;
use tauri::{command, AppHandle};

use crate::db::attachments::{self, AttachmentInfo, ALLOWED_EXTENSIONS};
use crate::{db, get_db_path};

const EDIT_FLAG: &str = "editAttachments";

/// Adding, removing and editing the note are switched off by the DB owner with `editAttachments`.
/// Checked here, not only in the UI, so it holds for anything that calls the command.
fn require_edit(db_path: &str) -> Result<(), String> {
    if db::get_flag(db_path, EDIT_FLAG, true) {
        Ok(())
    } else {
        Err("Changing attachments is turned off for this database.".to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAttachments {
    pub note: String,
    pub attachments: Vec<AttachmentInfo>,
}

/// What happened to one file in an add: it was added, or here is why not.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddOutcome {
    pub name: String,
    pub attachment: Option<AttachmentInfo>,
    pub error: Option<String>,
}

#[command]
pub async fn get_video_attachments(app: AppHandle, video_id: String) -> Result<VideoAttachments, String> {
    let db_path = get_db_path(&app);
    let note = attachments::get_note(&db_path, &video_id).map_err(|e| e.to_string())?;
    let attachments = attachments::list_attachments(&db_path, &video_id).map_err(|e| e.to_string())?;
    Ok(VideoAttachments { note, attachments })
}

#[command]
pub async fn save_video_note(app: AppHandle, video_id: String, note: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    require_edit(&db_path)?;
    attachments::set_note(&db_path, &video_id, &note)
}

/// Native file picker (several files at once) limited to the supported types.
#[command]
pub async fn pick_attachment_files(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Attachments", ALLOWED_EXTENSIONS)
        .pick_files(move |files| {
            let _ = tx.send(files.map(|f| f.into_iter().map(|p| p.to_string()).collect::<Vec<_>>()));
        });
    Ok(rx.await.map_err(|e| e.to_string())?.unwrap_or_default())
}

/// Reads, compresses and stores each file, one at a time, off the UI thread. File contents never
/// travel through the webview; only paths and results do.
#[command]
pub async fn add_attachments(app: AppHandle, video_id: String, paths: Vec<String>) -> Result<Vec<AddOutcome>, String> {
    let db_path = get_db_path(&app);
    require_edit(&db_path)?;
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|p| {
                let path = std::path::PathBuf::from(&p);
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(p);
                match attachments::add_attachment_from_path(&db_path, &video_id, &path) {
                    Ok(info) => AddOutcome { name, attachment: Some(info), error: None },
                    Err(error) => AddOutcome { name, attachment: None, error: Some(error) },
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[command]
pub async fn remove_attachment(app: AppHandle, id: i64) -> Result<(), String> {
    let db_path = get_db_path(&app);
    require_edit(&db_path)?;
    attachments::remove_attachment(&db_path, id).map_err(|e| e.to_string())
}

fn temp_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("kinesis-attachments")
}

/// Empties the folder attachments are opened from. Called at startup.
pub fn clear_attachment_temp() {
    let _ = std::fs::remove_dir_all(temp_dir());
}

/// Writes the attachment to a temporary file and opens it in the system's default app. HTML and
/// SVG are opened there too, never inside Kinesis, since either can carry script.
#[command]
pub async fn open_attachment(app: AppHandle, id: i64) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let db_path = get_db_path(&app);
    let (name, bytes) = tokio::task::spawn_blocking(move || attachments::read_attachment(&db_path, id))
        .await
        .map_err(|e| e.to_string())??;
    // One folder per attachment id, so two files with the same name never overwrite each other.
    let dir = temp_dir().join(id.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(&name);
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(file.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Save As: writes the original bytes to a place the user picks. Returns false if they cancel.
#[command]
pub async fn save_attachment_as(app: AppHandle, id: i64) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let db_path = get_db_path(&app);
    let (name, bytes) = tokio::task::spawn_blocking(move || attachments::read_attachment(&db_path, id))
        .await
        .map_err(|e| e.to_string())??;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(name).save_file(move |f| {
        let _ = tx.send(f.map(|p| p.to_string()));
    });
    match rx.await.map_err(|e| e.to_string())? {
        Some(path) => {
            std::fs::write(path, bytes).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_attachments_defaults_on_and_the_db_owner_can_turn_it_off() {
        let path = std::env::temp_dir().join(format!("kinesis_attach_flag_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db_path = path.to_string_lossy().to_string();
        db::init_db(&db_path).unwrap();

        // Seeded on, and on when the row is missing altogether.
        assert!(require_edit(&db_path).is_ok());
        db::delete_setting(&db_path, EDIT_FLAG).unwrap();
        assert!(require_edit(&db_path).is_ok());

        db::set_setting(&db_path, EDIT_FLAG, "false").unwrap();
        assert!(require_edit(&db_path).unwrap_err().contains("turned off"));
        db::set_setting(&db_path, EDIT_FLAG, "no").unwrap();
        assert!(require_edit(&db_path).is_err());
        db::set_setting(&db_path, EDIT_FLAG, "true").unwrap();
        assert!(require_edit(&db_path).is_ok());
        let _ = std::fs::remove_file(&path);
    }
}
