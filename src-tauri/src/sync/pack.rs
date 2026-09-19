//! Export and import of the "sync pack": an NDJSON file of the syncable data (docs/sync-protocol.md).
//!
//! Export writes everything a sync server could deliver, minus secrets: content rows plus the
//! allowlisted settings. Import applies a pack as ordinary local data, so it works offline and
//! never marks anything as server-owned.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use kinesis_sync_proto::pack::PackHeader;
use kinesis_sync_proto::sqlite::{self, ReadOptions};
use kinesis_sync_proto::{
    content_hash, is_syncable_setting, Item, Kind, PackLine, PackReader, PackWriter, Policy, PACK_FORMAT,
    PACK_VERSION,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db;
use crate::db::sync::open_sync_conn;

/// Import applies items in transactions of at most this many rows / this many payload bytes.
const IMPORT_BATCH_ITEMS: usize = 100;
const IMPORT_BATCH_BYTES: usize = 32 * 1024 * 1024;
const MAX_REPORTED_ERRORS: usize = 20;

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
    /// Allowlisted settings (never API keys or paths), written as a policy line.
    pub settings: bool,
    /// Set by the command from the chosen file name (see `resolve_pack_path`), not by the UI.
    #[serde(default)]
    pub gzip: bool,
}

#[derive(Debug, Serialize)]
pub struct ExportSummary {
    pub path: String,
    pub counts: BTreeMap<String, u64>,
    pub settings: u64,
    pub bytes: u64,
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

struct Out<W: std::io::Write> {
    writer: PackWriter<W>,
    counts: BTreeMap<String, u64>,
}

impl<W: std::io::Write> Out<W> {
    fn item(&mut self, kind: Kind, key: &str, data: Value) -> Result<(), String> {
        let hash = content_hash(kind.as_str(), key, &data);
        let item = Item { kind: kind.as_str().to_string(), key: key.to_string(), rev: None, hash, data };
        self.writer.write_item(&item).map_err(|e| e.to_string())?;
        *self.counts.entry(kind.as_str().to_string()).or_default() += 1;
        Ok(())
    }
}

/// Turns the path a user chose in the Save As dialog into where the pack is written, and whether it
/// is compressed. A `.gz` name is compressed, `.jsonl` is plain; a name with neither (someone typed
/// "backup") gets `.jsonl.gz`, the default, so the file always announces what it is.
pub fn resolve_pack_path(chosen: &str) -> (PathBuf, bool) {
    let lower = chosen.to_lowercase();
    if lower.ends_with(".gz") {
        (PathBuf::from(chosen), true)
    } else if lower.ends_with(".jsonl") {
        (PathBuf::from(chosen), false)
    } else {
        (PathBuf::from(format!("{chosen}.jsonl.gz")), true)
    }
}

/// Writes the pack to exactly `path` (the Save As dialog has already confirmed any overwrite).
/// Whether it is compressed is `opts.gzip`; see `resolve_pack_path` for deriving it from the name.
pub fn export_pack(
    db_path: &str,
    path: &Path,
    app_label: &str,
    brand: &str,
    opts: &ExportOptions,
    progress: impl Fn(&str),
) -> Result<ExportSummary, String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let path: PathBuf = path.to_path_buf();

    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let file = File::create(&path).map_err(|e| format!("Couldn't create {}: {e}", path.display()))?;
    let mut out = Out { writer: PackWriter::new(BufWriter::new(file), opts.gzip), counts: BTreeMap::new() };

    // Which kinds to write, in the order an importer must apply them (taxonomy first).
    let plan: [(bool, Kind, &str); 6] = [
        (opts.taxonomy, Kind::Wdbs, "Exporting taxonomy…"),
        (opts.videos, Kind::Video, "Exporting videos…"),
        (opts.videos, Kind::VideoLink, ""),
        (opts.glossary, Kind::Glossary, "Exporting glossary…"),
        (opts.biographies, Kind::Biography, "Exporting biographies…"),
        (opts.prompts, Kind::CustomPrompt, "Exporting custom prompts…"),
    ];

    // The header carries expected counts for progress UIs only; the reader never trusts them.
    let mut header = PackHeader::new(&chrono::Utc::now().to_rfc3339(), app_label, brand);
    for (on, kind, _) in plan {
        if on {
            header.counts.insert(kind.as_str().to_string(), sqlite::count_kind(&conn, kind));
        }
    }
    out.writer.write_header(&header).map_err(|e| e.to_string())?;

