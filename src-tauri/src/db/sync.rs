//! Applying content from a sync server to the local database.
//!
//! Ownership model: a row is "server-owned" iff `sync_items` has a row for (kind, key). Only owned
//! rows are ever deleted by a sync; on a key collision the server takes the row over. Field
//! merging is "server non-null wins" — a null/absent server field never clobbers a local value
//! (same idea as `save_video` keeping the old summary when the incoming one is NULL).
//!
//! Videos deliberately do NOT go through `save_video`: its post-insert hooks (blockquote cleanup,
//! channel-info footer, summarize-to-NA clearing) rewrite content and aren't idempotent against
//! server-provided text. Only `videos.tokens` is derived here, since it's per-install.

use std::collections::BTreeMap;
use std::time::Duration;

use kinesis_sync_proto::{
    content_hash, is_syncable_setting, link_key, split_link_key, validate_key, BiographyData,
    CustomPromptData, GlossaryData, Item, Kind, Policy, Tombstone, VideoData, VideoLinkData,
    WdbsData, MAX_ITEM_BYTES,
};
use rusqlite::types::Value as Sql;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

use super::schema::table_exists;
use super::search::regenerate_tokens_from_transcript;
use super::wdbs::{ensure_wdbs_path_exists_with_conn, is_unassigned_sentinel, storage_to_display_path, WDBS_ICONS};

/// Largest single enforced setting value (custom theme JSON is the biggest legitimate one).
const MAX_POLICY_VALUE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Default, Clone, Serialize)]
pub struct ApplyStats {
    pub upserted: u64,
    pub unchanged: u64,
    pub deleted: u64,
    /// Tombstones that only dropped ownership (row is still in use, or wasn't safe to delete).
    pub disowned: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
}

impl ApplyStats {
    pub fn merge(&mut self, other: ApplyStats) {
        self.upserted += other.upserted;
        self.unchanged += other.unchanged;
        self.deleted += other.deleted;
        self.disowned += other.disowned;
        self.skipped += other.skipped;
        self.errors.extend(other.errors);
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct PolicyStats {
    pub applied: u64,
    /// Entries refused: not on the allowlist, not locked, oversized.
    pub dropped: u64,
}

type R<T> = std::result::Result<T, String>;

fn db(e: rusqlite::Error) -> String {
    e.to_string()
}

/// A connection for sync writes: generous busy timeout so a sync page waits out a UI write
/// instead of failing with SQLITE_BUSY (every other DB call opens its own short-lived connection).
pub fn open_sync_conn(db_path: &str) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(15))?;
    Ok(conn)
}

// ─── Ownership bookkeeping ────────────────────────────────────────────────────

fn owned_hash(conn: &Connection, kind: Kind, key: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT content_hash FROM sync_items WHERE kind = ?1 AND item_key = ?2",
        params![kind.as_str(), key],
        |row| row.get(0),
    )
    .optional()
}

fn mark_owned(conn: &Connection, kind: Kind, key: &str, rev: i64, hash: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_items (kind, item_key, rev, content_hash, synced_at, seen)
         VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, 1)
         ON CONFLICT(kind, item_key) DO UPDATE SET
            rev = excluded.rev, content_hash = excluded.content_hash,
            synced_at = CURRENT_TIMESTAMP, seen = 1",
        params![kind.as_str(), key, rev, hash],
    )?;
    Ok(())
}

fn mark_seen(conn: &Connection, kind: Kind, key: &str) -> Result<()> {
    conn.execute(
        "UPDATE sync_items SET seen = 1 WHERE kind = ?1 AND item_key = ?2",
        params![kind.as_str(), key],
    )?;
    Ok(())
}

fn disown(conn: &Connection, kind: Kind, key: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM sync_items WHERE kind = ?1 AND item_key = ?2",
        params![kind.as_str(), key],
    )?;
    Ok(())
}

