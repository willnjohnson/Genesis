//! Sync engine: pulls content, policy and license info from a sync server (docs/sync-protocol.md).
//!
//! `run_core` is deliberately free of Tauri types (progress goes out through a callback) so it can
//! be driven by a mock server in tests; `commands::sync` wires it to the app.

pub mod http;
pub mod license;
pub mod pack;

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod e2e_tests;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use kinesis_sync_proto::{Manifest, PROTOCOL_VERSION};
use serde::Serialize;

use crate::db;
use crate::db::sync::ApplyStats;
use http::{ApiError, ServerApi};

// `sync_*` keys live in the settings table but are on the proto denylist: never exported, never
// settable by server policy.
pub const KEY_URL: &str = "sync_server_url";
pub const KEY_TOKEN: &str = "sync_token";
pub const KEY_CURSOR: &str = "sync_cursor";
pub const KEY_LAST_AT: &str = "sync_last_at";
pub const KEY_LAST_ERROR: &str = "sync_last_error";
pub const KEY_SERVER_NAME: &str = "sync_server_name";
pub const KEY_AUTO: &str = "sync_auto";
pub const KEY_INTERVAL: &str = "sync_interval_min";
pub const KEY_LICENSE: &str = "sync_license_json";
/// Which revision history `sync_cursor` belongs to (`Manifest::epoch`).
pub const KEY_EPOCH: &str = "sync_epoch";

/// Items requested per `/changes` page.
const PAGE_LIMIT: usize = 200;
/// Most errors carried back in a report (the rest are only counted).
const MAX_REPORTED_ERRORS: usize = 20;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Default)]
pub struct SyncState {
    running: AtomicBool,
    cancel: AtomicBool,
}

