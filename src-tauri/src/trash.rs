//! The Trash: what was deleted during this run of the app, kept in memory so a delete can be undone.
//!
//! It is deliberately not saved anywhere. Nothing is written to the database, so it can't pile up over time or
//! travel through sync and exports: quitting the app, or switching workspace (whose items these are), empties it.
//!
//! A delete takes more than its own row with it, so what's kept is enough to put everything back:
//! - a video: its row, its Drive links, its place in Drive sequences, its note, its attachments (and the
//!   stored files only it used), and the links to it that were removed from other texts;
//! - a glossary entry: its row, and the links to the term that were removed from other texts.
//!
//! Deleting the same thing again replaces the older copy of it in the Trash (only the latest one is kept),
//! since the two could never both be restored. Restoring something that has since been made again is refused.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db;
use crate::db::links::{undo_text_changes, TextChange};

/// The most the Trash holds before its oldest items are let go (attachments can be large).
const MAX_TRASH_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashKind {
    Video,
    Glossary,
}

impl TrashKind {
    pub fn parse(s: &str) -> Option<TrashKind> {
        match s {
            "video" => Some(TrashKind::Video),
            "glossary" => Some(TrashKind::Glossary),
            _ => None,
        }
    }
}

/// One table's rows for a deleted video, in a form that can be inserted again.
struct TableRows {
    table: &'static str,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    /// Rows that may already be there again (a stored file another attachment also uses, a Drive link) are skipped.
    ignore_conflicts: bool,
}

enum Payload {
    Video(Vec<TableRows>),
    Glossary { term: String, definition: String, drives: Vec<String> },
}

pub struct TrashItem {
    id: u64,
    kind: TrashKind,
    /// What makes two deletions "the same thing": the video's ID, or the term (ignoring case) with its Drives.
    key: String,
    label: String,
    detail: String,
    deleted_at: i64,
    /// The database it came from. Items never show in, or restore into, another workspace.
    db_path: String,
    payload: Payload,
    changes: Vec<TextChange>,
    bytes: usize,
}

/// What the screen is told about an item.
#[derive(Serialize)]
pub struct TrashEntry {
    pub id: u64,
    pub kind: TrashKind,
    pub label: String,
    pub detail: String,
    /// Milliseconds since the epoch.
    pub deleted_at: i64,
}

#[derive(Default)]
pub struct TrashStore {
    items: Vec<TrashItem>,
    next_id: u64,
}

pub struct TrashState(pub Mutex<TrashStore>);

impl Default for TrashState {
    fn default() -> Self {
        TrashState(Mutex::new(TrashStore::default()))
    }
}

/// The app's one Trash.
pub fn store(app: &AppHandle) -> &Mutex<TrashStore> {
    &app.state::<TrashState>().inner().0
}

fn lock(store: &Mutex<TrashStore>) -> std::sync::MutexGuard<'_, TrashStore> {
    store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn value_bytes(v: &Value) -> usize {
    match v {
        Value::Text(s) => s.len(),
        Value::Blob(b) => b.len(),
        _ => 8,
    }
}

/// The rows of `table` matching `where_sql` (with `args`), or None when the table isn't in this database.
fn snapshot(conn: &Connection, table: &'static str, where_sql: &str, args: &[&dyn rusqlite::ToSql], omit: &[&str], ignore_conflicts: bool) -> rusqlite::Result<Option<TableRows>> {
    if !db::table_exists(conn, table)? {
        return Ok(None);
    }
    // Generated columns (the production schema's Videos.fkWDBS) work themselves out and refuse to be inserted into.
    let generated: Vec<String> = {
        let mut info = conn.prepare(&format!("PRAGMA table_xinfo({table})"))?;
        // table_xinfo: cid, name, type, notnull, dflt_value, pk, hidden (2 = virtual generated, 3 = stored generated).
        let rows = info.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(6)?)))?;
        rows.filter_map(|r| r.ok()).filter(|(_, hidden)| *hidden == 2 || *hidden == 3).map(|(name, _)| name).collect()
    };
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE {where_sql}"))?;
    let all_columns: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let skipped = |c: &str| omit.iter().any(|o| o.eq_ignore_ascii_case(c)) || generated.iter().any(|g| g.eq_ignore_ascii_case(c));
    let keep: Vec<usize> = (0..all_columns.len()).filter(|&i| !skipped(&all_columns[i])).collect();
    let columns: Vec<String> = keep.iter().map(|&i| all_columns[i].clone()).collect();
    let rows: Vec<Vec<Value>> = stmt
        .query_map(args, |row| keep.iter().map(|&i| row.get::<_, Value>(i)).collect::<rusqlite::Result<Vec<Value>>>())?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(TableRows { table, columns, rows, ignore_conflicts }))
}