/// How many rows of each kind the server currently owns, for the Sync tab status card.
pub fn owned_counts(conn: &Connection) -> Result<BTreeMap<String, u64>> {
    let mut stmt = conn.prepare("SELECT kind, COUNT(*) FROM sync_items GROUP BY kind")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ─── Column-level merge helpers ───────────────────────────────────────────────

fn s(v: &Option<String>) -> Sql {
    v.clone().map(Sql::Text).unwrap_or(Sql::Null)
}

fn i(v: &Option<i64>) -> Sql {
    v.map(Sql::Integer).unwrap_or(Sql::Null)
}

/// `UPDATE table SET col = COALESCE(?, col) ... WHERE key_col = ?` — null values leave the column
/// untouched. Table and column names are compile-time constants at every call site.
fn update_coalesce(conn: &Connection, table: &str, key_col: &str, key: &str, cols: &[(&str, Sql)]) -> Result<()> {
    if cols.is_empty() {
        return Ok(());
    }
    let sets: Vec<String> = cols.iter().map(|(c, _)| format!("{c} = COALESCE(?, {c})")).collect();
    let sql = format!("UPDATE {table} SET {} WHERE {key_col} = ?", sets.join(", "));
    let mut values: Vec<Sql> = cols.iter().map(|(_, v)| v.clone()).collect();
    values.push(Sql::Text(key.to_string()));
    conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
    Ok(())
}

/// Insert-or-merge: an existing row is updated with `update_coalesce`; a new row is inserted with
/// only its non-null columns (so DB defaults apply), falling back to `insert_defaults` for
/// NOT NULL columns that have none.
fn upsert_coalesce(
    conn: &Connection,
    table: &str,
    key_col: &str,
    key: &str,
    cols: &[(&str, Sql)],
    insert_defaults: &[(&str, Sql)],
) -> Result<()> {
    let exists = conn
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE {key_col} = ?"),
            params![key],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return update_coalesce(conn, table, key_col, key, cols);
    }
    let mut names: Vec<&str> = vec![key_col];
    let mut values: Vec<Sql> = vec![Sql::Text(key.to_string())];
    for (c, v) in cols {
        let v = if matches!(v, Sql::Null) {
            match insert_defaults.iter().find(|(dc, _)| dc == c) {
                Some((_, d)) => d.clone(),
                None => continue,
            }
        } else {
            v.clone()
        };
        names.push(c);
        values.push(v);
    }
    let placeholders = vec!["?"; names.len()].join(", ");
    let sql = format!("INSERT INTO {table} ({}) VALUES ({placeholders})", names.join(", "));
    conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
    Ok(())
}

// ─── Per-kind apply ───────────────────────────────────────────────────────────

fn parse<T: serde::de::DeserializeOwned>(item: &Item) -> R<T> {
    serde_json::from_value(item.data.clone()).map_err(|e| format!("bad {} payload: {e}", item.kind))
}

/// tblWDBS display path (":UAP-GERB") → the storage form used by videos.WDBS ("θψUAP_GERB").
fn display_to_storage_path(display: &str) -> String {
    let body = display.strip_prefix(':').unwrap_or(display);
    format!("θψ{}", body.replace('-', "_"))
}

fn apply_wdbs(conn: &Connection, item: &Item) -> R<bool> {
    let d: WdbsData = parse(item)?;
    if !item.key.starts_with(':') {
        return Err("WDBS path must start with ':'".into());
    }
    if let Some(icon) = &d.icon {
        if !icon.is_empty() && !WDBS_ICONS.contains(&icon.as_str()) {
            return Err(format!("unknown icon '{icon}'"));
        }
    }
    if !table_exists(conn, "tblWDBS").map_err(db)? {
        return Ok(false);
    }
    ensure_wdbs_path_exists_with_conn(conn, &item.key).map_err(db)?;
    update_coalesce(
        conn,
        "tblWDBS",
        "WDBS",
        &item.key,
        &[
            ("lev", i(&d.lev)),
            ("WDID", s(&d.wdid)),
            ("WDInfo", s(&d.info)),
            ("WDIcon", s(&d.icon)),
            ("WDDefault", i(&d.default)),
        ],
    )
    .map_err(db)?;
    Ok(true)
}

fn apply_video(conn: &Connection, item: &Item) -> R<bool> {
    let d: VideoData = parse(item)?;
    // Taxonomy first: on a production database a trigger rejects a videos.WDBS with no tblWDBS row.
    let wdbs = d.wdbs.as_deref().map(|w| if w == "θψ" { ":" } else { w }).filter(|w| !w.is_empty());
    if let Some(w) = wdbs {
        if !is_unassigned_sentinel(w) {
            ensure_wdbs_path_exists_with_conn(conn, &storage_to_display_path(w)).map_err(db)?;
        }
    }
    upsert_coalesce(
        conn,
        "videos",
        "video_id",
        &item.key,
        &[
            ("title", s(&d.title)),
            ("author", s(&d.author)),
            ("handle", s(&d.handle)),
            ("length_seconds", i(&d.length_seconds)),
            ("transcript", s(&d.transcript)),
            ("summary", s(&d.summary)),
            ("view_count", i(&d.view_count)),
            ("published_at", s(&d.published_at)),
            ("tags", s(&d.tags)),
        ],
        &[],
    )
    .map_err(db)?;
    if let Some(w) = wdbs {
        conn.execute("UPDATE videos SET WDBS = ?1 WHERE video_id = ?2", params![w, item.key]).map_err(db)?;
    }
    if d.transcript.is_some() {
        regenerate_tokens_from_transcript(conn, &item.key).map_err(db)?;
    }
    Ok(true)
}

