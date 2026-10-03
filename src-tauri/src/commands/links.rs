use crate::{db, get_db_path};
use tauri::{command, Emitter};

/// How far link_channel_info_footers has got (see src/components/WhatsNewModal.tsx).
const LINK_CHANNEL_INFO_PROGRESS: &str = "link_channel_info_progress";

#[derive(Clone, serde::Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

/// Links the creator's name in every summary's "Channel Info:" footer to their biography: the one-off for summaries
/// saved before that (What's New, v0.5.1). Returns how many summaries changed; reports how far it's got as
/// LINK_CHANNEL_INFO_PROGRESS events ({ done, total }) along the way.
#[command]
pub async fn link_channel_info_footers(app: tauri::AppHandle) -> Result<usize, String> {
    let db_path = get_db_path(&app);
    tokio::task::spawn_blocking(move || {
        db::summaries::relink_channel_info_footers(&db_path, |done, total| {
            let _ = app.emit(LINK_CHANNEL_INFO_PROGRESS, Progress { done, total });
        })
    })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// The texts that link to a video, person or other target (its Backlinks list, see db::links::find_backlinks).
/// Off the main thread: on a big library the scan (transcripts included) takes a moment.
#[command]
pub async fn get_backlinks(app: tauri::AppHandle, kind: String, key: String) -> Result<Vec<db::links::Backlink>, String> {
    let link_kind = db::links::LinkKind::parse(&kind).ok_or_else(|| format!("\"{kind}\" isn't a kind of link."))?;
    let db_path = get_db_path(&app);
    tokio::task::spawn_blocking(move || db::links::find_backlinks(&db_path, link_kind, &key))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