fn table_bytes(t: &TableRows) -> usize {
    t.rows.iter().flatten().map(value_bytes).sum()
}

/// Everything a video's delete takes with it, read before it's deleted.
fn capture_video(db_path: &str, video_id: &str) -> rusqlite::Result<Option<(Payload, String, String, usize)>> {
    let conn = Connection::open(db_path)?;
    let id = [&video_id as &dyn rusqlite::ToSql];
    let Some(video) = snapshot(&conn, "Videos", "video_id = ?1", &id, &[], false)? else { return Ok(None) };
    if video.rows.is_empty() {
        return Ok(None);
    }
    let title_at = video.columns.iter().position(|c| c.eq_ignore_ascii_case("title"));
    let author_at = video.columns.iter().position(|c| c.eq_ignore_ascii_case("author"));
    let text_at = |i: Option<usize>| match i.and_then(|i| video.rows[0].get(i)) {
        Some(Value::Text(s)) => s.clone(),
        _ => String::new(),
    };
    let (title, author) = (text_at(title_at), text_at(author_at));

    let mut tables = vec![video];
    for (table, omit, ignore) in [("VideoWDBSLinks", &[][..], true), ("DriveSequence", &[][..], true), ("VideoNotes", &[][..], true)] {
        if let Some(rows) = snapshot(&conn, table, "video_id = ?1", &id, omit, ignore)? {
            if !rows.rows.is_empty() {
                tables.push(rows);
            }
        }
    }
    // The stored files only this video used go when it does (see the delete trigger); keep them to put back.
    if let Some(blobs) = snapshot(
        &conn,
        "AttachmentBlobs",
        "hash IN (SELECT hash FROM VideoAttachments WHERE video_id = ?1) AND hash NOT IN (SELECT hash FROM VideoAttachments WHERE video_id <> ?1)",
        &id,
        &[],
        true,
    )? {
        if !blobs.rows.is_empty() {
            tables.push(blobs);
        }
    }
    // The attachment's own id is given afresh when it's put back, so it can't clash with a newer one.
    if let Some(attachments) = snapshot(&conn, "VideoAttachments", "video_id = ?1", &id, &["id"], false)? {
        if !attachments.rows.is_empty() {
            tables.push(attachments);
        }
    }
    let bytes = tables.iter().map(table_bytes).sum();
    let title = if title.trim().is_empty() { video_id.to_string() } else { title };
    Ok(Some((Payload::Video(tables), title, author, bytes)))
}

/// Adds an item, and returns the id it was given.
fn push(trash: &Mutex<TrashStore>, mut item: TrashItem) -> u64 {
    let mut store = lock(trash);
    store.next_id += 1;
    item.id = store.next_id;
    let item_id = item.id;
    // The same thing deleted again replaces the older copy.
    store.items.retain(|i| !(i.kind == item.kind && i.key == item.key && i.db_path == item.db_path));
    store.items.push(item);
    // Over the limit: the oldest go first (never the one just added).
    let mut total: usize = store.items.iter().map(|i| i.bytes).sum();
    while total > MAX_TRASH_BYTES && store.items.len() > 1 {
        let gone = store.items.remove(0);
        total -= gone.bytes;
    }
    item_id
}