fn apply_video_link(conn: &Connection, item: &Item) -> R<bool> {
    let d: VideoLinkData = parse(item)?;
    if item.key != link_key(&d.video_id, &d.wdbs) || split_link_key(&item.key).is_none() {
        return Err("link key does not match its payload".into());
    }
    if !is_unassigned_sentinel(&d.wdbs) {
        ensure_wdbs_path_exists_with_conn(conn, &storage_to_display_path(&d.wdbs)).map_err(db)?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO video_wdbs_links (video_id, wdbs) VALUES (?1, ?2)",
        params![d.video_id, d.wdbs],
    )
    .map_err(db)?;
    Ok(true)
}

fn apply_glossary(conn: &Connection, item: &Item) -> R<bool> {
    let d: GlossaryData = parse(item)?;
    upsert_coalesce(
        conn,
        "glossary",
        "term",
        &item.key,
        &[("definition", s(&d.definition))],
        &[("definition", Sql::Text(String::new()))],
    )
    .map_err(db)?;
    // `Some` is the complete set of top-level drives (an empty list uncategorizes the term);
    // `None` means the sender predates drive assignments, so the local ones stay as they are.
    if let Some(drives) = &d.drives {
        let roots = super::glossary::validated_roots(drives).map_err(|e| e.to_string())?;
        for root in &roots {
            ensure_wdbs_path_exists_with_conn(conn, root).map_err(db)?;
        }
        super::glossary::set_glossary_drives(conn, &item.key, &roots).map_err(db)?;
    }
    Ok(true)
}

fn apply_biography(conn: &Connection, item: &Item) -> R<bool> {
    let d: BiographyData = parse(item)?;
    upsert_coalesce(
        conn,
        "biographies",
        "handle",
        &item.key,
        &[
            ("display_name", s(&d.display_name)),
            ("bio", s(&d.bio)),
            ("wikipedia", s(&d.wikipedia)),
            ("website", s(&d.website)),
            ("twitter", s(&d.twitter)),
            ("instagram", s(&d.instagram)),
            ("facebook", s(&d.facebook)),
            ("threads", s(&d.threads)),
            ("youtube", s(&d.youtube)),
            ("tiktok", s(&d.tiktok)),
            ("twitch", s(&d.twitch)),
            ("reddit", s(&d.reddit)),
            ("discord", s(&d.discord)),
            ("channel_id", s(&d.channel_id)),
            ("subscriber_count", i(&d.subscriber_count)),
        ],
        &[],
    )
    .map_err(db)?;
    Ok(true)
}

fn apply_custom_prompt(conn: &Connection, item: &Item) -> R<bool> {
    let d: CustomPromptData = parse(item)?;
    upsert_coalesce(
        conn,
        "custom_prompts",
        "handle",
        &item.key,
        &[
            ("local_prompt_text", s(&d.local_prompt_text)),
            ("cloud_prompt_text", s(&d.cloud_prompt_text)),
        ],
        &[],
    )
    .map_err(db)?;
    Ok(true)
}

enum Outcome {
    Applied,
    Unchanged,
    Skipped,
}

/// Applies one item inside the caller's savepoint. `Ok(Skipped)` covers unknown kinds and tables
/// this database doesn't have; `Err` is a genuine problem with the item (recorded, page continues).
/// `track` = the item comes from the sync server, so its row becomes server-owned. Without it (a
/// pack imported from a file) the row stays plain local data, and rows the server already owns are
/// left alone so an import can never override what the server is responsible for.
fn apply_item(conn: &Connection, item: &Item, force: bool, track: bool) -> R<Outcome> {
    let Some(kind) = Kind::parse(&item.kind) else {
        return Ok(Outcome::Skipped);
    };
    validate_key(&item.key)?;
    // Cheap size guard before doing any work with the payload.
    if item.data.to_string().len() > MAX_ITEM_BYTES {
        return Err(format!("item larger than {MAX_ITEM_BYTES} bytes"));
    }
    // The server's own `hash` is never trusted as a cache key: it's recomputed from the payload.
    let hash = content_hash(&item.kind, &item.key, &item.data);
    let owned = owned_hash(conn, kind, &item.key).map_err(db)?;
    if !track && owned.is_some() {
        return Ok(Outcome::Skipped);
    }
    if track && !force && owned.as_deref() == Some(hash.as_str()) {
        mark_seen(conn, kind, &item.key).map_err(db)?;
        return Ok(Outcome::Unchanged);
    }
    let applied = match kind {
        Kind::Wdbs => apply_wdbs(conn, item)?,
        Kind::Video => apply_video(conn, item)?,
        Kind::VideoLink => apply_video_link(conn, item)?,
        Kind::Glossary => apply_glossary(conn, item)?,
        Kind::Biography => apply_biography(conn, item)?,
        Kind::CustomPrompt => apply_custom_prompt(conn, item)?,
    };
    if !applied {
        return Ok(Outcome::Skipped);
    }
    if track {
        mark_owned(conn, kind, &item.key, item.rev.unwrap_or(0) as i64, &hash).map_err(db)?;
    }
    Ok(Outcome::Applied)
}

