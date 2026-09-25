//! Kinpak (`.kinpak`): a workspace you can hand to someone. It is the sync pack's NDJSON format
//! (docs/sync-protocol.md), always gzip-compressed, carrying everything that makes a workspace what
//! it is, and nothing that is secret or belongs to one machine:
//!
//! * the sync content kinds: categories (with aliases and icons), videos (with `date_added`),
//!   category links, glossary, biographies, custom summary prompts;
//! * the workspace's name and its section aliases, search history, video notes, and attachments;
//! * settings and feature flags (the sync allowlist: never API keys, tokens, sync-server state,
//!   folder paths or migration flags).
//!
//! Those last kinds are local-only: they aren't part of the sync protocol, and an older reader that
//! meets them skips them. There are no size limits. An attachment is streamed out of the database in
//! chunks and written back the same way, so a file of any size never has to fit in memory, and
//! every attachment is checked against its hash when it comes back in.
//!
//! Import applies everything as ordinary local data, so it works offline and never marks anything as
//! server-owned. The file starts with the workspace's name so an importer can offer it before it
//! reads the rest.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use flate2::read::DeflateDecoder;
use kinesis_sync_proto::pack::PackHeader;
use kinesis_sync_proto::sqlite::{self, ReadOptions};
use kinesis_sync_proto::{
    content_hash, is_syncable_setting, Item, Kind, PackLine, PackReader, PackWriter, Policy, PACK_FORMAT, PACK_VERSION,
};
use rusqlite::{params, Connection, DatabaseName, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::db;
use crate::db::sync::open_sync_conn;
use crate::drive_scope::{DriveScope, ScopePlan};

pub const EXTENSION: &str = "kinpak";

/// Import applies items in transactions of at most this many rows / this many payload bytes.
const IMPORT_BATCH_ITEMS: usize = 100;
const IMPORT_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPORTED_ERRORS: usize = 20;
/// How much of a stored attachment goes into one line of the file.
const CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// Local-only rows are applied this many to a transaction.
const LOCAL_TX_ITEMS: usize = 1000;

// Kinds that only this app understands (see the module docs).
const K_LABEL: &str = "workspace_label";
const K_HISTORY: &str = "history";
const K_NOTE: &str = "video_note";
const K_BLOB: &str = "attachment_blob";
const K_ATTACHMENT: &str = "attachment";

fn is_local_kind(kind: &str) -> bool {
    matches!(kind, K_LABEL | K_HISTORY | K_NOTE | K_BLOB | K_ATTACHMENT)
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub taxonomy: bool,
    pub videos: bool,
    /// Transcripts dominate pack size; leaving them out keeps titles, summaries and tags.
    pub transcripts: bool,
    pub glossary: bool,
    pub biographies: bool,
    pub prompts: bool,
    /// Per-Drive sequence membership and ordering (see db/sequences.rs).
    #[serde(default = "yes")]
    pub sequences: bool,
    /// Allowlisted settings (never API keys or paths), written as a policy line.
    pub settings: bool,
    /// The workspace's name and its section aliases.
    #[serde(default = "yes")]
    pub workspace: bool,
    #[serde(default = "yes")]
    pub history: bool,
    #[serde(default = "yes")]
    pub notes: bool,
    #[serde(default = "yes")]
    pub attachments: bool,
    /// Drives to leave out, and what to do with what touches them (see drive_scope.rs).
    #[serde(default)]
    pub drives: DriveScope,
}

#[derive(Debug, Serialize)]
pub struct ExportSummary {
    pub path: String,
    pub counts: BTreeMap<String, u64>,
    pub settings: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ImportOptions {
    /// Apply the pack's settings and section aliases. The workspace's own name is never touched
    /// here: whoever imports decides it (a new workspace is named by the user).
    pub apply_settings: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct ImportSummary {
    pub pack_app: String,
    pub pack_generated_at: String,
    pub imported: u64,
    pub skipped: u64,
    pub error_count: u64,
    pub errors: Vec<String>,
    pub settings_applied: u64,
    pub settings_skipped: u64,
    pub counts: BTreeMap<String, u64>,
}

/// What a pack says about itself, read from its first lines without loading the rest.
#[derive(Debug, Serialize)]
pub struct PackInfo {
    pub app: String,
    pub generated_at: String,
    /// The name of the workspace it was exported from, when the pack records one.
    pub workspace_name: Option<String>,
    pub counts: BTreeMap<String, u64>,
}

struct Out<W: Write> {
    writer: PackWriter<W>,
    counts: BTreeMap<String, u64>,
}

impl<W: Write> Out<W> {
    fn item(&mut self, kind: &str, key: &str, data: Value) -> Result<(), String> {
        let hash = content_hash(kind, key, &data);
        let item = Item { kind: kind.to_string(), key: key.to_string(), rev: None, hash, data };
        self.writer.write_item(&item).map_err(|e| e.to_string())?;
        *self.counts.entry(kind.to_string()).or_default() += 1;
        Ok(())
    }
}

/// Where a pack chosen in Save As is written: always `.kinpak`, whatever was typed.
pub fn resolve_pack_path(chosen: &str) -> PathBuf {
    let has_ext = Path::new(chosen)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION));
    if has_ext {
        PathBuf::from(chosen)
    } else {
        PathBuf::from(format!("{chosen}.{EXTENSION}"))
    }
}

fn count_rows(conn: &Connection, table: &str) -> u64 {
    if !sqlite::table_exists(conn, table) {
        return 0;
    }
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64
}

/// Rows of a per-video table (`video_id` first) that belong to a video the export keeps.
fn count_rows_kept(conn: &Connection, table: &str, plan: Option<&ScopePlan>) -> u64 {
    let Some(plan) = plan else { return count_rows(conn, table) };
    if !sqlite::table_exists(conn, table) {
        return 0;
    }
    let Ok(mut stmt) = conn.prepare(&format!("SELECT video_id FROM {table}")) else { return 0 };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { return 0 };
    rows.filter_map(|r| r.ok()).filter(|id| plan.video_kept(id)).count() as u64
}

/// Reads up to `buf.len()` bytes (a `Read` may return fewer than asked for without being at the end).
fn fill(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match reader.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// Writes the pack to exactly `path` (the Save As dialog has already confirmed any overwrite).
pub fn export_pack(
    db_path: &str,
    path: &Path,
    app_label: &str,
    brand: &str,
    opts: &ExportOptions,
    progress: impl Fn(&str),
) -> Result<ExportSummary, String> {
    export_pack_chunked(db_path, path, app_label, brand, opts, CHUNK_BYTES, progress)
}

/// The pack is written beside its final name as `<name>.kinpak.part` and only renamed into place once
/// it is complete. A file with the real name is therefore always a whole kinpak: a failed export, or
/// one cut short by the app closing, leaves no empty or truncated file that looks like a finished one
/// (a `.part` file is what an interrupted export leaves, and it's removed when an export fails).
pub(crate) fn export_pack_chunked(
    db_path: &str,
    path: &Path,
    app_label: &str,
    brand: &str,
    opts: &ExportOptions,
    chunk_bytes: usize,
    progress: impl Fn(&str),
) -> Result<ExportSummary, String> {
    let mut part_name = path.as_os_str().to_owned();
    part_name.push(".part");
    let part = PathBuf::from(part_name);
    let result = write_pack(db_path, &part, app_label, brand, opts, chunk_bytes, &progress).and_then(|mut summary| {
        // Renaming over a file of the same name replaces it (the Save As dialog already confirmed that).
        std::fs::rename(&part, path).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
        summary.path = path.to_string_lossy().into_owned();
        Ok(summary)
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

fn write_pack(
    db_path: &str,
    path: &Path,
    app_label: &str,
    brand: &str,
    opts: &ExportOptions,
    chunk_bytes: usize,
    progress: &impl Fn(&str),
) -> Result<ExportSummary, String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let path: PathBuf = path.to_path_buf();

    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    // What the chosen Drives leave out, worked out once up front (None: nothing is left out).
    let scope = ScopePlan::build(&conn, &opts.drives)?;
    let file = File::create(&path).map_err(|e| format!("Couldn't create {}: {e}", path.display()))?;
    let mut out = Out { writer: PackWriter::new(BufWriter::new(file), true), counts: BTreeMap::new() };

    // Which sync kinds to write, in the order an importer must apply them (taxonomy first).
    let kinds: [(bool, Kind, &str); 7] = [
        (opts.taxonomy, Kind::Wdbs, "Exporting taxonomy…"),
        (opts.videos, Kind::Video, "Exporting videos…"),
        (opts.videos, Kind::VideoLink, ""),
        (opts.sequences, Kind::DriveSequence, "Exporting sequences…"),
        (opts.glossary, Kind::Glossary, "Exporting glossary…"),
        (opts.biographies, Kind::Biography, "Exporting biographies…"),
        (opts.prompts, Kind::CustomPrompt, "Exporting custom prompts…"),
    ];

    // The header carries expected counts for progress UIs only; the reader never trusts them.
    let mut header = PackHeader::new(&chrono::Utc::now().to_rfc3339(), app_label, brand);
    for (on, kind, _) in kinds {
        if on {
            let count = match &scope {
                None => sqlite::count_kind(&conn, kind),
                // With Drives left out the total is what's kept, counted without the (large) transcripts.
                Some(scope) => {
                    let mut kept = 0u64;
                    sqlite::for_each_item(&conn, kind, &ReadOptions { transcripts: false }, |key, data| {
                        kept += u64::from(scope.keep_item(kind, key, &data));
                        Ok(())
                    })?;
                    kept
                }
            };
            header.counts.insert(kind.as_str().to_string(), count);
        }
    }
    if opts.workspace {
        header.counts.insert(K_LABEL.into(), count_rows(&conn, "WorkspaceLabels"));
    }
    if opts.history {
        header.counts.insert(K_HISTORY.into(), count_rows(&conn, "SearchHistory"));
    }
    if opts.notes {
        header.counts.insert(K_NOTE.into(), count_rows_kept(&conn, "VideoNotes", scope.as_ref()));
    }
    if opts.attachments {
        header.counts.insert(K_ATTACHMENT.into(), count_rows_kept(&conn, "VideoAttachments", scope.as_ref()));
    }
    out.writer.write_header(&header).map_err(|e| e.to_string())?;

    // The workspace's name and aliases come first, so a reader can offer the name without reading
    // the rest of a large file.
    if opts.workspace && sqlite::table_exists(&conn, "WorkspaceLabels") {
        progress("Exporting workspace name and aliases…");
        let mut stmt = conn.prepare("SELECT key, value FROM WorkspaceLabels ORDER BY key").map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for (key, value) in rows {
            out.item(K_LABEL, &key, json!({ "value": value }))?;
        }
    }

    // The same readers the sync server uses, so a pack and a server produce identical payloads.
    let read_opts = ReadOptions { transcripts: opts.transcripts };
    let added: HashMap<String, String> = if opts.videos {
        let mut stmt = conn.prepare("SELECT video_id, date_added FROM Videos WHERE date_added IS NOT NULL").map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows.into_iter().collect()
    } else {
        HashMap::new()
    };
    for (on, kind, label) in kinds {
        if !on {
            continue;
        }
        let total = header.counts.get(kind.as_str()).copied().unwrap_or(0);
        let what = label.trim_end_matches('…');
        if !label.is_empty() {
            progress(label);
        }
        let mut done = 0u64;
        sqlite::for_each_item(&conn, kind, &read_opts, |key, mut data| {
            if let Some(scope) = &scope {
                if !scope.keep_item(kind, key, &data) {
                    return Ok(());
                }
                scope.adjust(kind, key, &mut data);
            }
            if kind == Kind::Video {
                if let (Some(when), Some(obj)) = (added.get(key), data.as_object_mut()) {
                    obj.insert("date_added".into(), Value::String(when.clone()));
                }
            }
            let key = scope.as_ref().map_or_else(|| key.to_string(), |s| s.item_key(kind, key, &data));
            out.item(kind.as_str(), &key, data)?;
            done += 1;
            // A big library takes a while: say how far along it is, not just what it's on.
            if !label.is_empty() && done % 200 == 0 {
                progress(&format!("{what} {} of {}…", done.to_string(), total));
            }
            Ok(())
        })?;
    }

    if opts.history && sqlite::table_exists(&conn, "SearchHistory") {
        progress("Exporting search history…");
        let mut stmt = conn.prepare("SELECT search_query, searched_at FROM SearchHistory ORDER BY id").map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for (query, searched_at) in rows {
            out.item(K_HISTORY, &query, json!({ "query": query, "searched_at": searched_at }))?;
        }
    }

    if opts.notes && sqlite::table_exists(&conn, "VideoNotes") {
        progress("Exporting notes…");
        let mut stmt = conn.prepare("SELECT video_id, note, updated_at FROM VideoNotes ORDER BY video_id").map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for (video_id, note, updated_at) in rows {
            let note = match &scope {
                Some(scope) if !scope.video_kept(&video_id) => continue,
                Some(scope) => scope.clean_note(&note),
                None => note,
            };
            out.item(K_NOTE, &video_id, json!({ "note": note, "updated_at": updated_at }))?;
        }
    }

    if opts.attachments && sqlite::table_exists(&conn, "VideoAttachments") && sqlite::table_exists(&conn, "AttachmentBlobs") {
        export_attachments(&conn, &mut out, chunk_bytes, scope.as_ref(), progress)?;
    }

    let mut settings_count = 0u64;
    if opts.settings {
        progress("Exporting settings…");
        // The raw local values, not the policy overlay: a pack describes this install's own choices.
        let policy = Policy { settings: sqlite::read_syncable_settings(&conn), ..Policy::default() };
        settings_count = policy.settings.len() as u64;
        out.writer.write_policy(&policy).map_err(|e| e.to_string())?;
    }

    let counts = std::mem::take(&mut out.counts);
    let inner = out.writer.finish().map_err(|e| e.to_string())?;
    inner.into_inner().map_err(|e| e.to_string())?.sync_all().map_err(|e| e.to_string())?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportSummary { path: path.to_string_lossy().into_owned(), counts, settings: settings_count, bytes })
}

/// Each distinct stored file once (as it sits in the database, compression and all), read a chunk at
/// a time straight from the blob, then the rows that point videos at them.
fn export_attachments<W: Write>(
    conn: &Connection,
    out: &mut Out<W>,
    chunk_bytes: usize,
    scope: Option<&ScopePlan>,
    progress: &impl Fn(&str),
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT rowid, hash, compression, size FROM AttachmentBlobs
              WHERE hash IN (SELECT hash FROM VideoAttachments) ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    let blobs: Vec<(i64, String, String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    // With Drives left out, only the files a kept video still points at are written.
    let mut blobs = blobs;
    if let Some(scope) = scope {
        let mut stmt = conn.prepare("SELECT video_id, hash FROM VideoAttachments").map_err(|e| e.to_string())?;
        let kept: std::collections::HashSet<String> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .filter(|(video_id, _)| scope.video_kept(video_id))
            .map(|(_, hash)| hash)
            .collect();
        blobs.retain(|(_, hash, _, _)| kept.contains(hash));
    }

    let total = blobs.len();
    let mut buf = vec![0u8; chunk_bytes.max(1)];
    for (n, (rowid, hash, compression, size)) in blobs.into_iter().enumerate() {
        progress(&format!("Exporting attachments ({} of {total})…", n + 1));
        let mut blob = conn
            .blob_open(DatabaseName::Main, "AttachmentBlobs", "data", rowid, true)
            .map_err(|e| format!("Couldn't read attachment {hash}: {e}"))?;
        let stored = blob.size() as u64;
        let chunks = stored.div_ceil(buf.len() as u64).max(1);
        for index in 0..chunks {
            let got = fill(&mut blob, &mut buf).map_err(|e| format!("Couldn't read attachment {hash}: {e}"))?;
            out.item(
                K_BLOB,
                &format!("{hash}#{index}"),
                json!({
                    "hash": hash, "index": index, "chunks": chunks, "compression": compression,
                    "size": size, "stored_size": stored, "b64": B64.encode(&buf[..got]),
                }),
            )?;
        }
        // The blob rows aren't counted as content: the attachments below are what a person sees.
        out.counts.remove(K_BLOB);
    }

    let mut stmt = conn
        .prepare(
            "SELECT a.video_id, a.name, a.ext, a.hash, a.added_at FROM VideoAttachments a
               JOIN AttachmentBlobs b ON b.hash = a.hash ORDER BY a.id",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for (video_id, name, ext, hash, added_at) in rows {
        if scope.is_some_and(|s| !s.video_kept(&video_id)) {
            continue;
        }
        out.item(
            K_ATTACHMENT,
            &format!("{video_id}|{hash}|{name}"),
            json!({ "video_id": video_id, "name": name, "ext": ext, "hash": hash, "added_at": added_at }),
        )?;
    }
    Ok(())
}

// ─── Reading a pack ─────────────────────────────────────────────────────────

fn read_header(reader: &mut PackReader) -> Result<PackHeader, String> {
    match reader.next_line()? {
        Some(PackLine::Header(h)) => {
            if h.format != PACK_FORMAT {
                return Err("This isn't a Kinesis pack.".into());
            }
            if h.pack_version > PACK_VERSION {
                return Err(format!(
                    "This pack is format v{} but this app reads up to v{}. Update the app.",
                    h.pack_version, PACK_VERSION
                ));
            }
            Ok(h)
        }
        _ => Err("This isn't a Kinesis pack (missing header).".into()),
    }
}

/// The pack's header and workspace name, without reading the rest of it.
pub fn inspect_pack(path: &Path) -> Result<PackInfo, String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let mut reader = PackReader::new_unbounded(file).map_err(|e| e.to_string())?;
    let header = read_header(&mut reader)?;
    let mut workspace_name = None;
    // The name is written right after the header, before any content.
    while let Some(line) = reader.next_line()? {
        match line {
            PackLine::Item(item) if item.kind == K_LABEL => {
                if item.key == db::WORKSPACE_NAME_KEY {
                    workspace_name = item.data.get("value").and_then(Value::as_str).map(str::to_string);
                }
            }
            _ => break,
        }
    }
    Ok(PackInfo {
        app: header.app,
        generated_at: header.generated_at,
        workspace_name: workspace_name.filter(|n| !n.trim().is_empty()),
        counts: header.counts,
    })
}

fn field<'a>(data: &'a Value, name: &str) -> Result<&'a str, String> {
    data.get(name).and_then(Value::as_str).ok_or_else(|| format!("missing \"{name}\""))
}

fn number(data: &Value, name: &str) -> Result<u64, String> {
    data.get(name).and_then(Value::as_u64).ok_or_else(|| format!("missing \"{name}\""))
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The attachment file currently being written back, chunk by chunk.
struct BlobInProgress {
    hash: String,
    rowid: i64,
    compression: String,
    stored_size: u64,
    size: u64,
    chunks: u64,
    next_index: u64,
    written: u64,
    /// The database already had this file: its chunks are ignored.
    skip: bool,
}

enum Local {
    Applied,
    Skipped,
}

struct LocalApplier {
    blob: Option<BlobInProgress>,
    apply_settings: bool,
}

impl LocalApplier {
    fn apply(&mut self, conn: &Connection, item: &Item) -> Result<Local, String> {
        let d = &item.data;
        let e = |e: rusqlite::Error| e.to_string();
        match item.kind.as_str() {
            K_LABEL => {
                if !self.apply_settings || item.key == db::WORKSPACE_NAME_KEY {
                    return Ok(Local::Skipped);
                }
                let Some(&(_, _, max)) = db::LABELS.iter().find(|(k, _, _)| *k == item.key) else {
                    return Ok(Local::Skipped);
                };
                let value = db::normalize_label(field(d, "value")?, max)?;
                if value.is_empty() {
                    return Ok(Local::Skipped);
                }
                conn.execute("INSERT OR REPLACE INTO WorkspaceLabels (key, value) VALUES (?1, ?2)", params![item.key, value]).map_err(e)?;
                Ok(Local::Applied)
            }
            K_HISTORY => {
                let query = d.get("query").and_then(Value::as_str).unwrap_or(&item.key);
                let at = d.get("searched_at").and_then(Value::as_str);
                if query.trim().is_empty() {
                    return Ok(Local::Skipped);
                }
                match at {
                    Some(at) => conn.execute(
                        "INSERT INTO SearchHistory (search_query, searched_at) VALUES (?1, ?2)
                         ON CONFLICT(search_query) DO UPDATE SET searched_at = MAX(searched_at, excluded.searched_at)",
                        params![query, at],
                    ),
                    None => conn.execute("INSERT OR IGNORE INTO SearchHistory (search_query) VALUES (?1)", params![query]),
                }
                .map_err(e)?;
                Ok(Local::Applied)
            }
            K_NOTE => {
                let note = field(d, "note")?;
                let updated = d.get("updated_at").and_then(Value::as_str).unwrap_or("");
                // A note already written here is the reader's own: never replaced.
                let changed = conn
                    .execute(
                        "INSERT OR IGNORE INTO VideoNotes (video_id, note, updated_at)
                         SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM Videos WHERE video_id = ?1)",
                        params![item.key, note, updated],
                    )
                    .map_err(e)?;
                Ok(if changed > 0 { Local::Applied } else { Local::Skipped })
            }
            K_BLOB => self.blob_chunk(conn, d),
            K_ATTACHMENT => {
                let (video_id, name, ext, hash) = (field(d, "video_id")?, field(d, "name")?, field(d, "ext")?, field(d, "hash")?);
                let added = d.get("added_at").and_then(Value::as_str).unwrap_or("");
                let has_blob = conn
                    .query_row("SELECT 1 FROM AttachmentBlobs WHERE hash = ?1", params![hash], |_| Ok(()))
                    .optional()
                    .map_err(e)?
                    .is_some();
                if !has_blob {
                    return Err("its file didn't arrive intact, so it wasn't added".into());
                }
                // No per-video limit here: the limit is for adding files by hand, not for moving a library.
                let changed = conn
                    .execute(
                        "INSERT INTO VideoAttachments (video_id, name, ext, hash, added_at)
                         SELECT ?1, ?2, ?3, ?4, ?5
                          WHERE EXISTS (SELECT 1 FROM Videos WHERE video_id = ?1)
                            AND NOT EXISTS (SELECT 1 FROM VideoAttachments WHERE video_id = ?1 AND hash = ?4 AND name = ?2)",
                        params![video_id, name, ext, hash, added],
                    )
                    .map_err(e)?;
                Ok(if changed > 0 { Local::Applied } else { Local::Skipped })
            }
            other => Err(format!("unexpected kind {other}")),
        }
    }

    fn blob_chunk(&mut self, conn: &Connection, d: &Value) -> Result<Local, String> {
        let e = |e: rusqlite::Error| e.to_string();
        let hash = field(d, "hash")?;
        if !is_sha256_hex(hash) {
            return Err("not a valid attachment hash".into());
        }
        let index = number(d, "index")?;
        if index == 0 {
            self.abandon_blob(conn);
            let exists = conn
                .query_row("SELECT 1 FROM AttachmentBlobs WHERE hash = ?1", params![hash], |_| Ok(()))
                .optional()
                .map_err(e)?
                .is_some();
            let compression = field(d, "compression")?.to_string();
            if compression != "none" && compression != "deflate" {
                return Err(format!("unknown compression \"{compression}\""));
            }
            let (size, stored_size, chunks) = (number(d, "size")?, number(d, "stored_size")?, number(d, "chunks")?);
            let mut cur = BlobInProgress {
                hash: hash.to_string(), rowid: 0, compression, stored_size, size, chunks, next_index: 0, written: 0, skip: exists,
            };
            if !exists {
                conn.execute(
                    "INSERT INTO AttachmentBlobs (hash, compression, size, stored_size, data) VALUES (?1, ?2, ?3, ?4, zeroblob(?5))",
                    params![hash, cur.compression, size as i64, stored_size as i64, stored_size as i64],
                )
                .map_err(e)?;
                cur.rowid = conn.last_insert_rowid();
            }
            self.blob = Some(cur);
        }
        let Some(cur) = self.blob.as_mut().filter(|c| c.hash == hash) else {
            return Err("a piece of an attachment arrived out of order".into());
        };
        if cur.skip {
            // Already in the library: count the pieces off, and be done with the file at its last one.
            cur.next_index += 1;
            if cur.next_index >= cur.chunks {
                self.blob = None;
            }
            return Ok(Local::Skipped);
        }
        if index != cur.next_index {
            self.abandon_blob(conn);
            return Err("a piece of an attachment is missing".into());
        }
        let bytes = B64.decode(field(d, "b64")?).map_err(|_| "an attachment's data isn't valid".to_string());
        let bytes = match bytes {
            Ok(b) => b,
            Err(m) => {
                self.abandon_blob(conn);
                return Err(m);
            }
        };
        if cur.written + bytes.len() as u64 > cur.stored_size {
            self.abandon_blob(conn);
            return Err("an attachment is bigger than the pack says".into());
        }
        {
            let mut blob = conn.blob_open(DatabaseName::Main, "AttachmentBlobs", "data", cur.rowid, false).map_err(e)?;
            blob.seek(SeekFrom::Start(cur.written)).map_err(|x| x.to_string())?;
            blob.write_all(&bytes).map_err(|x| x.to_string())?;
        }
        cur.written += bytes.len() as u64;
        cur.next_index += 1;
        if cur.next_index == cur.chunks {
            let done = self.blob.take().unwrap();
            if let Err(m) = verify_blob(conn, &done) {
                let _ = conn.execute("DELETE FROM AttachmentBlobs WHERE rowid = ?1", params![done.rowid]);
                return Err(m);
            }
        }
        Ok(Local::Applied)
    }

    /// Drops a file that never finished arriving, so a damaged pack can't leave a half-written one.
    fn abandon_blob(&mut self, conn: &Connection) {
        if let Some(cur) = self.blob.take() {
            if !cur.skip {
                let _ = conn.execute("DELETE FROM AttachmentBlobs WHERE rowid = ?1", params![cur.rowid]);
            }
        }
    }
}

/// Reads the stored file back (decompressing it if it was) and checks it is exactly the file the
/// hash names. Streams, so it costs no memory whatever the size.
fn verify_blob(conn: &Connection, b: &BlobInProgress) -> Result<(), String> {
    if b.written != b.stored_size {
        return Err("an attachment is smaller than the pack says".into());
    }
    let blob = conn
        .blob_open(DatabaseName::Main, "AttachmentBlobs", "data", b.rowid, true)
        .map_err(|e| e.to_string())?;
    let mut reader: Box<dyn Read + '_> = if b.compression == "deflate" { Box::new(DeflateDecoder::new(blob)) } else { Box::new(blob) };
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|_| "an attachment is damaged".to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    let actual: String = hasher.finalize().iter().map(|x| format!("{x:02x}")).collect();
    if actual != b.hash || total != b.size {
        return Err("an attachment is damaged (it doesn't match its fingerprint), so it wasn't imported".into());
    }
    Ok(())
}

pub fn import_pack(
    db_path: &str,
    path: &Path,
    opts: ImportOptions,
    progress: impl Fn(&str),
) -> Result<ImportSummary, String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    // A pack the user picked themselves: no cap on how long a line (a transcript, an attachment) may be.
    let mut reader = PackReader::new_unbounded(file).map_err(|e| e.to_string())?;

    let header = read_header(&mut reader)?;
    // What the header says the pack holds, so progress can say how far along it is. (Informational: the
    // reader never trusts these counts, and a pack without them just reports how many it has done.)
    let expected: u64 = header.counts.values().sum();
    let mut summary = ImportSummary { pack_app: header.app, pack_generated_at: header.generated_at, ..Default::default() };
    let said = |done: u64| {
        if expected >= done && expected > 0 {
            format!("Imported {done} of {expected} items…")
        } else {
            format!("Imported {done} items…")
        }
    };
    let mut said_attachments = false;

    let mut conn = open_sync_conn(db_path).map_err(|e| e.to_string())?;
    let mut batch: Vec<Item> = Vec::new();
    let mut batch_bytes = 0usize;
    let mut policy: Option<Policy> = None;
    let mut total_read = 0u64;
    let mut local = LocalApplier { blob: None, apply_settings: opts.apply_settings };
    let mut in_tx = false;
    let mut tx_items = 0usize;

    fn note_error(summary: &mut ImportSummary, msg: String) {
        summary.error_count += 1;
        if summary.errors.len() < MAX_REPORTED_ERRORS {
            summary.errors.push(msg);
        }
    }

    let flush = |batch: &mut Vec<Item>, summary: &mut ImportSummary, conn: &mut Connection| -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        for it in batch.iter() {
            *summary.counts.entry(it.kind.clone()).or_default() += 1;
        }
        let stats = db::sync::import_items(conn, batch).map_err(|e| e.to_string())?;
        summary.imported += stats.upserted;
        summary.skipped += stats.skipped + stats.unchanged;
        for e in stats.errors {
            note_error(summary, e);
        }
        batch.clear();
        Ok(())
    };
    let end_tx = |conn: &Connection, in_tx: &mut bool, tx_items: &mut usize| -> Result<(), String> {
        if *in_tx {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            *in_tx = false;
            *tx_items = 0;
        }
        Ok(())
    };

    while let Some(line) = reader.next_line()? {
        match line {
            PackLine::Item(item) if Kind::parse(&item.kind).is_some() => {
                end_tx(&conn, &mut in_tx, &mut tx_items)?;
                batch_bytes += reader.last_line_bytes();
                batch.push(item);
                total_read += 1;
                if batch.len() >= IMPORT_BATCH_ITEMS || batch_bytes >= IMPORT_BATCH_BYTES {
                    flush(&mut batch, &mut summary, &mut conn)?;
                    batch_bytes = 0;
                    progress(&said(total_read));
                }
            }
            PackLine::Item(item) if is_local_kind(&item.kind) => {
                // Videos first: notes and attachments are only kept for videos that exist.
                flush(&mut batch, &mut summary, &mut conn)?;
                batch_bytes = 0;
                if !in_tx {
                    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
                    in_tx = true;
                }
                let is_chunk = item.kind == K_BLOB;
                match local.apply(&conn, &item) {
                    Ok(Local::Applied) => {
                        if !is_chunk {
                            summary.imported += 1;
                            *summary.counts.entry(item.kind.clone()).or_default() += 1;
                        }
                    }
                    Ok(Local::Skipped) => {
                        if !is_chunk {
                            summary.skipped += 1;
                        }
                    }
                    Err(m) => {
                        let what = if is_chunk { "attachment".to_string() } else { format!("{} {}", item.kind, item.key) };
                        note_error(&mut summary, format!("{what}: {m}"));
                    }
                }
                // Pieces of a file aren't items of their own (the header counts the attachments).
                if !is_chunk {
                    total_read += 1;
                } else if !said_attachments {
                    said_attachments = true;
                    progress("Importing attachments…");
                }
                tx_items += 1;
                if tx_items >= LOCAL_TX_ITEMS {
                    end_tx(&conn, &mut in_tx, &mut tx_items)?;
                    progress(&said(total_read));
                } else if is_chunk {
                    // Attachment pieces are big: keep the transaction (and the progress message) short.
                    end_tx(&conn, &mut in_tx, &mut tx_items)?;
                }
            }
            // A kind a newer app writes and this one doesn't know: skipped, not fatal.
            PackLine::Item(_) => summary.skipped += 1,
            PackLine::Policy(p) => policy = Some(p),
            PackLine::Header(_) => return Err("The pack has more than one header.".into()),
        }
    }
    flush(&mut batch, &mut summary, &mut conn)?;
    if let Some(unfinished) = local.blob.as_ref().map(|b| b.skip) {
        local.abandon_blob(&conn);
        if !unfinished {
            note_error(&mut summary, "attachment: the pack ended in the middle of a file".into());
        }
    }
    end_tx(&conn, &mut in_tx, &mut tx_items)?;
    drop(conn);

    if let Some(p) = policy {
        for (k, v) in p.settings {
            if opts.apply_settings && is_syncable_setting(&k) && db::set_setting(db_path, &k, &v).is_ok() {
                summary.settings_applied += 1;
            } else {
                summary.settings_skipped += 1;
            }
        }
    }
    progress("Import complete.");
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_kinpak_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kinesis_kinpak_dir_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn all() -> ExportOptions {
        ExportOptions {
            taxonomy: true,
            videos: true,
            transcripts: true,
            glossary: true,
            biographies: true,
            prompts: true,
            sequences: true,
            settings: true,
            workspace: true,
            history: true,
            notes: true,
            attachments: true,
            drives: DriveScope::default(),
        }
    }

    fn import_all() -> ImportOptions {
        ImportOptions { apply_settings: true }
    }

    fn seed(db_path: &str) {
        let conn = Connection::open(db_path).unwrap();
        conn.execute("INSERT OR IGNORE INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDIcon, WDDefault) VALUES (':UAP', 1, 'UAP', 'Aliased', 'star', 0)", []).unwrap();
        conn.execute(
            "INSERT INTO Videos (video_id, title, author, handle, length_seconds, transcript, summary, view_count, published_at, tags, WDBS, date_added)
             VALUES ('vid1', 'Title', 'Author', '@auth', 90, 'some transcript words here', 'A summary', 1234, '2024-01-02', 'a,b', 'θψUAP', '2021-03-04 05:06:07')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO VideoWDBSLinks (video_id, wdbs) VALUES ('vid1', 'θψCRYPTO')", []).unwrap();
        conn.execute("INSERT INTO DriveSequence (drive, video_id, position) VALUES (':UAP', 'vid1', 1)", []).unwrap();
        conn.execute("INSERT INTO Glossary (term, definition, drives) VALUES ('term', 'def', ':FIN' || char(10) || ':UAP')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Biographies (handle, display_name, bio, subscriber_count) VALUES ('@auth', 'Auth', 'Bio', 42)", []).unwrap();
        conn.execute("INSERT INTO CustomPrompts (handle, local_prompt_text, cloud_prompt_text) VALUES ('@auth', 'local', 'cloud')", []).unwrap();
        conn.execute("INSERT INTO WorkspaceLabels (key, value) VALUES ('workspaceName', 'Metabolic Warp Drive'), ('aliasLibrary', 'Portal')", []).unwrap();
        conn.execute("INSERT INTO SearchHistory (search_query, searched_at) VALUES ('first query', '2024-05-01 10:00:00'), ('second query', '2024-05-02 10:00:00')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('showBiography', 'false')", []).unwrap();
        // A permission, not just a display flag: proves Read-only itself (Settings > Workspace >
        // Advanced > Permissions) travels through a pack the same way any other feature flag does.
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('workspaceReadOnly', 'true')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('venice_api_key', 'SECRET-VENICE')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('api_key', 'SECRET-YT')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('pixabay_api_key', 'SECRET-PIX')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('sync_token', 'SECRET-SYNC')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('sync_server_url', 'https://secret.example')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('obsidianExportPath', 'C:/private/path')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('syncPackExportPath', 'C:/private/packs')", []).unwrap();
        drop(conn);
    }

    /// Deterministic bytes that don't compress (so a "none" blob spans several chunks).
    fn noise(len: usize) -> Vec<u8> {
        let mut x: u64 = 0x9E3779B97F4A7C15;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x >> 24) as u8
            })
            .collect()
    }

    fn read_all_text(path: &Path) -> String {
        let mut text = String::new();
        let mut r = PackReader::new_unbounded(File::open(path).unwrap()).unwrap();
        while let Some(line) = r.next_line().unwrap() {
            match line {
                PackLine::Item(i) if i.kind == K_BLOB => text.push_str(&format!("blob {}\n", i.key)),
                other => text.push_str(&format!("{other:?}\n")),
            }
        }
        text
    }

    #[test]
    fn export_contains_no_secrets_and_a_new_workspace_gets_everything() {
        let src = temp_db("src");
        seed(&src);
        db::attachments::add_attachment(&src, "vid1", "notes.txt", b"hello attachment ".repeat(500)).unwrap();
        db::attachments::add_attachment(&src, "vid1", "pic.png", noise(50_000)).unwrap();
        Connection::open(&src).unwrap().execute("INSERT INTO VideoNotes (video_id, note, updated_at) VALUES ('vid1', 'my note', '2024-06-01T00:00:00Z')", []).unwrap();

        let dir = temp_dir("all");
        // Exactly the chosen file (in a folder that doesn't exist yet), named as the user named it.
        let out = dir.join("nested").join("my pack.kinpak");
        let summary = export_pack_chunked(&src, &out, "Kinesis 0.4.3", "Kinesis", &all(), 4096, |_| {}).unwrap();
        assert_eq!(Path::new(&summary.path), out.as_path());
        assert_eq!(summary.counts.get("video"), Some(&1));
        assert_eq!(summary.counts.get("video_link"), Some(&1));
        assert_eq!(summary.counts.get("drive_sequence"), Some(&1));
        assert_eq!(summary.counts.get("attachment"), Some(&2));
        assert_eq!(summary.counts.get("video_note"), Some(&1));
        assert_eq!(summary.counts.get("history"), Some(&2));
        assert!(summary.counts.get("attachment_blob").is_none(), "pieces of files aren't counted as content");
        assert!(summary.settings >= 1);

        // The file, decompressed, must not contain any secret or private path.
        let text = read_all_text(&out);
        for secret in [
            "SECRET-VENICE", "SECRET-YT", "SECRET-PIX", "SECRET-SYNC", "secret.example", "C:/private", "api_key", "sync_token",
            "sync_server_url", "obsidianExportPath", "syncPackExportPath",
        ] {
            assert!(!text.contains(secret), "pack leaked {secret}");
        }

        let dst = temp_db("dst");
        let imported = import_pack(&dst, &out, import_all(), |_| {}).unwrap();
        assert_eq!(imported.error_count, 0, "{:?}", imported.errors);
        assert_eq!(imported.settings_skipped, 0);
        let conn = Connection::open(&dst).unwrap();
        let (title, transcript, wdbs, views, added): (String, String, String, i64, String) = conn
            .query_row("SELECT title, transcript, WDBS, view_count, date_added FROM Videos WHERE video_id='vid1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        assert_eq!((title.as_str(), transcript.as_str(), wdbs.as_str(), views), ("Title", "some transcript words here", "θψUAP", 1234));
        assert_eq!(added, "2021-03-04 05:06:07", "the library keeps its own ordering");
        let alias: String = conn.query_row("SELECT WDInfo FROM tblWDBS WHERE WDBS=':UAP'", [], |r| r.get(0)).unwrap();
        assert_eq!(alias, "Aliased");
        let links: i64 = conn.query_row("SELECT COUNT(*) FROM VideoWDBSLinks WHERE video_id='vid1'", [], |r| r.get(0)).unwrap();
        assert_eq!(links, 1);
        let position: i64 = conn.query_row("SELECT position FROM DriveSequence WHERE drive=':UAP' AND video_id='vid1'", [], |r| r.get(0)).unwrap();
        assert_eq!(position, 1);
        assert_eq!(column(&dst, "SELECT replace(drives, char(10), ',') FROM Glossary WHERE term='term'").join(";"), ":FIN,:UAP", "one row holding both Drives");
        let prompt: String = conn.query_row("SELECT cloud_prompt_text FROM CustomPrompts WHERE handle='@auth'", [], |r| r.get(0)).unwrap();
        assert_eq!(prompt, "cloud");
        assert_eq!(db::get_setting(&dst, "showBiography").unwrap().as_deref(), Some("false"));
        // The permission itself, not just an ordinary display flag, made the trip.
        assert_eq!(db::get_setting(&dst, "workspaceReadOnly").unwrap().as_deref(), Some("true"));
        // Aliases came across, but the workspace's own name is left for the importer to decide.
        let labels = db::get_workspace_labels(&dst).unwrap();
        assert_eq!(labels["aliasLibrary"], "Portal");
        assert_eq!(labels["workspaceName"], "New Workspace");
        // History, the note.
        let history: Vec<String> = conn.prepare("SELECT search_query FROM SearchHistory ORDER BY searched_at").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(history, vec!["first query", "second query"]);
        let note: String = conn.query_row("SELECT note FROM VideoNotes WHERE video_id='vid1'", [], |r| r.get(0)).unwrap();
        assert_eq!(note, "my note");
        // Both attachments, byte for byte (one was compressible, one spans several chunks uncompressed).
        let mut got = db::attachments::list_attachments(&dst, "vid1").unwrap();
        got.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(got.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["notes.txt", "pic.png"]);
        assert_eq!(db::attachments::read_attachment(&dst, got[0].id).unwrap().1, b"hello attachment ".repeat(500));
        assert_eq!(db::attachments::read_attachment(&dst, got[1].id).unwrap().1, noise(50_000));
        // Imported rows are plain local data.
        let owned: i64 = conn.query_row("SELECT COUNT(*) FROM SyncItems", [], |r| r.get(0)).unwrap();
        assert_eq!(owned, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_limited_a_huge_entry_and_a_multi_chunk_attachment_come_through() {
        let src = temp_db("big_src");
        // Over the sync server's per-item cap (8 MB). A glossary definition rather than a transcript:
        // it takes the same size checks, without search indexing that is slow in an unoptimized build.
        let huge = "definition words ".repeat(600_000);
        assert!(huge.len() > kinesis_sync_proto::MAX_ITEM_BYTES);
        let conn = Connection::open(&src).unwrap();
        conn.execute("INSERT INTO Videos (video_id, title) VALUES ('big', 'Big')", []).unwrap();
        conn.execute("INSERT INTO Glossary (term, definition) VALUES ('huge', ?1)", params![huge]).unwrap();
        drop(conn);
        let file = noise(5 * 1024 * 1024 + 123); // more than one default-size chunk
        db::attachments::add_attachment(&src, "big", "data.png", file.clone()).unwrap();

        let dir = temp_dir("big");
        let out = dir.join("big.kinpak");
        export_pack(&src, &out, "Kinesis", "Kinesis", &all(), |_| {}).unwrap();
        let dst = temp_db("big_dst");
        let imported = import_pack(&dst, &out, import_all(), |_| {}).unwrap();
        assert_eq!(imported.error_count, 0, "{:?}", imported.errors);
        let len: i64 = Connection::open(&dst).unwrap().query_row("SELECT length(definition) FROM Glossary WHERE term='huge'", [], |r| r.get(0)).unwrap();
        assert_eq!(len as usize, huge.len());
        let a = db::attachments::list_attachments(&dst, "big").unwrap();
        assert_eq!(db::attachments::read_attachment(&dst, a[0].id).unwrap().1, file);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merging_into_a_library_keeps_what_is_already_there() {
        let src = temp_db("merge_src");
        seed(&src);
        Connection::open(&src).unwrap().execute("INSERT INTO VideoNotes (video_id, note, updated_at) VALUES ('vid1', 'pack note', 'x')", []).unwrap();
        let dir = temp_dir("merge");
        let out = dir.join("m.kinpak");
        export_pack(&src, &out, "Kinesis", "Kinesis", &all(), |_| {}).unwrap();

        let dst = temp_db("merge_dst");
        let conn = Connection::open(&dst).unwrap();
        conn.execute("INSERT INTO Videos (video_id, title, transcript, date_added) VALUES ('vid1', 'Old', 'my own transcript', '2000-01-01 00:00:00')", []).unwrap();
        conn.execute("INSERT INTO VideoNotes (video_id, note, updated_at) VALUES ('vid1', 'my note', 'x')", []).unwrap();
        drop(conn);
        import_pack(&dst, &out, ImportOptions { apply_settings: false }, |_| {}).unwrap();
        let conn = Connection::open(&dst).unwrap();
        let (title, added): (String, String) = conn.query_row("SELECT title, date_added FROM Videos WHERE video_id='vid1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(title, "Title", "content merges like a sync");
        assert_eq!(added, "2000-01-01 00:00:00", "an existing video keeps its own date");
        let note: String = conn.query_row("SELECT note FROM VideoNotes WHERE video_id='vid1'", [], |r| r.get(0)).unwrap();
        assert_eq!(note, "my note", "a note you wrote is never replaced");
        // Settings and aliases were declined.
        assert!(db::get_setting(&dst, "showBiography").unwrap().map(|v| v != "false").unwrap_or(true));
        assert_eq!(db::get_workspace_labels(&dst).unwrap()["aliasLibrary"], "Library");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_kinpak_only_appears_under_its_real_name_once_it_is_complete() {
        let src = temp_db("part_src");
        seed(&src);
        let dir = temp_dir("part");

        // Success: the finished file is there, complete, and no .part is left. An older file of the
        // same name (which Save As already confirmed replacing) is replaced.
        let out = dir.join("a.kinpak");
        std::fs::write(&out, "old").unwrap();
        let summary = export_pack(&src, &out, "Kinesis", "Kinesis", &all(), |_| {}).unwrap();
        assert!(out.is_file() && !dir.join("a.kinpak.part").exists());
        assert!(summary.bytes > 3 && std::fs::metadata(&out).unwrap().len() == summary.bytes);
        assert_eq!(summary.path, out.to_string_lossy());
        assert!(inspect_pack(&out).is_ok());

        // Failure at the last step (the name is taken by a folder): an error, nothing left behind, and
        // nothing that looks like a finished export.
        let blocked = dir.join("b.kinpak");
        std::fs::create_dir_all(&blocked).unwrap();
        assert!(export_pack(&src, &blocked, "Kinesis", "Kinesis", &all(), |_| {}).is_err());
        assert!(blocked.is_dir() && !dir.join("b.kinpak.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Not a check, a way to time a real pack: `KINPAK_TEST_FILE=path cargo test --lib real_pack -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_pack_import_timing() {
        let Ok(file) = std::env::var("KINPAK_TEST_FILE") else { return };
        let dst = temp_db("real_pack");
        let started = std::time::Instant::now();
        let summary = import_pack(&dst, Path::new(&file), import_all(), |m| eprintln!("[{:>7.1?}] {m}", started.elapsed())).unwrap();
        eprintln!("[{:>7.1?}] done: {} imported, {} skipped, {} errors {:?}", started.elapsed(), summary.imported, summary.skipped, summary.error_count, summary.errors);
    }

    #[test]
    fn options_leave_things_out() {
        let src = temp_db("opts");
        seed(&src);
        db::attachments::add_attachment(&src, "vid1", "a.txt", b"abc".to_vec()).unwrap();
        let dir = temp_dir("opts");
        let opts = ExportOptions { transcripts: false, settings: false, history: false, attachments: false, notes: false, workspace: false, ..all() };
        let summary = export_pack(&src, &dir.join("p.kinpak"), "Kinesis", "Kinesis", &opts, |_| {}).unwrap();
        assert_eq!(summary.settings, 0);
        assert!(summary.counts.get("history").is_none() && summary.counts.get("attachment").is_none());
        assert!(inspect_pack(&dir.join("p.kinpak")).unwrap().workspace_name.is_none());

        let dst = temp_db("opts_dst");
        let conn = Connection::open(&dst).unwrap();
        conn.execute("INSERT INTO Videos (video_id, title, transcript) VALUES ('vid1', 'Old', 'my own transcript')", []).unwrap();
        drop(conn);
        import_pack(&dst, &dir.join("p.kinpak"), import_all(), |_| {}).unwrap();
        let conn = Connection::open(&dst).unwrap();
        let (title, transcript): (String, String) = conn.query_row("SELECT title, transcript FROM Videos WHERE video_id='vid1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((title.as_str(), transcript.as_str()), ("Title", "my own transcript"), "a pack without transcripts must not blank the local one");
        assert!(db::attachments::list_attachments(&dst, "vid1").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_never_overrides_server_owned_rows_and_settings_need_opt_in() {
        let src = temp_db("own_src");
        seed(&src);
        let dir = temp_dir("own");
        let out = dir.join("p.kinpak");
        let summary = export_pack(&src, &out, "Kinesis", "Kinesis", &all(), |_| {}).unwrap();

        let dst = temp_db("own_dst");
        let conn = Connection::open(&dst).unwrap();
        conn.execute("INSERT INTO Glossary (term, definition, drives) VALUES ('term', 'server version', ':FIN')", []).unwrap();
        conn.execute("INSERT INTO SyncItems (kind, item_key, rev, content_hash) VALUES ('glossary', ':FIN|term', 1, 'h')", []).unwrap();
        drop(conn);
        let imported = import_pack(&dst, &out, ImportOptions { apply_settings: false }, |_| {}).unwrap();
        let conn = Connection::open(&dst).unwrap();
        let def: String = conn.query_row("SELECT definition FROM Glossary WHERE term='term' AND drives=':FIN'", [], |r| r.get(0)).unwrap();
        assert_eq!(def, "server version");
        assert!(imported.skipped >= 1);
        assert_eq!(imported.settings_applied, 0);
        assert_eq!(imported.settings_skipped, summary.settings);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_attachment_is_refused_and_leaves_nothing_behind() {
        let src = temp_db("bad_src");
        seed(&src);
        db::attachments::add_attachment(&src, "vid1", "pic.png", noise(20_000)).unwrap();
        let dir = temp_dir("bad");
        let good = dir.join("good.kinpak");
        export_pack_chunked(&src, &good, "Kinesis", "Kinesis", &all(), 4096, |_| {}).unwrap();

        // Rewrite the pack with one chunk's bytes altered.
        let tampered = dir.join("tampered.kinpak");
        {
            let mut r = PackReader::new_unbounded(File::open(&good).unwrap()).unwrap();
            let mut w = PackWriter::new(BufWriter::new(File::create(&tampered).unwrap()), true);
            let mut flipped = false;
            while let Some(line) = r.next_line().unwrap() {
                match line {
                    PackLine::Header(h) => w.write_header(&h).unwrap(),
                    PackLine::Policy(p) => w.write_policy(&p).unwrap(),
                    PackLine::Item(mut i) => {
                        if i.kind == K_BLOB && i.data["index"] == 2 && !flipped {
                            let mut bytes = B64.decode(i.data["b64"].as_str().unwrap()).unwrap();
                            bytes[10] ^= 0xFF;
                            i.data["b64"] = Value::String(B64.encode(bytes));
                            flipped = true;
                        }
                        w.write_item(&i).unwrap();
                    }
                }
            }
            w.finish().unwrap().into_inner().unwrap().sync_all().unwrap();
        }
        let dst = temp_db("bad_dst");
        let imported = import_pack(&dst, &tampered, import_all(), |_| {}).unwrap();
        assert!(imported.error_count >= 1);
        assert!(imported.errors.iter().any(|e| e.contains("damaged")), "{:?}", imported.errors);
        let conn = Connection::open(&dst).unwrap();
        let blobs: i64 = conn.query_row("SELECT COUNT(*) FROM AttachmentBlobs", [], |r| r.get(0)).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM VideoAttachments", [], |r| r.get(0)).unwrap();
        assert_eq!((blobs, rows), (0, 0), "a file that fails its fingerprint is not kept");
        // The rest of the pack still came in.
        let vids: i64 = conn.query_row("SELECT COUNT(*) FROM Videos", [], |r| r.get(0)).unwrap();
        assert_eq!(vids, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_identical_attachment_already_in_the_library_is_not_stored_twice() {
        let src = temp_db("dedupe_src");
        seed(&src);
        db::attachments::add_attachment(&src, "vid1", "a.png", noise(10_000)).unwrap();
        let dir = temp_dir("dedupe");
        let out = dir.join("d.kinpak");
        export_pack(&src, &out, "Kinesis", "Kinesis", &all(), |_| {}).unwrap();
        let dst = temp_db("dedupe_dst");
        import_pack(&dst, &out, import_all(), |_| {}).unwrap();
        let again = import_pack(&dst, &out, import_all(), |_| {}).unwrap();
        assert_eq!(again.error_count, 0, "{:?}", again.errors);
        let conn = Connection::open(&dst).unwrap();
        let blobs: i64 = conn.query_row("SELECT COUNT(*) FROM AttachmentBlobs", [], |r| r.get(0)).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM VideoAttachments", [], |r| r.get(0)).unwrap();
        assert_eq!((blobs, rows), (1, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_saved_file_is_always_a_kinpak_and_says_which_workspace_it_came_from() {
        assert_eq!(resolve_pack_path("C:/x/pack.kinpak"), PathBuf::from("C:/x/pack.kinpak"));
        assert_eq!(resolve_pack_path("C:/x/PACK.KINPAK"), PathBuf::from("C:/x/PACK.KINPAK"));
        assert_eq!(resolve_pack_path("/x/backup"), PathBuf::from("/x/backup.kinpak"));
        assert_eq!(resolve_pack_path("/x/backup.jsonl.gz"), PathBuf::from("/x/backup.jsonl.gz.kinpak"));

        let src = temp_db("inspect");
        seed(&src);
        let dir = temp_dir("inspect");
        let out = dir.join("i.kinpak");
        export_pack(&src, &out, "Kinesis 0.4.3", "Kinesis", &all(), |_| {}).unwrap();
        let info = inspect_pack(&out).unwrap();
        assert_eq!(info.workspace_name.as_deref(), Some("Metabolic Warp Drive"));
        assert_eq!(info.app, "Kinesis 0.4.3");
        assert_eq!(info.counts.get("video"), Some(&1));
        assert_eq!(info.counts.get("history"), Some(&2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_old_sync_pack_still_imports() {
        // What the previous version wrote: uncompressed .jsonl, no local-only kinds, no workspace name.
        let dir = temp_dir("legacy");
        let old = dir.join("old.jsonl");
        std::fs::write(
            &old,
            concat!(
                "{\"kind\":\"header\",\"format\":\"kinesis-sync-pack\",\"pack_version\":1,\"generated_at\":\"2024-01-01T00:00:00Z\",\"app\":\"Kinesis 0.4.2\"}\n",
                "{\"kind\":\"video\",\"key\":\"old1\",\"data\":{\"title\":\"From an old pack\"}}\n",
            ),
        )
        .unwrap();
        assert!(inspect_pack(&old).unwrap().workspace_name.is_none());
        let dst = temp_db("legacy_dst");
        let imported = import_pack(&dst, &old, import_all(), |_| {}).unwrap();
        assert_eq!(imported.error_count, 0);
        let title: String = Connection::open(&dst).unwrap().query_row("SELECT title FROM Videos WHERE video_id='old1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "From an old pack");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_packs_are_rejected() {
        let db_path = temp_db("bad");
        let dir = temp_dir("junk");
        let junk = dir.join("junk.kinpak");
        std::fs::write(&junk, "{\"kind\":\"video\",\"key\":\"x\",\"data\":{}}\n").unwrap();
        assert!(import_pack(&db_path, &junk, import_all(), |_| {}).unwrap_err().contains("missing header"));
        assert!(inspect_pack(&junk).is_err());
        std::fs::write(&junk, "{\"kind\":\"header\",\"format\":\"other\",\"pack_version\":1,\"generated_at\":\"x\"}\n").unwrap();
        assert!(import_pack(&db_path, &junk, import_all(), |_| {}).unwrap_err().contains("isn't a Kinesis pack"));
        std::fs::write(&junk, "{\"kind\":\"header\",\"format\":\"kinesis-sync-pack\",\"pack_version\":99,\"generated_at\":\"x\"}\n").unwrap();
        assert!(import_pack(&db_path, &junk, import_all(), |_| {}).unwrap_err().contains("Update the app"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn production_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_kinpak_prod_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        let conn = Connection::open(&p).unwrap();
        conn.execute_batch(include_str!("db/production_schema.sql")).unwrap();
        conn.execute("INSERT INTO tblWDBS (WDBS, lev, WDID, WDInfo) VALUES (':', 0, '', '')", []).unwrap();
        drop(conn);
        init_db(&p).unwrap();
        p
    }

    fn snapshot(db: &str) -> Vec<String> {
        let conn = Connection::open(db).unwrap();
        let mut out = Vec::new();
        for (label, sql) in [
            ("video", "SELECT video_id||'|'||IFNULL(title,'')||'|'||IFNULL(author,'')||'|'||handle||'|'||IFNULL(length_seconds,'')||'|'||IFNULL(transcript,'')||'|'||IFNULL(summary,'')||'|'||IFNULL(view_count,'')||'|'||IFNULL(published_at,'')||'|'||IFNULL(tags,'')||'|'||WDBS FROM Videos ORDER BY video_id"),
            ("bio", "SELECT handle||'|'||display_name||'|'||bio||'|'||website FROM Biographies ORDER BY handle"),
            ("glossary", "SELECT term||'|'||drives||'|'||definition FROM Glossary ORDER BY term, drives"),
            ("link", "SELECT video_id||'|'||WDBS FROM VideoWDBSLinks ORDER BY 1"),
            ("wdbs", "SELECT WDBS||'|'||lev||'|'||WDID||'|'||WDInfo||'|'||WDIcon FROM tblWDBS WHERE WDBS <> ':' ORDER BY WDBS"),
            ("prompt", "SELECT handle||'|'||IFNULL(local_prompt_text,'')||'|'||IFNULL(cloud_prompt_text,'') FROM CustomPrompts ORDER BY handle"),
            ("note", "SELECT video_id||'|'||note FROM VideoNotes ORDER BY 1"),
            ("attachment", "SELECT video_id||'|'||name||'|'||ext||'|'||hash FROM VideoAttachments ORDER BY 1, name"),
            ("blob", "SELECT hash||'|'||size FROM AttachmentBlobs ORDER BY hash"),
        ] {
            let mut stmt = conn.prepare(sql).unwrap();
            for row in stmt.query_map([], |r| r.get::<_, String>(0)).unwrap() {
                out.push(format!("{label}: {}", row.unwrap()));
            }
        }
        out
    }

    #[test]
    fn a_pack_round_trips_between_production_schema_databases() {
        let src = production_db("rt_src");
        let conn = Connection::open(&src).unwrap();
        conn.execute("INSERT INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDIcon) VALUES (':UAP', 1, 'UAP', 'Aliased', 'star')", []).unwrap();
        conn.execute("INSERT INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDIcon) VALUES (':FIN', 1, 'FIN', 'Finance', '')", []).unwrap();
        drop(conn);
        db::biography::upsert_biography_from_video(&src, "@auth", "Author", Some("UCabc"), 500).unwrap();
        db::save_video(&src, "vid1", "Title", "Author", 90, "some transcript words here", 1234, "2024-01-02", "@auth", Some("A summary")).unwrap();
        db::save_video(&src, "vid2", "Second", "Author", 30, "other words", 5, "2024-02-03", "@auth", None).unwrap();
        db::update_video_wdbs(&src, "vid1", "θψUAP").unwrap();
        db::add_video_wdbs_link(&src, "vid1", "θψFIN").unwrap();
        db::save_glossary_term(&src, None, "Halving", "Supply cut", ":FIN").unwrap();
        db::set_custom_prompt(&src, "@auth", Some("local"), Some("cloud")).unwrap();
        db::attachments::add_attachment(&src, "vid1", "notes.txt", b"hello attachment ".repeat(500)).unwrap();
        db::attachments::set_note(&src, "vid1", "my note").unwrap();

        let dir = temp_dir("prod_rt");
        let out = dir.join("prod.kinpak");
        let summary = export_pack_chunked(&src, &out, "Kinesis 0.4.3", "Kinesis", &all(), 4096, |_| {}).unwrap();
        assert_eq!(summary.counts.get("video"), Some(&2), "{:?}", summary.counts);

        // Into another production database and into a from-scratch one: the same library either way.
        let prod_dst = production_db("rt_dst");
        let imported = import_pack(&prod_dst, &out, import_all(), |_| {}).unwrap();
        assert_eq!(imported.error_count, 0, "{:?}", imported.errors);
        let scratch_dst = temp_db("rt_scratch");
        let imported = import_pack(&scratch_dst, &out, import_all(), |_| {}).unwrap();
        assert_eq!(imported.error_count, 0, "{:?}", imported.errors);

        let want = snapshot(&src);
        assert!(want.iter().any(|l| l.starts_with("attachment:")) && want.iter().any(|l| l.starts_with("wdbs:")));
        assert_eq!(snapshot(&prod_dst), want, "production -> production");
        assert_eq!(snapshot(&scratch_dst), want, "production -> from-scratch");

        // And importing the same pack again changes nothing.
        let again = import_pack(&prod_dst, &out, import_all(), |_| {}).unwrap();
        assert_eq!(again.error_count, 0, "{:?}", again.errors);
        assert_eq!(snapshot(&prod_dst), want, "second import");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two Drives (:UAP and :FIN) with videos, links, terms, bios, notes and attachments touching both.
    fn two_drive_library(db: &str) {
        let conn = Connection::open(db).unwrap();
        for (path, lev, id) in [(":UAP", 1, "UAP"), (":UAP-GERB", 2, "GERB"), (":FIN", 1, "FIN")] {
            conn.execute("INSERT OR IGNORE INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDIcon, WDDefault) VALUES (?1, ?2, ?3, '', '', 0)", params![path, lev, id]).unwrap();
        }
        let video = |id: &str, wdbs: &str, handle: &str, summary: &str| {
            conn.execute(
                "INSERT INTO Videos (video_id, title, author, handle, length_seconds, transcript, summary, view_count, published_at, tags, WDBS)
                 VALUES (?1, ?1, 'A', ?2, 60, 'words', ?3, 1, '2024-01-01', '', ?4)",
                params![id, handle, summary, wdbs],
            )
            .unwrap();
        };
        // a1 only in :UAP; f1 only in :FIN (and mentions a1 and two terms); m1 is homed in :UAP but also
        // linked into :FIN; m2 is homed in :FIN and linked into :UAP; u1 has no category.
        video("a1", "θψUAP_GERB", "@uapguy", "");
        video("f1", "θψFIN", "@fingal", "See [a1](kinesis://video/a1), [only](kinesis://glossary/OnlyUap) and [both](kinesis://glossary/Both).");
        video("m1", "θψUAP_GERB", "@mixed", "");
        video("m2", "θψFIN", "@mixed", "");
        video("u1", ":", "@free", "");
        conn.execute("INSERT INTO VideoWDBSLinks (video_id, wdbs) VALUES ('m1', 'θψFIN'), ('m2', 'θψUAP_GERB')", []).unwrap();
        for (term, drives) in [("OnlyUap", ":UAP"), ("Both", ":FIN\n:UAP"), ("Free", ""), ("OnlyFin", ":FIN")] {
            conn.execute("INSERT INTO Glossary (term, definition, drives) VALUES (?1, 'defined', ?2)", params![term, drives]).unwrap();
        }
        for handle in ["@uapguy", "@fingal", "@mixed", "@free"] {
            conn.execute("INSERT INTO Biographies (handle, display_name, bio) VALUES (?1, ?1, 'bio')", [handle]).unwrap();
            conn.execute("INSERT INTO CustomPrompts (handle, local_prompt_text, cloud_prompt_text) VALUES (?1, 'l', 'c')", [handle]).unwrap();
        }
        drop(conn);
        for (video, file, seed) in [("a1", "a.txt", 1u8), ("f1", "f.txt", 2u8)] {
            db::attachments::add_attachment(db, video, file, vec![seed; 3000]).unwrap();
            db::attachments::set_note(db, video, "a note").unwrap();
        }
    }

    fn column(db: &str, sql: &str) -> Vec<String> {
        let conn = Connection::open(db).unwrap();
        let mut stmt = conn.prepare(sql).unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// "TermRoot" for every (term, Drive) filing, sorted — a row holds a newline-separated list.
    fn glossary_drive_pairs(db: &str) -> Vec<String> {
        let conn = Connection::open(db).unwrap();
        let mut stmt = conn.prepare("SELECT term, drives FROM Glossary WHERE drives != ''").unwrap();
        let mut out: Vec<String> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .flat_map(|row| {
                let (term, drives) = row.unwrap();
                drives.lines().map(move |root| format!("{term}{root}")).collect::<Vec<_>>()
            })
            .collect();
        out.sort();
        out
    }

    fn export_and_import(src: &str, drives: DriveScope, name: &str) -> (String, ExportSummary) {
        let dir = temp_dir(name);
        let out = dir.join("scoped.kinpak");
        let opts = ExportOptions { drives, ..all() };
        let summary = export_pack_chunked(src, &out, "Kinesis 0.4.3", "Kinesis", &opts, 4096, |_| {}).unwrap();
        let dst = temp_db(&format!("{name}_dst"));
        let imported = import_pack(&dst, &out, import_all(), |_| {}).unwrap();
        assert_eq!(imported.error_count, 0, "{:?}", imported.errors);
        let _ = std::fs::remove_dir_all(&dir);
        (dst, summary)
    }

    #[test]
    fn leaving_a_drive_out_keeps_what_remains_consistent() {
        let src = temp_db("scope_src");
        two_drive_library(&src);
        let (dst, summary) = export_and_import(&src, DriveScope { excluded: vec![":UAP".into()], ..DriveScope::default() }, "scope_keep");

        // The Drive, its categories and its only-video are gone; a video also linked into :FIN stays and moves there.
        assert_eq!(column(&dst, "SELECT video_id FROM Videos ORDER BY video_id"), ["f1", "m1", "m2", "u1"]);
        assert_eq!(column(&dst, "SELECT WDBS FROM Videos WHERE video_id = 'm1'"), ["θψFIN"]);
        assert_eq!(column(&dst, "SELECT WDBS FROM Videos WHERE video_id = 'u1'"), [":"], "videos with no category are untouched");
        assert!(column(&dst, "SELECT WDBS FROM tblWDBS WHERE WDBS LIKE ':UAP%'").is_empty(), "the left-out Drive must not come back on import");
        assert!(!column(&dst, "SELECT WDBS FROM tblWDBS WHERE WDBS = ':FIN'").is_empty());
        // m2's link into :UAP has nothing to point at, and m1's link into :FIN is now its home (not listed twice).
        assert!(column(&dst, "SELECT video_id FROM VideoWDBSLinks").is_empty());

        // Terms are kept, without the left-out Drive.
        assert_eq!(column(&dst, "SELECT term FROM Glossary ORDER BY term"), ["Both", "Free", "OnlyFin", "OnlyUap"]);
        assert_eq!(glossary_drive_pairs(&dst), ["Both:FIN", "OnlyFin:FIN"]);

        // A creator whose only video went is left out with their prompt; the others stay.
        assert_eq!(column(&dst, "SELECT handle FROM Biographies ORDER BY handle"), ["@fingal", "@free", "@mixed"]);
        assert_eq!(column(&dst, "SELECT handle FROM CustomPrompts ORDER BY handle"), ["@fingal", "@free", "@mixed"]);

        // Notes and attachments follow their video; the unused file isn't written.
        assert_eq!(column(&dst, "SELECT video_id FROM VideoNotes"), ["f1"]);
        assert_eq!(column(&dst, "SELECT video_id FROM VideoAttachments"), ["f1"]);
        assert_eq!(column(&dst, "SELECT CAST(COUNT(*) AS TEXT) FROM AttachmentBlobs"), ["1"]);

        // Links in kept text to what was left out become plain text; links to what stayed remain.
        let summary_text = column(&dst, "SELECT summary FROM Videos WHERE video_id = 'f1'").remove(0);
        assert!(summary_text.starts_with("See a1, "), "{summary_text}");
        assert!(summary_text.contains("[only](kinesis://glossary/OnlyUap)"), "{summary_text}");
        assert!(summary_text.contains("[both](kinesis://glossary/Both)"), "{summary_text}");

        // The summary reports what was actually written.
        assert_eq!(summary.counts.get("video"), Some(&4));
        assert_eq!(summary.counts.get("biography"), Some(&3));
        assert_eq!(summary.counts.get("attachment"), Some(&1));
    }

    #[test]
    fn a_video_with_no_link_into_a_kept_drive_can_stay_uncategorized() {
        let src = temp_db("scope_src3");
        two_drive_library(&src);
        // a1 is based only in :UAP (no link into :FIN); m1 is based there too but linked into :FIN.
        let scope = DriveScope { excluded: vec![":UAP".into()], keep_unlinked_videos: true, ..DriveScope::default() };
        let (dst, _) = export_and_import(&src, scope, "scope_orphans");
        assert_eq!(column(&dst, "SELECT video_id FROM Videos ORDER BY video_id"), ["a1", "f1", "m1", "m2", "u1"]);
        assert_eq!(column(&dst, "SELECT WDBS FROM Videos WHERE video_id = 'a1'"), [":"], "no kept link: uncategorized");
        assert_eq!(column(&dst, "SELECT WDBS FROM Videos WHERE video_id = 'm1'"), ["θψFIN"], "a kept link still becomes the home");
        assert!(column(&dst, "SELECT WDBS FROM tblWDBS WHERE WDBS LIKE ':UAP%'").is_empty());
        // Its creator stays, since a video of theirs does.
        assert_eq!(column(&dst, "SELECT handle FROM Biographies ORDER BY handle"), ["@fingal", "@free", "@mixed", "@uapguy"]);

        // Keeping everything but not promoting: m1 is uncategorized too, and keeps its link into :FIN.
        let scope = DriveScope { excluded: vec![":UAP".into()], keep_linked_videos: false, keep_unlinked_videos: true, ..DriveScope::default() };
        let (dst, _) = export_and_import(&src, scope, "scope_orphans2");
        assert_eq!(column(&dst, "SELECT WDBS FROM Videos WHERE video_id = 'm1'"), [":"]);
        assert_eq!(column(&dst, "SELECT video_id || wdbs FROM VideoWDBSLinks"), ["m1θψFIN"]);
    }

    #[test]
    fn the_other_choices_when_leaving_a_drive_out() {
        let src = temp_db("scope_src2");
        two_drive_library(&src);
        let scope = DriveScope { excluded: vec![":UAP".into()], terms: crate::drive_scope::TermsMode::Drop, keep_linked_videos: false, keep_unlinked_videos: false, unlink_text: false };
        let (dst, _) = export_and_import(&src, scope, "scope_drop");

        // m1 is homed in the left-out Drive, so it goes too; terms filed only there go; mixed ones stay.
        assert_eq!(column(&dst, "SELECT video_id FROM Videos ORDER BY video_id"), ["f1", "m2", "u1"]);
        assert_eq!(column(&dst, "SELECT term FROM Glossary ORDER BY term"), ["Both", "Free", "OnlyFin"]);
        assert_eq!(glossary_drive_pairs(&dst), ["Both:FIN", "OnlyFin:FIN"]);
        // Links in text are left exactly as they were when asked to.
        let summary_text = column(&dst, "SELECT summary FROM Videos WHERE video_id = 'f1'").remove(0);
        assert!(summary_text.contains("[a1](kinesis://video/a1)"), "{summary_text}");

        // Nothing left out means nothing changes.
        let everything = temp_db("scope_all");
        let (all_dst, _) = export_and_import(&src, DriveScope::default(), "scope_none");
        assert_eq!(column(&all_dst, "SELECT video_id FROM Videos ORDER BY video_id"), ["a1", "f1", "m1", "m2", "u1"]);
        let _ = std::fs::remove_file(&everything);
    }
}