/// Deletes a video, keeping what's needed to bring it back. Returns the Trash id (None if there was no such video).
pub fn delete_video(trash: &Mutex<TrashStore>, db_path: &str, video_id: &str) -> Result<Option<u64>, String> {
    let captured = capture_video(db_path, video_id).map_err(|e| e.to_string())?;
    let changes = db::delete_video_recorded(db_path, video_id).map_err(|e| e.to_string())?;
    if let Some((payload, label, detail, bytes)) = captured {
        let bytes = bytes + changes.iter().map(|c| c.before.len() + c.after.len()).sum::<usize>();
        return Ok(Some(push(trash, TrashItem { id: 0, kind: TrashKind::Video, key: video_id.to_string(), label, detail, deleted_at: now_ms(), db_path: db_path.to_string(), payload, changes, bytes })));
    }
    Ok(None)
}

/// Deletes one glossary entry (a term's row for exactly `drives`), keeping it and the links that went with it.
pub fn delete_glossary(trash: &Mutex<TrashStore>, db_path: &str, term: &str, drives: &[String]) -> Result<Option<u64>, String> {
    let key = db::encode_drives(drives);
    let found: Option<(String, String)> = {
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.query_row("SELECT term, definition FROM Glossary WHERE term = ?1 AND drives = ?2", params![term, key], |r| Ok((r.get(0)?, r.get(1)?)))
            .ok()
    };
    let changes = db::delete_glossary_group_recorded(db_path, term, drives).map_err(|e| e.to_string())?;
    if let Some((stored_term, definition)) = found {
        let kind = if definition.trim().is_empty() { "Tag" } else { "Term" };
        let detail = if drives.is_empty() { kind.to_string() } else { format!("{kind} in {}", drives.join(", ")) };
        let bytes = stored_term.len() + definition.len() + changes.iter().map(|c| c.before.len() + c.after.len()).sum::<usize>();
        return Ok(Some(push(
            trash,
            TrashItem {
                id: 0,
                kind: TrashKind::Glossary,
                key: format!("{}|{}", stored_term.to_ascii_lowercase(), key),
                label: stored_term.clone(),
                detail,
                deleted_at: now_ms(),
                db_path: db_path.to_string(),
                payload: Payload::Glossary { term: stored_term, definition, drives: drives.to_vec() },
                changes,
                bytes,
            },
        )));
    }
    Ok(None)
}

/// The items of `kind` deleted from this workspace, newest first.
pub fn list(trash: &Mutex<TrashStore>, db_path: &str, kind: TrashKind) -> Vec<TrashEntry> {
    let store = lock(trash);
    let mut out: Vec<TrashEntry> = store
        .items
        .iter()
        .filter(|i| i.kind == kind && i.db_path == db_path)
        .map(|i| TrashEntry { id: i.id, kind: i.kind, label: i.label.clone(), detail: i.detail.clone(), deleted_at: i.deleted_at })
        .collect();
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then(b.id.cmp(&a.id)));
    out
}