/// True when some video, link or child node still uses this taxonomy node.
fn wdbs_in_use(conn: &Connection, display_key: &str) -> Result<bool> {
    let storage = display_to_storage_path(display_key);
    let used_by_videos: i64 = conn.query_row(
        "SELECT COUNT(*) FROM videos WHERE WDBS = ?1 OR substr(WDBS, 1, length(?1) + 1) = ?1 || '_'",
        params![storage],
        |r| r.get(0),
    )?;
    let used_by_links: i64 = conn.query_row(
        "SELECT COUNT(*) FROM video_wdbs_links WHERE wdbs = ?1 OR substr(wdbs, 1, length(?1) + 1) = ?1 || '_'",
        params![storage],
        |r| r.get(0),
    )?;
    let children: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tblWDBS WHERE substr(WDBS, 1, length(?1) + 1) = ?1 || '-'",
        params![display_key],
        |r| r.get(0),
    )?;
    Ok(used_by_videos + used_by_links + children > 0)
}

enum DeleteOutcome {
    Deleted,
    Disowned,
    NotOwned,
}

fn apply_delete(conn: &Connection, t: &Tombstone) -> R<DeleteOutcome> {
    let Some(kind) = Kind::parse(&t.kind) else {
        return Ok(DeleteOutcome::NotOwned);
    };
    if owned_hash(conn, kind, &t.key).map_err(db)?.is_none() {
        // A local row the server never owned: not ours to delete.
        return Ok(DeleteOutcome::NotOwned);
    }
    let outcome = match kind {
        Kind::Wdbs => {
            if table_exists(conn, "tblWDBS").map_err(db)? && !wdbs_in_use(conn, &t.key).map_err(db)? {
                conn.execute("DELETE FROM tblWDBS WHERE WDBS = ?1", params![t.key]).map_err(db)?;
                DeleteOutcome::Deleted
            } else {
                DeleteOutcome::Disowned
            }
        }
        Kind::Video => {
            conn.execute("DELETE FROM videos WHERE video_id = ?1", params![t.key]).map_err(db)?;
            // Link rows go with the video (trigger); their ownership rows would otherwise dangle.
            conn.execute(
                "DELETE FROM sync_items WHERE kind = 'video_link'
                 AND substr(item_key, 1, length(?1) + 1) = ?1 || '|'",
                params![t.key],
            )
            .map_err(db)?;
            DeleteOutcome::Deleted
        }
        Kind::VideoLink => {
            if let Some((video_id, wdbs)) = split_link_key(&t.key) {
                conn.execute(
                    "DELETE FROM video_wdbs_links WHERE video_id = ?1 AND wdbs = ?2",
                    params![video_id, wdbs],
                )
                .map_err(db)?;
            }
            DeleteOutcome::Deleted
        }
        Kind::Glossary => {
            conn.execute("DELETE FROM glossary WHERE term = ?1", params![t.key]).map_err(db)?;
            conn.execute("DELETE FROM glossary_drives WHERE term = ?1", params![t.key]).map_err(db)?;
            DeleteOutcome::Deleted
        }
        Kind::Biography => {
            conn.execute("DELETE FROM biographies WHERE handle = ?1", params![t.key]).map_err(db)?;
            DeleteOutcome::Deleted
        }
        Kind::CustomPrompt => {
            conn.execute("DELETE FROM custom_prompts WHERE handle = ?1", params![t.key]).map_err(db)?;
            DeleteOutcome::Deleted
        }
    };
    disown(conn, kind, &t.key).map_err(db)?;
    Ok(outcome)
}

// ─── Page / batch entry points ────────────────────────────────────────────────

fn kind_rank(kind: &str) -> usize {
    Kind::parse(kind).map(|k| k.order()).unwrap_or(usize::MAX)
}

/// Deletes in reverse dependency order (links, videos, ..., taxonomy last) in one transaction.
/// Each tombstone runs in its own savepoint so one failure doesn't lose the rest.
pub fn apply_deletes(conn: &mut Connection, deletes: &[Tombstone]) -> Result<ApplyStats> {
    let mut tx = conn.transaction()?;
    let stats = apply_deletes_in(&mut tx, deletes)?;
    tx.commit()?;
    Ok(stats)
}

