use serde::{Deserialize, Serialize};
use tauri::command;
use crate::{get_db_path, db, types::*};

/// Transforms a Warp Drive designator from user-facing display format (":UAP-GERB-VVV") into the
/// storage encoding the WDBS column actually uses — ':' and '-' become 'θψ' and '_' respectively,
/// e.g. ":UAP-GERB-VVV" -> "θψUAP_GERB_VVV". Uppercases the designator body so a value is stored
/// consistently regardless of the case it was typed in (the input fields also uppercase live, but
/// this is the one place every save path — update_wdbs, add_video_wdbs_link, bulk_update_wdbs —
/// actually goes through, so it's enforced here too). Returns `Ok(None)` for a blank/cleared
/// input, or an `Err` with a plain-language message if the input isn't in the expected ":..."
/// shape (shared by update_wdbs and add_video_wdbs_link so both editors reject malformed input
/// the same way).
pub(crate) fn encode_wdbs_display(raw: &str, drive_label: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match trimmed.strip_prefix(':') {
        Some(rest) if !rest.is_empty() => Ok(Some(format!("θψ{}", rest.to_uppercase().replace('-', "_")))),
        Some(_) => Ok(None),
        None => Err(format!(
            "{} designators must start with ':' (e.g. \":UAP-GERB-VVV\"). \"{}\" doesn't.",
            drive_label, trimmed
        )),
    }
}

/// Updates a video's canonical Warp Drive (WDBS) designator, or clears it back to unassigned
/// ("N/A") when given an empty string. Clearing writes ":" — the storage encoding of tblWDBS's
/// root entry — rather than an empty string, SQL NULL, or the column's own "θψ" default: the
/// production database's WDBS column is NOT NULL, and its validating trigger
/// (trgVideosBeforeUPD_Videos_ValidateWDBS) requires ANY non-null value to resolve to a real
/// tblWDBS row, so only a value that's actually registered there will be accepted (see
/// db::update_video_wdbs). ":" specifically (not "θψ") because "θψ" is alphabetic and also the
/// universal prefix every real WDBS value starts with, so FTS5 indexes it as a literal searchable
/// term that matches every video regardless of assignment — ":" is punctuation, which the
/// tokenizer doesn't index at all. Setting a real designator first ensures it — and every level
/// above it — exists in tblWDBS (see db::ensure_wdbs_path_exists), so a genuinely new category
/// can be created from here rather than only ones someone pre-populated externally. Against the
/// production database, anything that still doesn't resolve is rejected by that same trigger;
/// that raw SQLite error is not something a user typing a Warp Drive value should have to parse,
/// so it's caught here and turned into a plain-language message instead (item 9 of the schema
/// handoff doc: "trap SQLite Trigger Error for user-friendly messaging"). To have a video
/// additionally show up under OTHER Warp Drives without changing this canonical one, see
/// add_video_wdbs_link. Clearing the canonical value also removes any symlinks the video had —
/// a symlink only makes sense as something *additional* alongside a canonical Warp Drive, so
/// none should survive on their own once there isn't one.
#[command]
pub async fn update_wdbs(app: tauri::AppHandle, video_id: String, wdbs: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let drive_label = db::drive_label(&db_path);
    // Uppercased before both encoding and tblWDBS registration, so the two stay in sync — the
    // trigger that validates a video's WDBS resolves against tblWDBS's own case (see
    // encode_wdbs_display), and SQLite TEXT comparison is case-sensitive by default.
    let trimmed = wdbs.trim().to_uppercase();
    let trimmed = trimmed.as_str();
    let encoded = encode_wdbs_display(trimmed, &drive_label)?;
    let is_clearing = encoded.is_none();

    let value = match encoded {
        Some(v) => {
            db::ensure_wdbs_path_exists(&db_path, trimmed).map_err(|e| e.to_string())?;
            v
        }
        None => {
            db::ensure_wdbs_path_exists(&db_path, ":").map_err(|e| e.to_string())?;
            ":".to_string()
        }
    };

    db::update_video_wdbs(&db_path, &video_id, &value).map_err(|e| {
        format!(
            "That {} designator wasn't accepted ({}). Double-check it against the {} taxonomy and try again.",
            drive_label, e, drive_label
        )
    })?;

    if is_clearing {
        // Best-effort: the canonical clear already succeeded, so a failure here (extremely
        // unlikely — this is a delete keyed on the table's own primary key) shouldn't surface
        // as an error over what was otherwise a successful action.
        let _ = db::clear_video_wdbs_links(&db_path, &video_id);
    }

    Ok(())
}