    // The same readers the sync server uses, so a pack and a server produce identical payloads.
    let read_opts = ReadOptions { transcripts: opts.transcripts };
    for (on, kind, label) in plan {
        if !on {
            continue;
        }
        if !label.is_empty() {
            progress(label);
        }
        sqlite::for_each_item(&conn, kind, &read_opts, |key, data| out.item(kind, key, data))?;
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

pub fn import_pack(
    db_path: &str,
    path: &Path,
    apply_settings: bool,
    progress: impl Fn(&str),
) -> Result<ImportSummary, String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let mut reader = PackReader::new(file).map_err(|e| e.to_string())?;

    let mut summary = ImportSummary::default();
    match reader.next_line()? {
        Some(PackLine::Header(h)) => {
            if h.format != PACK_FORMAT {
                return Err("This isn't a Kinesis sync pack.".into());
            }
            if h.pack_version > PACK_VERSION {
                return Err(format!(
                    "This pack is format v{} but this app reads up to v{}. Update the app.",
                    h.pack_version, PACK_VERSION
                ));
            }
            summary.pack_app = h.app;
            summary.pack_generated_at = h.generated_at;
        }
        _ => return Err("This isn't a Kinesis sync pack (missing header).".into()),
    }

    let mut conn = open_sync_conn(db_path).map_err(|e| e.to_string())?;
    let mut batch: Vec<Item> = Vec::new();
    let mut batch_bytes = 0usize;
    let mut policy: Option<Policy> = None;
    let mut total_read = 0u64;

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
        summary.error_count += stats.errors.len() as u64;
        for e in stats.errors {
            if summary.errors.len() < MAX_REPORTED_ERRORS {
                summary.errors.push(e);
            }
        }
        batch.clear();
        Ok(())
    };

    while let Some(line) = reader.next_line()? {
        match line {
            PackLine::Item(item) => {
                batch_bytes += reader.last_line_bytes();
                batch.push(item);
                total_read += 1;
                if batch.len() >= IMPORT_BATCH_ITEMS || batch_bytes >= IMPORT_BATCH_BYTES {
                    flush(&mut batch, &mut summary, &mut conn)?;
                    batch_bytes = 0;
                    progress(&format!("Imported {total_read} items…"));
                }
            }
            PackLine::Policy(p) => policy = Some(p),
            PackLine::Header(_) => return Err("The pack has more than one header.".into()),
        }
    }
    flush(&mut batch, &mut summary, &mut conn)?;