fn apply_deletes_in(tx: &mut rusqlite::Transaction, deletes: &[Tombstone]) -> Result<ApplyStats> {
    let mut stats = ApplyStats::default();
    let mut ordered: Vec<&Tombstone> = deletes.iter().collect();
    ordered.sort_by_key(|t| std::cmp::Reverse(kind_rank(&t.kind)));
    for t in ordered {
        let sp = tx.savepoint()?;
        match apply_delete(&sp, t) {
            Ok(DeleteOutcome::Deleted) => {
                sp.commit()?;
                stats.deleted += 1;
            }
            Ok(DeleteOutcome::Disowned) => {
                sp.commit()?;
                stats.disowned += 1;
            }
            Ok(DeleteOutcome::NotOwned) => stats.skipped += 1,
            Err(e) => stats.errors.push(format!("delete {} {}: {e}", t.kind, t.key)),
        }
    }
    Ok(stats)
}

/// Applies one `/changes` page (or one batch of a pack): upserts in dependency order, then
/// tombstones, all in a single transaction so the UI never sees a half-applied page. `force`
/// rewrites rows even when their content hash is unchanged (Full resync).
pub fn apply_page(conn: &mut Connection, upserts: &[Item], deletes: &[Tombstone], force: bool) -> Result<ApplyStats> {
    apply_page_with(conn, upserts, deletes, force, true)
}

/// Applies a batch of items from an imported pack as ordinary local rows (no server ownership).
/// Existing local rows are merged with the same "non-null wins" rule; server-owned rows are skipped.
pub fn import_items(conn: &mut Connection, items: &[Item]) -> Result<ApplyStats> {
    apply_page_with(conn, items, &[], true, false)
}

fn apply_page_with(
    conn: &mut Connection,
    upserts: &[Item],
    deletes: &[Tombstone],
    force: bool,
    track: bool,
) -> Result<ApplyStats> {
    let mut tx = conn.transaction()?;
    let mut stats = ApplyStats::default();

    let mut ordered: Vec<&Item> = upserts.iter().collect();
    ordered.sort_by_key(|it| kind_rank(&it.kind));
    for item in ordered {
        let sp = tx.savepoint()?;
        match apply_item(&sp, item, force, track) {
            Ok(Outcome::Applied) => {
                sp.commit()?;
                stats.upserted += 1;
            }
            Ok(Outcome::Unchanged) => {
                sp.commit()?;
                stats.unchanged += 1;
            }
            Ok(Outcome::Skipped) => stats.skipped += 1,
            // Dropping the savepoint rolls this item back; the page carries on.
            Err(e) => stats.errors.push(format!("{} {}: {e}", item.kind, item.key)),
        }
    }
    stats.merge(apply_deletes_in(&mut tx, deletes)?);
    tx.commit()?;
    Ok(stats)
}

// ─── Full resync: mark and sweep ──────────────────────────────────────────────

/// Marks every owned row as not-yet-seen. Rows the snapshot then delivers (changed or not) are
/// marked seen again, so whatever is still unseen afterwards no longer exists on the server.
pub fn begin_full_resync(conn: &Connection) -> Result<()> {
    conn.execute("UPDATE sync_items SET seen = 0", [])?;
    Ok(())
}