/// Returns the full Warp Drive taxonomy tree (see components/DriveView.tsx) built from whatever
/// WDBS assignments — canonical or symlinked — are actually in use. There is no "Universe"/
/// unassigned entry; browsing everything is what the Library/Portal grid is for.
#[command]
pub async fn get_wdbs_tree(app: tauri::AppHandle) -> Result<Vec<db::WdbsNode>, String> {
    let db_path = get_db_path(&app);
    db::get_wdbs_tree(&db_path).map_err(|e| e.to_string())
}

// Mirrors commands::youtube::library's Library/Portal page-size constants.
const MAX_DRIVE_PAGE_SIZE: i64 = 500;
const DEFAULT_DRIVE_PAGE_SIZE: i64 = 300;

/// Pages the videos under one Warp Drive category (canonical assignment or symlink, exact match
/// or nested beneath it), optionally narrowed by a free-text `query` scoped to that category —
/// see db::list_videos_by_wdbs.
#[command]
pub async fn fetch_videos_by_wdbs(
    app: tauri::AppHandle,
    wdbs_prefix: String,
    query: Option<String>,
    filter_kind: Option<String>,
    sort_field: Option<String>,
    sort_order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<VideoResponse, String> {
    let db_path = get_db_path(&app);
    let limit = limit.unwrap_or(DEFAULT_DRIVE_PAGE_SIZE).clamp(1, MAX_DRIVE_PAGE_SIZE);
    let offset = offset.unwrap_or(0).max(0);
    let (videos, total_count) = db::list_videos_by_wdbs(
        &db_path,
        &wdbs_prefix,
        query.as_deref().unwrap_or(""),
        filter_kind.as_deref(),
        sort_field.as_deref(),
        sort_order.as_deref(),
        limit,
        offset,
    )
    .map_err(|e| e.to_string())?;
    Ok(VideoResponse { videos, continuation: None, total_count: Some(total_count) })
}

/// Sets (or clears, given a blank `alias`) the curated display alias for one Warp Drive taxonomy
/// node — tblWDBS.WDInfo — shown as a tooltip/detail alongside its raw segment name in the tree
/// (see components/WdbsTreePanel.tsx's "Edit Alias" context menu). `path` is a WdbsNode.path
/// value (storage-encoded). A no-op against a database without the production tblWDBS schema.
#[command]
pub async fn set_wdbs_alias(app: tauri::AppHandle, path: String, alias: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_wdbs_alias(&db_path, &path, &alias).map_err(|e| e.to_string())
}

/// Sets (or clears, given a blank `icon`) the curated icon for one Warp Drive taxonomy node —
/// tblWDBS.WDIcon — shown to the left of its segment name in the tree (see
/// components/WdbsTreePanel.tsx's "Edit Icon" context menu). `path` is a WdbsNode.path value.
/// Rejects anything outside db::WDBS_ICONS with a plain-language message rather than letting a
/// stray/garbled value get stuck in the taxonomy with nothing able to render it — db::set_wdbs_icon
/// itself trusts whatever it's given, so this is the one place that boundary is enforced. A no-op
/// against a database without the production tblWDBS schema.
#[command]
pub async fn set_wdbs_icon(app: tauri::AppHandle, path: String, icon: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let drive_label = db::drive_label(&db_path);
    let icon = icon.trim();
    if !icon.is_empty() && !db::WDBS_ICONS.contains(&icon) {
        return Err(format!("\"{}\" isn't a recognized {} icon.", icon, drive_label));
    }
    db::set_wdbs_icon(&db_path, &path, icon).map_err(|e| e.to_string())
}

/// Every Warp Drive path currently assigned to at least one video (storage-encoded), for
/// autocomplete when assigning an existing category rather than typing one from scratch.
#[command]
pub async fn get_wdbs_suggestions(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let db_path = get_db_path(&app);
    db::list_all_wdbs_paths(&db_path).map_err(|e| e.to_string())
}

/// A video's current canonical Warp Drive (WDBS), storage-encoded — `None` if unassigned or if
/// the video isn't in the local database at all. Exists so a video opened from Search (whose
/// `Video` object comes straight from the YouTube API and so never carries a `wdbs` value, even
/// when that same video is already saved locally — see commands::youtube::metadata) can still
/// have its real designator looked up once the Sidebar confirms it's in the database, instead of
/// always showing "N/A" the way it would if it only ever trusted the object it was opened with.
#[command]
pub async fn get_video_wdbs(app: tauri::AppHandle, video_id: String) -> Result<Option<String>, String> {
    let db_path = get_db_path(&app);
    Ok(db::get_video_wdbs_primary(&db_path, &video_id).unwrap_or(None))
}

/// A video's symlinked (non-canonical) Warp Drives, storage-encoded.
#[command]
pub async fn get_video_wdbs_links(app: tauri::AppHandle, video_id: String) -> Result<Vec<String>, String> {
    let db_path = get_db_path(&app);
    db::get_video_wdbs_links(&db_path, &video_id).map_err(|e| e.to_string())
}

/// Adds a symlink so `video_id` also shows up under another Warp Drive category, without
/// changing its canonical one (see update_wdbs). Returns the storage-encoded value added, so the
/// caller can update local state without a refetch. Rejects a value that would just duplicate
/// the video's existing canonical WDBS. Like update_wdbs, ensures the designator (and every
/// level above it) exists in tblWDBS first, so linking to a brand-new category works the same
/// way creating one via the canonical editor does.
#[command]
pub async fn add_video_wdbs_link(app: tauri::AppHandle, video_id: String, wdbs: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    let drive_label = db::drive_label(&db_path);
    let trimmed = wdbs.trim().to_uppercase();
    let trimmed = trimmed.as_str();
    let encoded = encode_wdbs_display(trimmed, &drive_label)?
        .ok_or_else(|| format!("Enter a {} designator to link, e.g. \":UAP-GERB-VVV\".", drive_label))?;

    let primary = db::get_video_wdbs_primary(&db_path, &video_id).map_err(|e| e.to_string())?;
    if primary.as_deref() == Some(encoded.as_str()) {
        return Err(format!("That's already this video's primary {}.", drive_label));
    }

    db::ensure_wdbs_path_exists(&db_path, trimmed).map_err(|e| e.to_string())?;
    db::add_video_wdbs_link(&db_path, &video_id, &encoded).map_err(|e| {
        format!(
            "That {} designator wasn't accepted ({}). Double-check it against the {} taxonomy and try again.",
            drive_label, e, drive_label
        )
    })?;
    Ok(encoded)
}

#[command]
pub async fn remove_video_wdbs_link(app: tauri::AppHandle, video_id: String, wdbs: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::remove_video_wdbs_link(&db_path, &video_id, &wdbs).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BulkWdbsResult {
    pub succeeded: Vec<String>,
    pub failed: Vec<(String, String)>,
}

/// Assigns a whole batch of videos to one Warp Drive category (or clears them all back to
/// unassigned, given an empty `wdbs`) in a single round trip — the multi-select "Bulk Assign
/// Mode" in the Library/Portal grid (see App.tsx). Validates and registers the target category
/// (or the ":" clear sentinel) exactly once up front, the same way update_wdbs does for a single
/// video, then applies it to every video_id individually so one bad id can't abort the whole
/// batch — callers get back which ids succeeded and which failed (with why), rather than an
/// all-or-nothing result.
#[command]
pub async fn bulk_update_wdbs(app: tauri::AppHandle, video_ids: Vec<String>, wdbs: String) -> Result<BulkWdbsResult, String> {
    let db_path = get_db_path(&app);
    let drive_label = db::drive_label(&db_path);
    let trimmed = wdbs.trim().to_uppercase();
    let trimmed = trimmed.as_str();
    let encoded = encode_wdbs_display(trimmed, &drive_label)?;
    let is_clearing = encoded.is_none();

    let value = match encoded {
        Some(v) => {
            db::ensure_wdbs_path_exists(&db_path, trimmed).map_err(|e| e.to_string())?;
            v
        }
        None => {
            db::ensure_wdbs_path_exists(&db_path, ":").map_err(|e| e.to_string())?;
            ":".to_string()
        }
    };

    let mut succeeded = Vec::new();
    let mut failed = Vec::new();
    for video_id in video_ids {
        match db::update_video_wdbs(&db_path, &video_id, &value) {
            Ok(()) => {
                if is_clearing {
                    // Best-effort, same as update_wdbs's single-video clear path — the canonical
                    // clear already succeeded, so a symlink-cleanup failure here shouldn't turn
                    // an otherwise-successful assignment into a reported failure.
                    let _ = db::clear_video_wdbs_links(&db_path, &video_id);
                }
                succeeded.push(video_id);
            }
            Err(e) => failed.push((
                video_id,
                format!(
                    "That {} designator wasn't accepted ({}). Double-check it against the {} taxonomy and try again.",
                    drive_label, e, drive_label
                ),
            )),
        }
    }

    Ok(BulkWdbsResult { succeeded, failed })
}

/// Every Drive a channel's saved videos are filed under (for the Biography's "Related Drives").
#[command]
pub async fn get_handle_drives(app: tauri::AppHandle, handle: String) -> Result<Vec<db::HandleDrive>, String> {
    let db_path = get_db_path(&app);
    db::get_handle_drives(&db_path, &handle).map_err(|e| e.to_string())
}

/// Curated aliases for the given Drive paths (storage form), keyed by that same path. Drives without
/// an alias of their own are left out. For the tooltips on a video's Drive and "Also in" tags.
#[command]
pub async fn get_wdbs_aliases(app: tauri::AppHandle, paths: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
    let db_path = get_db_path(&app);
    db::get_wdbs_aliases(&db_path, &paths).map_err(|e| e.to_string())
}