    if let Some(p) = policy {
        for (k, v) in p.settings {
            if apply_settings && is_syncable_setting(&k) && db::set_setting(db_path, &k, &v).is_ok() {
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
    use rusqlite::params;

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_pack_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn all(gzip: bool) -> ExportOptions {
        ExportOptions {
            taxonomy: true,
            videos: true,
            transcripts: true,
            glossary: true,
            biographies: true,
            prompts: true,
            settings: true,
            gzip,
        }
    }

    fn seed(db_path: &str) {
        let conn = Connection::open(db_path).unwrap();
        conn.execute("INSERT OR IGNORE INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDIcon, WDDefault) VALUES (':UAP', 1, 'UAP', 'Aliased', 'star', 0)", []).unwrap();
        conn.execute(
            "INSERT INTO videos (video_id, title, author, handle, length_seconds, transcript, summary, view_count, published_at, tags, WDBS)
             VALUES ('vid1', 'Title', 'Author', '@auth', 90, 'some transcript words here', 'A summary', 1234, '2024-01-02', 'a,b', 'θψUAP')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO video_wdbs_links (video_id, wdbs) VALUES ('vid1', 'θψCRYPTO')", []).unwrap();
        conn.execute("INSERT INTO glossary (term, definition) VALUES ('term', 'def')", []).unwrap();
        conn.execute("INSERT INTO glossary_drives (term, root) VALUES ('term', ':UAP'), ('term', ':FIN')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO biographies (handle, display_name, bio, subscriber_count) VALUES ('@auth', 'Auth', 'Bio', 42)", []).unwrap();
        conn.execute("INSERT INTO custom_prompts (handle, local_prompt_text, cloud_prompt_text) VALUES ('@auth', 'local', 'cloud')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('showBiography', 'false')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('venice_api_key', 'SECRET-VENICE')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('api_key', 'SECRET-YT')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync_token', 'SECRET-SYNC')", []).unwrap();
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('obsidianExportPath', 'C:/private/path')", []).unwrap();
    }

    #[test]
    fn export_contains_no_secrets_and_round_trips_into_a_fresh_db() {
        for gzip in [false, true] {
            let src = temp_db(&format!("src{gzip}"));
            seed(&src);
            let dir = std::env::temp_dir().join(format!("kinesis_pack_out_{}_{gzip}", std::process::id()));
            // Exactly the chosen file (in a folder that doesn't exist yet), named as the user named it.
            let out = dir.join("nested").join(if gzip { "my pack.jsonl.gz" } else { "my pack.jsonl" });
            let summary = export_pack(&src, &out, "Kinesis 0.4.2", "Kinesis", &all(gzip), |_| {}).unwrap();
            assert_eq!(Path::new(&summary.path), out.as_path());
            assert!(out.exists());
            assert_eq!(summary.counts.get("video"), Some(&1));
            assert_eq!(summary.counts.get("video_link"), Some(&1));
            assert_eq!(summary.counts.get("biography"), Some(&1));
            // Seeded defaults (showSearch, ...) are allowlisted too; the secrets above are not.
            assert!(summary.settings >= 1);

            // The file, decompressed if needed, must not contain any secret or private path.
            let mut text = String::new();
            let mut r = PackReader::new(File::open(&summary.path).unwrap()).unwrap();
            while let Some(line) = r.next_line().unwrap() {
                text.push_str(&format!("{line:?}\n"));
            }
            for secret in ["SECRET-VENICE", "SECRET-YT", "SECRET-SYNC", "C:/private/path", "api_key", "sync_token"] {
                assert!(!text.contains(secret), "pack leaked {secret}");
            }

            // Import into a brand-new database.
            let dst = temp_db(&format!("dst{gzip}"));
            let imported = import_pack(&dst, Path::new(&summary.path), true, |_| {}).unwrap();
            assert_eq!(imported.error_count, 0, "{:?}", imported.errors);
            assert_eq!(imported.settings_applied, summary.settings);
            assert_eq!(imported.settings_skipped, 0);
            let conn = Connection::open(&dst).unwrap();
            let (title, transcript, wdbs, views): (String, String, String, i64) = conn
                .query_row("SELECT title, transcript, WDBS, view_count FROM videos WHERE video_id='vid1'", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .unwrap();
            assert_eq!((title.as_str(), transcript.as_str(), wdbs.as_str(), views), ("Title", "some transcript words here", "θψUAP", 1234));
            let alias: String = conn.query_row("SELECT WDInfo FROM tblWDBS WHERE WDBS=':UAP'", [], |r| r.get(0)).unwrap();
            assert_eq!(alias, "Aliased");
            let subs: i64 = conn.query_row("SELECT subscriber_count FROM biographies WHERE handle='@auth'", [], |r| r.get(0)).unwrap();
            assert_eq!(subs, 42);
            let links: i64 = conn.query_row("SELECT COUNT(*) FROM video_wdbs_links WHERE video_id='vid1'", [], |r| r.get(0)).unwrap();
            assert_eq!(links, 1);
            let drives: String = conn
                .query_row("SELECT group_concat(root) FROM (SELECT root FROM glossary_drives WHERE term='term' ORDER BY root)", [], |r| r.get(0))
                .unwrap();
            assert_eq!(drives, ":FIN,:UAP", "glossary drive assignments survive an export/import round trip");
            let prompt: String = conn.query_row("SELECT cloud_prompt_text FROM custom_prompts WHERE handle='@auth'", [], |r| r.get(0)).unwrap();
            assert_eq!(prompt, "cloud");
            assert_eq!(db::get_setting(&dst, "showBiography").unwrap().as_deref(), Some("false"));
            // Imported rows are plain local data.
            let owned: i64 = conn.query_row("SELECT COUNT(*) FROM sync_items", [], |r| r.get(0)).unwrap();
            assert_eq!(owned, 0);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn excluding_transcripts_and_settings_is_honoured() {
        let src = temp_db("opts");
        seed(&src);
        let dir = std::env::temp_dir().join(format!("kinesis_pack_opts_{}", std::process::id()));
        let opts = ExportOptions { transcripts: false, settings: false, ..all(false) };
        let summary = export_pack(&src, &dir.join("p.jsonl"), "Kinesis", "Kinesis", &opts, |_| {}).unwrap();
        assert_eq!(summary.settings, 0);

        let dst = temp_db("opts_dst");
        let conn = Connection::open(&dst).unwrap();
        conn.execute("INSERT INTO videos (video_id, title, transcript) VALUES ('vid1', 'Old', 'my own transcript')", []).unwrap();
        drop(conn);
        import_pack(&dst, Path::new(&summary.path), true, |_| {}).unwrap();
        let conn = Connection::open(&dst).unwrap();
        let (title, transcript): (String, String) = conn
            .query_row("SELECT title, transcript FROM videos WHERE video_id='vid1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(title, "Title");
        assert_eq!(transcript, "my own transcript", "a pack without transcripts must not blank the local one");
        assert!(db::get_setting(&dst, "showBiography").unwrap().map(|v| v != "false").unwrap_or(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_never_overrides_server_owned_rows_and_settings_need_opt_in() {
        let src = temp_db("own_src");
        seed(&src);
        let dir = std::env::temp_dir().join(format!("kinesis_pack_own_{}", std::process::id()));
        let summary = export_pack(&src, &dir.join("p.jsonl"), "Kinesis", "Kinesis", &all(false), |_| {}).unwrap();

        let dst = temp_db("own_dst");
        let conn = Connection::open(&dst).unwrap();
        conn.execute("INSERT INTO glossary (term, definition) VALUES ('term', 'server version')", []).unwrap();
        conn.execute("INSERT INTO sync_items (kind, item_key, rev, content_hash) VALUES ('glossary', 'term', 1, 'h')", params![]).unwrap();
        drop(conn);
        let imported = import_pack(&dst, Path::new(&summary.path), false, |_| {}).unwrap();
        let conn = Connection::open(&dst).unwrap();
        let def: String = conn.query_row("SELECT definition FROM glossary WHERE term='term'", [], |r| r.get(0)).unwrap();
        assert_eq!(def, "server version");
        assert!(imported.skipped >= 1);
        assert_eq!(imported.settings_applied, 0);
        assert_eq!(imported.settings_skipped, summary.settings);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_saved_files_name_decides_whether_it_is_compressed() {
        assert_eq!(resolve_pack_path("C:/x/pack.jsonl.gz"), (PathBuf::from("C:/x/pack.jsonl.gz"), true));
        assert_eq!(resolve_pack_path("C:/x/PACK.JSONL"), (PathBuf::from("C:/x/PACK.JSONL"), false));
        assert_eq!(resolve_pack_path("/x/backup.gz"), (PathBuf::from("/x/backup.gz"), true));
        // No recognizable extension: the compressed default, named so it says what it is.
        assert_eq!(resolve_pack_path("/x/backup"), (PathBuf::from("/x/backup.jsonl.gz"), true));
        assert_eq!(resolve_pack_path("/x/my.pack"), (PathBuf::from("/x/my.pack.jsonl.gz"), true));
    }

    #[test]
    fn non_packs_are_rejected() {
        let db_path = temp_db("bad");
        let dir = std::env::temp_dir().join(format!("kinesis_pack_bad_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let junk = dir.join("junk.jsonl");
        std::fs::write(&junk, "{\"kind\":\"video\",\"key\":\"x\",\"data\":{}}\n").unwrap();
        assert!(import_pack(&db_path, &junk, false, |_| {}).unwrap_err().contains("missing header"));
        std::fs::write(&junk, "{\"kind\":\"header\",\"format\":\"other\",\"pack_version\":1,\"generated_at\":\"x\"}\n").unwrap();
        assert!(import_pack(&db_path, &junk, false, |_| {}).unwrap_err().contains("isn't a Kinesis sync pack"));
        std::fs::write(&junk, "{\"kind\":\"header\",\"format\":\"kinesis-sync-pack\",\"pack_version\":99,\"generated_at\":\"x\"}\n").unwrap();
        assert!(import_pack(&db_path, &junk, false, |_| {}).unwrap_err().contains("Update the app"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