pub fn sweep_unseen(conn: &mut Connection) -> Result<ApplyStats> {
    let stale: Vec<Tombstone> = {
        let mut stmt = conn.prepare("SELECT kind, item_key FROM sync_items WHERE seen = 0")?;
        let rows = stmt.query_map([], |row| {
            Ok(Tombstone { kind: row.get(0)?, key: row.get(1)?, rev: 0 })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    apply_deletes(conn, &stale)
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

/// Keeps every synced row but forgets that the server owned it, so it becomes ordinary local data.
pub fn disown_all(conn: &Connection) -> Result<u64> {
    Ok(conn.execute("DELETE FROM sync_items", [])? as u64)
}

/// Removes every server-owned row (taxonomy nodes still in use survive, just disowned).
pub fn remove_all_owned(conn: &mut Connection) -> Result<ApplyStats> {
    let owned: Vec<Tombstone> = {
        let mut stmt = conn.prepare("SELECT kind, item_key FROM sync_items")?;
        let rows = stmt.query_map([], |row| {
            Ok(Tombstone { kind: row.get(0)?, key: row.get(1)?, rev: 0 })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let stats = apply_deletes(conn, &owned)?;
    conn.execute("DELETE FROM sync_items", [])?;
    Ok(stats)
}

// ─── Policy ───────────────────────────────────────────────────────────────────

/// Replaces the enforced-settings overlay. Only keys that are BOTH on the syncable allowlist and
/// listed as locked are kept: a server can never enforce (or read back) API keys, paths or
/// migration flags, and unlocked "suggestions" aren't part of v1.
pub fn apply_policy(conn: &mut Connection, policy: &Policy) -> Result<PolicyStats> {
    let tx = conn.transaction()?;
    let mut stats = PolicyStats::default();
    tx.execute("DELETE FROM sync_policy", [])?;
    for (key, value) in &policy.settings {
        let locked = policy.locked.iter().any(|k| k == key);
        if !locked || !is_syncable_setting(key) || value.len() > MAX_POLICY_VALUE_BYTES {
            stats.dropped += 1;
            continue;
        }
        tx.execute(
            "INSERT OR REPLACE INTO sync_policy (key, value, locked) VALUES (?1, ?2, 1)",
            params![key, value],
        )?;
        stats.applied += 1;
    }
    tx.commit()?;
    Ok(stats)
}

pub fn clear_policy(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM sync_policy", [])?;
    Ok(())
}

#[cfg(test)]
pub fn policy_count(conn: &Connection) -> Result<u64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM sync_policy", [], |r| r.get::<_, i64>(0))? as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use serde_json::{json, Value};

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_sync_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn item(kind: &str, key: &str, data: Value) -> Item {
        Item { kind: kind.into(), key: key.into(), rev: Some(1), hash: String::new(), data }
    }

    fn tomb(kind: &str, key: &str) -> Tombstone {
        Tombstone { kind: kind.into(), key: key.into(), rev: 2 }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn text(conn: &Connection, sql: &str) -> Option<String> {
        conn.query_row(sql, [], |r| r.get::<_, Option<String>>(0)).unwrap()
    }

    #[test]
    fn server_adopts_colliding_local_row_and_null_fields_do_not_clobber() {
        let db_path = temp_db("adopt");
        let mut conn = open_sync_conn(&db_path).unwrap();
        conn.execute(
            "INSERT INTO videos (video_id, title, summary, transcript) VALUES ('vid1', 'Local title', 'My own summary', 'old words')",
            [],
        )
        .unwrap();

        let stats = apply_page(
            &mut conn,
            &[item("video", "vid1", json!({"title": "Server title", "transcript": "fresh transcript words"}))],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(stats.upserted, 1, "{:?}", stats.errors);
        assert_eq!(text(&conn, "SELECT title FROM videos WHERE video_id='vid1'").as_deref(), Some("Server title"));
        assert_eq!(
            text(&conn, "SELECT summary FROM videos WHERE video_id='vid1'").as_deref(),
            Some("My own summary"),
            "a null server field must not clobber the local value"
        );
        // Transcript stored verbatim (no footer/blockquote hooks), and tokens derived locally.
        assert_eq!(
            text(&conn, "SELECT transcript FROM videos WHERE video_id='vid1'").as_deref(),
            Some("fresh transcript words")
        );
        assert!(text(&conn, "SELECT tokens FROM videos WHERE video_id='vid1'").unwrap_or_default().contains("fresh"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_items WHERE kind='video' AND item_key='vid1'"), 1);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn unchanged_content_is_skipped_unless_forced() {
        let db_path = temp_db("hash");
        let mut conn = open_sync_conn(&db_path).unwrap();
        let it = item("glossary", "term", json!({"definition": "d"}));
        assert_eq!(apply_page(&mut conn, &[it.clone()], &[], false).unwrap().upserted, 1);
        assert_eq!(apply_page(&mut conn, &[it.clone()], &[], false).unwrap().unchanged, 1);

        conn.execute("UPDATE glossary SET definition = 'edited locally' WHERE term = 'term'", []).unwrap();
        // Same hash: delta sync leaves the user's local edit alone...
        apply_page(&mut conn, &[it.clone()], &[], false).unwrap();
        assert_eq!(text(&conn, "SELECT definition FROM glossary WHERE term='term'").as_deref(), Some("edited locally"));
        // ...a forced (Full resync) pass restores the server's version.
        assert_eq!(apply_page(&mut conn, &[it], &[], true).unwrap().upserted, 1);
        assert_eq!(text(&conn, "SELECT definition FROM glossary WHERE term='term'").as_deref(), Some("d"));
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn tombstones_only_delete_owned_rows() {
        let db_path = temp_db("tomb");
        let mut conn = open_sync_conn(&db_path).unwrap();
        conn.execute("INSERT INTO glossary (term, definition) VALUES ('mine', 'local')", []).unwrap();
        apply_page(&mut conn, &[item("glossary", "theirs", json!({"definition": "server"}))], &[], false).unwrap();

        let stats = apply_page(&mut conn, &[], &[tomb("glossary", "mine"), tomb("glossary", "theirs")], false).unwrap();
        assert_eq!(stats.deleted, 1);
        assert_eq!(stats.skipped, 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='mine'"), 1, "local row must survive");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='theirs'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_items"), 0);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn taxonomy_is_applied_before_videos_regardless_of_page_order() {
        let db_path = temp_db("order");
        let mut conn = open_sync_conn(&db_path).unwrap();
        // Video listed BEFORE the taxonomy node it points at.
        let items = [
            item("video", "vidA", json!({"title": "A", "wdbs": "θψUAP_GERB"})),
            item("wdbs", ":UAP-GERB", json!({"lev": 2, "wdid": "GERB", "info": "Gerb Alias", "icon": "star"})),
        ];
        let stats = apply_page(&mut conn, &items, &[], false).unwrap();
        assert_eq!(stats.upserted, 2, "{:?}", stats.errors);
        assert_eq!(text(&conn, "SELECT WDBS FROM videos WHERE video_id='vidA'").as_deref(), Some("θψUAP_GERB"));
        assert_eq!(text(&conn, "SELECT WDInfo FROM tblWDBS WHERE WDBS=':UAP-GERB'").as_deref(), Some("Gerb Alias"));
        assert_eq!(text(&conn, "SELECT WDIcon FROM tblWDBS WHERE WDBS=':UAP-GERB'").as_deref(), Some("star"));
        // The parent level was created too.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tblWDBS WHERE WDBS=':UAP'"), 1);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn unknown_icons_and_kinds_are_not_applied() {
        let db_path = temp_db("reject");
        let mut conn = open_sync_conn(&db_path).unwrap();
        let stats = apply_page(
            &mut conn,
            &[
                item("wdbs", ":X", json!({"icon": "<script>"})),
                item("future_kind", "k", json!({})),
                item("glossary", "", json!({"definition": "no key"})),
            ],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(stats.upserted, 0);
        assert_eq!(stats.skipped, 1, "unknown kinds are skipped, not fatal");
        assert_eq!(stats.errors.len(), 2, "{:?}", stats.errors);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_items"), 0);
        let _ = std::fs::remove_file(&db_path);
    }

    fn drives_of(conn: &Connection, term: &str) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT root FROM glossary_drives WHERE term = ?1 ORDER BY root").unwrap();
        stmt.query_map([term], |r| r.get::<_, String>(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    #[test]
    fn glossary_drive_assignments_follow_the_server_and_only_when_it_sends_them() {
        let db_path = temp_db("gdrives");
        let mut conn = open_sync_conn(&db_path).unwrap();
        let with = |drives: Value| item("glossary", "Halving", json!({"definition": "Supply cut", "drives": drives}));

        apply_page(&mut conn, &[with(json!([":CRYPTO", ":FIN"]))], &[], false).unwrap();
        assert_eq!(drives_of(&conn, "Halving"), vec![":CRYPTO", ":FIN"]);
        // The root gets registered as a taxonomy node too, so it exists locally.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tblWDBS WHERE WDBS = ':CRYPTO' AND lev = 1"), 1);

        // An older server that says nothing about drives leaves the assignments alone...
        apply_page(&mut conn, &[item("glossary", "Halving", json!({"definition": "Supply cut, revised"}))], &[], false).unwrap();
        assert_eq!(drives_of(&conn, "Halving"), vec![":CRYPTO", ":FIN"]);

        // ...while an explicit list replaces them, and an empty one uncategorizes.
        apply_page(&mut conn, &[with(json!([":FIN"]))], &[], false).unwrap();
        assert_eq!(drives_of(&conn, "Halving"), vec![":FIN"]);
        apply_page(&mut conn, &[with(json!([]))], &[], false).unwrap();
        assert!(drives_of(&conn, "Halving").is_empty());
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn a_deeper_drive_level_from_a_server_is_refused_and_nothing_is_half_applied() {
        let db_path = temp_db("gdeep");
        let mut conn = open_sync_conn(&db_path).unwrap();
        let stats = apply_page(
            &mut conn,
            &[item("glossary", "Bad", json!({"definition": "d", "drives": [":CRYPTO-DOAC"]}))],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(stats.upserted, 0);
        assert_eq!(stats.errors.len(), 1, "{:?}", stats.errors);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term = 'Bad'"), 0, "the term itself was rolled back too");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary_drives"), 0);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn quick_tags_from_a_server_never_get_drives_and_deleting_a_term_drops_its_drives() {
        let db_path = temp_db("gquick");
        let mut conn = open_sync_conn(&db_path).unwrap();
        apply_page(
            &mut conn,
            &[
                item("glossary", "qt", json!({"definition": "", "drives": [":CRYPTO"]})),
                item("glossary", "Std", json!({"definition": "d", "drives": [":CRYPTO"]})),
            ],
            &[],
            false,
        )
        .unwrap();
        assert!(drives_of(&conn, "qt").is_empty());
        assert_eq!(drives_of(&conn, "Std"), vec![":CRYPTO"]);

        apply_page(&mut conn, &[], &[tomb("glossary", "Std")], false).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary_drives"), 0, "no orphaned assignments");
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn a_bad_item_rolls_back_alone_and_the_page_still_commits() {
        let db_path = temp_db("isolate");
        let mut conn = open_sync_conn(&db_path).unwrap();
        let stats = apply_page(
            &mut conn,
            &[
                item("glossary", "good", json!({"definition": "ok"})),
                item("wdbs", "no-leading-colon", json!({})),
            ],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(stats.upserted, 1);
        assert_eq!(stats.errors.len(), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='good'"), 1);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn full_resync_sweeps_rows_the_server_no_longer_has() {
        let db_path = temp_db("sweep");
        let mut conn = open_sync_conn(&db_path).unwrap();
        conn.execute("INSERT INTO glossary (term, definition) VALUES ('local', 'x')", []).unwrap();
        apply_page(
            &mut conn,
            &[
                item("glossary", "keep", json!({"definition": "k"})),
                item("glossary", "stale", json!({"definition": "s"})),
            ],
            &[],
            false,
        )
        .unwrap();

        begin_full_resync(&conn).unwrap();
        // The snapshot only contains `keep` (unchanged content, so this exercises the seen-marking).
        apply_page(&mut conn, &[item("glossary", "keep", json!({"definition": "k"}))], &[], false).unwrap();
        let stats = sweep_unseen(&mut conn).unwrap();
        assert_eq!(stats.deleted, 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='stale'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='keep'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='local'"), 1);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn deleting_a_video_drops_its_links_and_their_ownership() {
        let db_path = temp_db("vidlinks");
        let mut conn = open_sync_conn(&db_path).unwrap();
        apply_page(
            &mut conn,
            &[
                item("video", "vidB", json!({"title": "B"})),
                item("video_link", "vidB|θψCRYPTO", json!({"video_id": "vidB", "wdbs": "θψCRYPTO"})),
            ],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM video_wdbs_links WHERE video_id='vidB'"), 1);
        apply_page(&mut conn, &[], &[tomb("video", "vidB")], false).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM videos WHERE video_id='vidB'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_items WHERE kind='video_link'"), 0);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn taxonomy_still_in_use_is_disowned_not_deleted() {
        let db_path = temp_db("wdbsuse");
        let mut conn = open_sync_conn(&db_path).unwrap();
        apply_page(&mut conn, &[item("wdbs", ":CRYPTO", json!({"lev": 1, "wdid": "CRYPTO"}))], &[], false).unwrap();
        // The user files one of their own videos there.
        conn.execute("INSERT INTO videos (video_id, title, WDBS) VALUES ('mine', 'm', 'θψCRYPTO')", []).unwrap();
        let stats = apply_page(&mut conn, &[], &[tomb("wdbs", ":CRYPTO")], false).unwrap();
        assert_eq!(stats.disowned, 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tblWDBS WHERE WDBS=':CRYPTO'"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_items"), 0);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn policy_keeps_only_locked_allowlisted_keys() {
        let db_path = temp_db("policy");
        let mut conn = open_sync_conn(&db_path).unwrap();
        let mut policy = Policy::default();
        for (k, v) in [
            ("showBiography", "false"),
            ("venice_api_key", "stolen"),
            ("api_key", "stolen"),
            ("sync_token", "x"),
            ("showDrive", "false"), // allowlisted but not listed as locked
            ("not_a_setting", "1"),
        ] {
            policy.settings.insert(k.into(), v.into());
        }
        policy.locked = vec!["showBiography".into(), "venice_api_key".into(), "api_key".into(), "sync_token".into(), "not_a_setting".into()];
        let stats = apply_policy(&mut conn, &policy).unwrap();
        assert_eq!(stats.applied, 1);
        assert_eq!(stats.dropped, 5);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_policy"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_policy WHERE key LIKE '%api_key%'"), 0);
        assert_eq!(crate::db::get_setting(&db_path, "showBiography").unwrap().as_deref(), Some("false"));

        // A new policy replaces the old one wholesale (so removing a lock server-side releases it).
        apply_policy(&mut conn, &Policy::default()).unwrap();
        assert_eq!(policy_count(&conn).unwrap(), 0);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn disconnect_can_keep_or_remove_synced_rows() {
        let db_path = temp_db("disconnect");
        let mut conn = open_sync_conn(&db_path).unwrap();
        apply_page(&mut conn, &[item("glossary", "g", json!({"definition": "d"}))], &[], false).unwrap();
        assert_eq!(owned_counts(&conn).unwrap().get("glossary"), Some(&1));

        assert_eq!(disown_all(&conn).unwrap(), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='g'"), 1, "keep: row becomes local");

        apply_page(&mut conn, &[item("glossary", "h", json!({"definition": "d"}))], &[], false).unwrap();
        let stats = remove_all_owned(&mut conn).unwrap();
        assert_eq!(stats.deleted, 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='h'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM glossary WHERE term='g'"), 1);
        let _ = std::fs::remove_file(&db_path);
    }
}