impl SyncState {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

struct RunGuard<'a>(&'a AtomicBool);

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncProgress {
    pub phase: &'static str,
    pub message: String,
    pub page: u32,
    pub upserted: u64,
    pub deleted: u64,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct SyncReport {
    pub full: bool,
    pub cancelled: bool,
    pub revision: u64,
    pub pages: u32,
    pub upserted: u64,
    pub unchanged: u64,
    pub deleted: u64,
    pub disowned: u64,
    pub skipped: u64,
    pub error_count: u64,
    pub errors: Vec<String>,
    pub policy_applied: u64,
    pub policy_dropped: u64,
}

impl SyncReport {
    fn absorb(&mut self, stats: ApplyStats) {
        self.upserted += stats.upserted;
        self.unchanged += stats.unchanged;
        self.deleted += stats.deleted;
        self.disowned += stats.disowned;
        self.skipped += stats.skipped;
        self.error_count += stats.errors.len() as u64;
        for e in stats.errors {
            if self.errors.len() < MAX_REPORTED_ERRORS {
                self.errors.push(e);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub url: String,
    pub token: Option<String>,
}

fn get(db_path: &str, key: &str) -> Option<String> {
    db::get_setting(db_path, key).ok().flatten()
}

fn put(db_path: &str, key: &str, value: &str) {
    if let Err(e) = db::set_setting(db_path, key, value) {
        log::warn!("sync: couldn't store {key}: {e}");
    }
}

pub fn load_config(db_path: &str) -> Option<SyncConfig> {
    let url = get(db_path, KEY_URL).filter(|u| !u.trim().is_empty())?;
    let token = get(db_path, KEY_TOKEN).filter(|t| !t.trim().is_empty());
    Some(SyncConfig { url, token })
}

/// "0.4.2" style comparison; unparseable parts count as 0 so a malformed value never blocks sync.
fn version_parts(v: &str) -> Vec<u64> {
    v.trim().trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

pub fn version_lt(a: &str, b: &str) -> bool {
    let (a, b) = (version_parts(a), version_parts(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

/// Refuses servers this build can't talk to.
pub fn check_manifest(m: &Manifest) -> Result<(), String> {
    if m.protocol_version > PROTOCOL_VERSION {
        return Err(format!(
            "This server speaks sync protocol v{} but this app only understands v{}. Update the app.",
            m.protocol_version, PROTOCOL_VERSION
        ));
    }
    if !m.min_client_version.is_empty() && version_lt(APP_VERSION, &m.min_client_version) {
        return Err(format!(
            "This server needs app version {} or newer (you have {}).",
            m.min_client_version, APP_VERSION
        ));
    }
    Ok(())
}

fn api_err(e: ApiError) -> String {
    e.to_string()
}

fn join_err(e: tokio::task::JoinError) -> String {
    format!("internal error: {e}")
}

/// Runs one sync. `force_full` = the user's "Full resync": snapshot from revision 0, rewrite every
/// row even if unchanged, and remove owned rows the server no longer has.
pub async fn run_core(
    db_path: &str,
    state: &SyncState,
    force_full: bool,
    emit: impl Fn(SyncProgress),
) -> Result<SyncReport, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A sync is already running.".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let _guard = RunGuard(&state.running);

    let result = run_inner(db_path, state, force_full, &emit).await;
    match &result {
        Ok(_) => put(db_path, KEY_LAST_ERROR, ""),
        Err(e) => put(db_path, KEY_LAST_ERROR, e),
    }
    result
}

async fn run_inner(
    db_path: &str,
    state: &SyncState,
    force_full: bool,
    emit: &impl Fn(SyncProgress),
) -> Result<SyncReport, String> {
    let progress = |phase: &'static str, message: &str, page: u32, r: &SyncReport| {
        emit(SyncProgress { phase, message: message.to_string(), page, upserted: r.upserted, deleted: r.deleted })
    };
    let mut report = SyncReport::default();

    let cfg = load_config(db_path).ok_or("Not connected to a sync server.")?;
    let api = ServerApi::new(&cfg.url, cfg.token.clone())?;

    progress("connecting", "Contacting server…", 0, &report);
    let manifest = api.manifest().await.map_err(api_err)?;
    check_manifest(&manifest)?;
    put(db_path, KEY_SERVER_NAME, &manifest.server_name);
    license::store(db_path, &manifest);

    // Only a snapshot is trustworthy when the saved cursor can't be meaningfully continued:
    //  - the server's history changed (new epoch: its state was reset or replaced). Revision numbers
    //    are only comparable within one epoch, so this must be checked directly; a cursor that merely
    //    "looks" valid against the new numbering would silently skip changes and deletions.
    //  - the cursor is ahead of the server, or older than its retention window (tombstones pruned).
    let stored_cursor: u64 = get(db_path, KEY_CURSOR).and_then(|c| c.parse().ok()).unwrap_or(0);
    let stored_epoch = get(db_path, KEY_EPOCH).unwrap_or_default();
    let epoch_changed = !manifest.epoch.is_empty() && stored_epoch != manifest.epoch;
    let mut full = force_full
        || epoch_changed
        || stored_cursor == 0
        || stored_cursor > manifest.revision
        || stored_cursor < manifest.retention_revision;

    if manifest.capabilities.content {
        let mut restarted = false;
        'attempt: loop {
            report.full = full;
            let mut cursor = if full { 0 } else { stored_cursor };
            if full {
                let path = db_path.to_string();
                tokio::task::spawn_blocking(move || {
                    let conn = db::sync::open_sync_conn(&path).map_err(|e| e.to_string())?;
                    db::sync::begin_full_resync(&conn).map_err(|e| e.to_string())
                })
                .await
                .map_err(join_err)??;
            }

            loop {
                if state.cancel.load(Ordering::SeqCst) {
                    report.cancelled = true;
                    progress("done", "Cancelled.", report.pages, &report);
                    return Ok(report);
                }
                let page = match api.changes(cursor, PAGE_LIMIT, full).await {
                    Ok(p) => p,
                    Err(ApiError::ResyncRequired) if !full && !restarted => {
                        // Retention window passed mid-run: start over as a snapshot.
                        restarted = true;
                        full = true;
                        report = SyncReport::default();
                        continue 'attempt;
                    }
                    Err(e) => return Err(api_err(e)),
                };
                report.pages += 1;
                let (revision, has_more) = (page.revision, page.has_more);
                if has_more && revision <= cursor {
                    return Err("The server isn't advancing its revision; aborting.".into());
                }

                let path = db_path.to_string();
                let force = force_full;
                let stats = tokio::task::spawn_blocking(move || {
                    let mut conn = db::sync::open_sync_conn(&path).map_err(|e| e.to_string())?;
                    db::sync::apply_page(&mut conn, &page.upserts, &page.deletes, force).map_err(|e| e.to_string())
                })
                .await
                .map_err(join_err)??;
                report.absorb(stats);
                report.revision = revision;
                cursor = revision;
                progress("applying", "Downloading updates…", report.pages, &report);

                // Deltas are idempotent, so the cursor advances page by page. A snapshot only
                // records it after the sweep below, so an interrupted one starts over.
                if !full {
                    put(db_path, KEY_CURSOR, &revision.to_string());
                }
                if !has_more {
                    break 'attempt;
                }
            }
        }

        if full {
            let path = db_path.to_string();
            let swept = tokio::task::spawn_blocking(move || {
                let mut conn = db::sync::open_sync_conn(&path).map_err(|e| e.to_string())?;
                db::sync::sweep_unseen(&mut conn).map_err(|e| e.to_string())
            })
            .await
            .map_err(join_err)??;
            report.absorb(swept);
            put(db_path, KEY_CURSOR, &report.revision.to_string());
            // Remembered together with the cursor, so an interrupted snapshot starts over.
            put(db_path, KEY_EPOCH, &manifest.epoch);
        }
    }

    if manifest.capabilities.policy {
        progress("policy", "Applying server settings…", report.pages, &report);
        let policy = api.policy().await.map_err(api_err)?;
        let path = db_path.to_string();
        let stats = tokio::task::spawn_blocking(move || {
            let mut conn = db::sync::open_sync_conn(&path).map_err(|e| e.to_string())?;
            db::sync::apply_policy(&mut conn, &policy).map_err(|e| e.to_string())
        })
        .await
        .map_err(join_err)??;
        report.policy_applied = stats.applied;
        report.policy_dropped = stats.dropped;
    } else {
        let path = db_path.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = db::sync::open_sync_conn(&path).map_err(|e| e.to_string())?;
            db::sync::clear_policy(&conn).map_err(|e| e.to_string())
        })
        .await
        .map_err(join_err)??;
    }

    put(db_path, KEY_LAST_AT, &chrono::Utc::now().to_rfc3339());
    progress("done", "Sync complete.", report.pages, &report);
    Ok(report)
}

/// Everything the Sync tab shows in its status card.
#[derive(Debug, Serialize)]
pub struct SyncStatus {
    pub connected: bool,
    pub running: bool,
    pub server_url: String,
    pub server_name: String,
    pub has_token: bool,
    pub last_sync_at: String,
    pub last_error: String,
    pub cursor: u64,
    pub auto_sync: bool,
    pub interval_minutes: u32,
    pub owned_counts: BTreeMap<String, u64>,
    pub locked_settings: Vec<String>,
    pub license: license::LicenseInfo,
}

pub const DEFAULT_INTERVAL_MINUTES: u32 = 60;
pub const MIN_INTERVAL_MINUTES: u32 = 5;

pub fn status(db_path: &str, state: &SyncState) -> Result<SyncStatus, String> {
    let cfg = load_config(db_path);
    let conn = db::sync::open_sync_conn(db_path).map_err(|e| e.to_string())?;
    Ok(SyncStatus {
        connected: cfg.is_some(),
        running: state.is_running(),
        server_url: cfg.as_ref().map(|c| c.url.clone()).unwrap_or_default(),
        server_name: get(db_path, KEY_SERVER_NAME).unwrap_or_default(),
        has_token: cfg.as_ref().map(|c| c.token.is_some()).unwrap_or(false),
        last_sync_at: get(db_path, KEY_LAST_AT).unwrap_or_default(),
        last_error: get(db_path, KEY_LAST_ERROR).unwrap_or_default(),
        cursor: get(db_path, KEY_CURSOR).and_then(|c| c.parse().ok()).unwrap_or(0),
        auto_sync: get(db_path, KEY_AUTO).map(|v| v == "true").unwrap_or(false),
        interval_minutes: get(db_path, KEY_INTERVAL)
            .and_then(|v| v.parse().ok())
            .map(|m: u32| m.max(MIN_INTERVAL_MINUTES))
            .unwrap_or(DEFAULT_INTERVAL_MINUTES),
        owned_counts: db::sync::owned_counts(&conn).map_err(|e| e.to_string())?,
        locked_settings: db::get_locked_settings(db_path).map_err(|e| e.to_string())?,
        license: license::load(db_path),
    })
}

/// Forgets the server. `keep_data` = synced rows stay as ordinary local data; otherwise they are
/// removed (taxonomy nodes still referenced by other videos survive). Policy and license always go.
pub fn disconnect(db_path: &str, keep_data: bool) -> Result<ApplyStats, String> {
    let mut conn = db::sync::open_sync_conn(db_path).map_err(|e| e.to_string())?;
    let stats = if keep_data {
        db::sync::disown_all(&conn).map_err(|e| e.to_string())?;
        ApplyStats::default()
    } else {
        db::sync::remove_all_owned(&mut conn).map_err(|e| e.to_string())?
    };
    db::sync::clear_policy(&conn).map_err(|e| e.to_string())?;
    for key in [KEY_URL, KEY_TOKEN, KEY_CURSOR, KEY_EPOCH, KEY_LAST_AT, KEY_LAST_ERROR, KEY_SERVER_NAME, KEY_LICENSE] {
        db::delete_setting(db_path, key).map_err(|e| e.to_string())?;
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison() {
        assert!(version_lt("0.4.2", "0.4.10"));
        assert!(version_lt("0.4.2", "1.0"));
        assert!(!version_lt("0.4.2", "0.4.2"));
        assert!(!version_lt("1.0.0", "0.9.9"));
        assert!(!version_lt("garbage", "0"));
    }

    #[test]
    fn manifest_compatibility_checks() {
        let mut m = Manifest {
            server_name: "s".into(),
            protocol_version: PROTOCOL_VERSION,
            min_client_version: String::new(),
            pack_version: 1,
            revision: 1,
            epoch: String::new(),
            retention_revision: 0,
            capabilities: Default::default(),
            license_mode: String::new(),
        };
        assert!(check_manifest(&m).is_ok());
        m.protocol_version = PROTOCOL_VERSION + 1;
        assert!(check_manifest(&m).unwrap_err().contains("Update the app"));
        m.protocol_version = PROTOCOL_VERSION;
        m.min_client_version = "99.0.0".into();
        assert!(check_manifest(&m).unwrap_err().contains("newer"));
    }
}