fn restore_video(db_path: &str, tables: &[TableRows]) -> Result<(), String> {
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let video_id = tables
        .first()
        .and_then(|t| t.columns.iter().position(|c| c.eq_ignore_ascii_case("video_id")).and_then(|i| t.rows.first().map(|r| r[i].clone())));
    if let Some(Value::Text(id)) = &video_id {
        let exists: i64 = conn.query_row("SELECT COUNT(*) FROM Videos WHERE video_id = ?1", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if exists > 0 {
            return Err("This video has been saved again, so the old copy can't be restored.".to_string());
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for t in tables {
        let placeholders = (1..=t.columns.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        let sql = format!("INSERT {} INTO {} ({}) VALUES ({})", if t.ignore_conflicts { "OR IGNORE" } else { "" }, t.table, t.columns.join(", "), placeholders);
        let mut stmt = tx.prepare(&sql).map_err(|e| e.to_string())?;
        for row in &t.rows {
            stmt.execute(params_from_iter(row.iter())).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Puts an item back, and the links that were removed with it. Refused (and the item kept) when what it
/// would restore clashes with something made since.
pub fn restore(trash: &Mutex<TrashStore>, db_path: &str, id: u64) -> Result<(), String> {
    let mut store = lock(trash);
    let Some(at) = store.items.iter().position(|i| i.id == id && i.db_path == db_path) else {
        return Err("That item is no longer in the Trash.".to_string());
    };
    {
        let item = &store.items[at];
        match &item.payload {
            Payload::Video(tables) => restore_video(db_path, tables)?,
            Payload::Glossary { term, definition, drives } => {
                db::save_glossary_group(db_path, None, term, definition, drives).map_err(|e| e.to_string())?;
            }
        }
        if !item.changes.is_empty() {
            if let Ok(conn) = Connection::open(db_path) {
                let _ = undo_text_changes(&conn, &item.changes);
            }
        }
    }
    store.items.remove(at);
    Ok(())
}

/// Lets one item go for good.
pub fn discard(trash: &Mutex<TrashStore>, db_path: &str, id: u64) {
    lock(trash).items.retain(|i| !(i.id == id && i.db_path == db_path));
}

/// Empties the Trash of one kind, in this workspace.
pub fn empty(trash: &Mutex<TrashStore>, db_path: &str, kind: TrashKind) {
    lock(trash).items.retain(|i| !(i.kind == kind && i.db_path == db_path));
}

/// Empties everything (a workspace switch: these items belong to the one being left).
pub fn clear(trash: &Mutex<TrashStore>) {
    lock(trash).items.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{add_video_wdbs_link, init_db, save_glossary_group, save_video};

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_trash_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn store() -> Mutex<TrashStore> {
        Mutex::new(TrashStore::default())
    }

    fn save(db: &str, id: &str, title: &str) {
        save_video(db, id, title, "Author", 60, "words words", 1, "2026-01-01T00:00:00Z", "@chan", Some("A summary")).unwrap();
    }

    fn count(db: &str, sql: &str) -> i64 {
        Connection::open(db).unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn text(db: &str, sql: &str) -> String {
        Connection::open(db).unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_deleted_video_comes_back_with_everything_that_went_with_it() {
        let db = temp_db("video");
        let trash = store();
        save(&db, "v1", "First");
        save(&db, "v2", "Other");
        add_video_wdbs_link(&db, "v1", "θψNEWS").unwrap();
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute("INSERT INTO VideoNotes (video_id, note, updated_at) VALUES ('v1', 'my note', 'now')", []).unwrap();
            conn.execute("INSERT INTO AttachmentBlobs (hash, compression, size, stored_size, data) VALUES ('h1', 'none', 3, 3, x'010203')", []).unwrap();
            conn.execute("INSERT INTO VideoAttachments (video_id, name, ext, hash, added_at) VALUES ('v1', 'file', 'txt', 'h1', 'now')", []).unwrap();
            conn.execute("INSERT INTO DriveSequence (drive, video_id, position) VALUES (':NEWS', 'v1', 1)", []).unwrap();
            // Another video's summary links to the one being deleted.
            conn.execute("UPDATE Videos SET summary = 'See [first](kinesis://video/v1) now' WHERE video_id = 'v2'", []).unwrap();
        }

        delete_video(&trash, &db, "v1").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM Videos WHERE video_id = 'v1'"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM AttachmentBlobs"), 0, "the delete trigger removed its stored file");
        assert_eq!(text(&db, "SELECT summary FROM Videos WHERE video_id = 'v2'"), "See first now", "the link is gone, its words stay");
        let listed = list(&trash, &db, TrashKind::Video);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].label.as_str(), listed[0].detail.as_str()), ("First", "Author"));

        restore(&trash, &db, listed[0].id).unwrap();
        assert_eq!(text(&db, "SELECT title FROM Videos WHERE video_id = 'v1'"), "First");
        assert_eq!(text(&db, "SELECT note FROM VideoNotes WHERE video_id = 'v1'"), "my note");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM VideoAttachments WHERE video_id = 'v1'"), 1);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM AttachmentBlobs WHERE hash = 'h1'"), 1, "the stored file is back");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM VideoWDBSLinks WHERE video_id = 'v1'"), 1);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM DriveSequence WHERE video_id = 'v1'"), 1);
        assert_eq!(text(&db, "SELECT summary FROM Videos WHERE video_id = 'v2'"), "See [first](kinesis://video/v1) now", "the link is back");
        assert!(list(&trash, &db, TrashKind::Video).is_empty(), "restored items leave the Trash");
    }

    #[test]
    fn deleting_the_same_thing_again_replaces_the_older_copy() {
        let db = temp_db("again");
        let trash = store();
        save(&db, "v1", "Item A");
        delete_video(&trash, &db, "v1").unwrap();
        save(&db, "v1", "Item A (made again)");
        delete_video(&trash, &db, "v1").unwrap();
        let listed = list(&trash, &db, TrashKind::Video);
        assert_eq!(listed.len(), 1, "only the newest copy is kept");
        assert_eq!(listed[0].label, "Item A (made again)");
    }

    #[test]
    fn a_video_saved_again_is_not_overwritten_by_restoring_the_old_copy() {
        let db = temp_db("clash");
        let trash = store();
        save(&db, "v1", "Old");
        delete_video(&trash, &db, "v1").unwrap();
        save(&db, "v1", "New");
        let id = list(&trash, &db, TrashKind::Video)[0].id;
        let err = restore(&trash, &db, id).unwrap_err();
        assert!(err.contains("saved again"), "{err}");
        assert_eq!(text(&db, "SELECT title FROM Videos WHERE video_id = 'v1'"), "New");
        assert_eq!(list(&trash, &db, TrashKind::Video).len(), 1, "it stays in the Trash");
    }

    #[test]
    fn a_deleted_term_comes_back_with_its_links_and_names_ignore_case_when_matching_duplicates() {
        let db = temp_db("term");
        let trash = store();
        save_glossary_group(&db, None, "mTor", "A kinase.", &[]).unwrap();
        save(&db, "v1", "Video");
        Connection::open(&db).unwrap().execute("UPDATE Videos SET summary = 'About [mtor](kinesis://glossary/mTor).' WHERE video_id = 'v1'", []).unwrap();

        delete_glossary(&trash, &db, "mTor", &[]).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM Glossary"), 0);
        assert_eq!(text(&db, "SELECT summary FROM Videos WHERE video_id = 'v1'"), "About mtor.");
        let listed = list(&trash, &db, TrashKind::Glossary);
        assert_eq!((listed[0].label.as_str(), listed[0].detail.as_str()), ("mTor", "Term"));

        // Deleted again under another capitalization after being made again: still one item.
        save_glossary_group(&db, None, "MTOR", "Made again.", &[]).unwrap();
        delete_glossary(&trash, &db, "MTOR", &[]).unwrap();
        assert_eq!(list(&trash, &db, TrashKind::Glossary).len(), 1);

        let id = list(&trash, &db, TrashKind::Glossary)[0].id;
        restore(&trash, &db, id).unwrap();
        assert_eq!(text(&db, "SELECT definition FROM Glossary WHERE term = 'mtor'"), "Made again.");
    }

    #[test]
    fn a_term_whose_name_was_reused_for_something_else_is_not_restored_over_it() {
        let db = temp_db("termclash");
        let trash = store();
        save_glossary_group(&db, None, "Mg", "Magnesium.", &[]).unwrap();
        delete_glossary(&trash, &db, "Mg", &[]).unwrap();
        save_glossary_group(&db, None, "mg", "Milligram.", &[]).unwrap();
        let id = list(&trash, &db, TrashKind::Glossary)[0].id;
        let err = restore(&trash, &db, id).unwrap_err();
        assert!(err.contains("different definition"), "{err}");
        assert_eq!(text(&db, "SELECT definition FROM Glossary"), "Milligram.");
    }

    #[test]
    fn the_trash_is_per_workspace_and_can_be_emptied() {
        let (a, b) = (temp_db("wa"), temp_db("wb"));
        let trash = store();
        save(&a, "v1", "In A");
        delete_video(&trash, &a, "v1").unwrap();
        assert_eq!(list(&trash, &a, TrashKind::Video).len(), 1);
        assert!(list(&trash, &b, TrashKind::Video).is_empty(), "another workspace doesn't see it");
        assert!(restore(&trash, &b, list(&trash, &a, TrashKind::Video)[0].id).is_err(), "and can't restore it");
        empty(&trash, &a, TrashKind::Video);
        assert!(list(&trash, &a, TrashKind::Video).is_empty());
        save(&a, "v2", "More");
        delete_video(&trash, &a, "v2").unwrap();
        clear(&trash);
        assert!(list(&trash, &a, TrashKind::Video).is_empty());
    }
}
