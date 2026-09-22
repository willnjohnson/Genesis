//! Reads syncable rows out of a Kinesis SQLite database as protocol items (feature `sqlite`).
//!
//! Shared by the client's pack export and the sync server's scanner, so both produce byte-identical
//! item payloads (and therefore identical content hashes) from the same database.

use std::collections::BTreeMap;

use rusqlite::types::ValueRef;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Row};
use serde_json::Value;

use crate::settings::is_syncable_setting;
use crate::types::{
    link_key, sequence_key, split_link_key, split_sequence_key, BiographyData, CustomPromptData, GlossaryData, Kind,
    SequenceData, VideoData, VideoLinkData, WdbsData,
};

#[derive(Debug, Clone, Copy)]
pub struct ReadOptions {
    /// Transcripts dominate size; without them titles, summaries and tags still travel.
    pub transcripts: bool,
}

impl Default for ReadOptions {
    fn default() -> Self {
        ReadOptions { transcripts: true }
    }
}

// ─── Column readers tolerant of SQLite's loose typing ─────────────────────────

fn os(row: &Row, i: usize) -> Option<String> {
    match row.get_ref(i).ok()? {
        ValueRef::Null | ValueRef::Blob(_) => None,
        ValueRef::Integer(n) => Some(n.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
    }
}

fn oi(row: &Row, i: usize) -> Option<i64> {
    match row.get_ref(i).ok()? {
        ValueRef::Integer(n) => Some(n),
        ValueRef::Real(f) => Some(f as i64),
        ValueRef::Text(t) => String::from_utf8_lossy(t).trim().parse().ok(),
        _ => None,
    }
}

fn key(row: &Row, i: usize) -> Option<String> {
    os(row, i).map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

type Built = Option<(String, Value)>;

fn to_value<T: serde::Serialize>(k: String, data: &T) -> Built {
    serde_json::to_value(data).ok().map(|v| (k, v))
}

fn build_wdbs(row: &Row, _: &ReadOptions) -> Built {
    let k = key(row, 0)?;
    to_value(k, &WdbsData { lev: oi(row, 1), wdid: os(row, 2), info: os(row, 3), icon: os(row, 4), default: oi(row, 5) })
}

fn build_video(row: &Row, opts: &ReadOptions) -> Built {
    let k = key(row, 0)?;
    to_value(
        k,
        &VideoData {
            title: os(row, 1),
            author: os(row, 2),
            handle: os(row, 3),
            length_seconds: oi(row, 4),
            transcript: if opts.transcripts { os(row, 5) } else { None },
            summary: os(row, 6),
            view_count: oi(row, 7),
            published_at: os(row, 8),
            tags: os(row, 9),
            wdbs: os(row, 10),
        },
    )
}

fn build_link(row: &Row, _: &ReadOptions) -> Built {
    let (v, w) = (key(row, 0)?, key(row, 1)?);
    to_value(link_key(&v, &w), &VideoLinkData { video_id: v, wdbs: w })
}

fn build_sequence(row: &Row, _: &ReadOptions) -> Built {
    let (d, v) = (key(row, 0)?, key(row, 1)?);
    let position = oi(row, 2)?;
    to_value(sequence_key(&d, &v), &SequenceData { drive: d, video_id: v, position })
}

fn build_glossary(row: &Row, _: &ReadOptions) -> Built {
    let k = key(row, 0)?;
    // Column 2 is Glossary's own `drives` column (newline-joined roots, "" when the term has
    // none) — always present, so this is always `Some`, never the "sender doesn't know" `None`
    // GlossaryData still allows for (an old pack that predates this field entirely).
    let joined = os(row, 2).unwrap_or_default();
    let mut roots: Vec<String> = joined.split('\n').filter(|r| !r.is_empty()).map(String::from).collect();
    roots.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b)));
    roots.dedup();
    to_value(k, &GlossaryData { definition: os(row, 1), drives: Some(roots) })
}

fn build_biography(row: &Row, _: &ReadOptions) -> Built {
    let k = key(row, 0)?;
    to_value(
        k,
        &BiographyData {
            display_name: os(row, 1),
            bio: os(row, 2),
            wikipedia: os(row, 3),
            website: os(row, 4),
            twitter: os(row, 5),
            instagram: os(row, 6),
            facebook: os(row, 7),
            threads: os(row, 8),
            youtube: os(row, 9),
            tiktok: os(row, 10),
            twitch: os(row, 11),
            reddit: os(row, 12),
            discord: os(row, 13),
            channel_id: os(row, 14),
            // -1 is the "unknown" sentinel; it round-trips as-is.
            subscriber_count: oi(row, 15),
        },
    )
}

fn build_prompt(row: &Row, _: &ReadOptions) -> Built {
    let k = key(row, 0)?;
    to_value(k, &CustomPromptData { local_prompt_text: os(row, 1), cloud_prompt_text: os(row, 2) })
}

struct Spec {
    table: &'static str,
    /// Every row, in a stable order.
    all: &'static str,
    /// One row; `?1` (and `?2` for links) bind the key parts.
    one: &'static str,
    build: fn(&Row, &ReadOptions) -> Built,
}

fn spec(kind: Kind) -> Spec {
    match kind {
        Kind::Wdbs => Spec {
            table: "tblWDBS",
            all: "SELECT WDBS, lev, WDID, WDInfo, WDIcon, WDDefault FROM tblWDBS ORDER BY lev, WDBS",
            one: "SELECT WDBS, lev, WDID, WDInfo, WDIcon, WDDefault FROM tblWDBS WHERE WDBS = ?1",
            build: build_wdbs,
        },
        Kind::Video => Spec {
            table: "Videos",
            all: "SELECT video_id, title, author, handle, length_seconds, transcript, summary,
                         view_count, published_at, tags, WDBS FROM Videos ORDER BY video_id",
            one: "SELECT video_id, title, author, handle, length_seconds, transcript, summary,
                         view_count, published_at, tags, WDBS FROM Videos WHERE video_id = ?1",
            build: build_video,
        },
        Kind::VideoLink => Spec {
            table: "VideoWDBSLinks",
            all: "SELECT video_id, wdbs FROM VideoWDBSLinks ORDER BY video_id, wdbs",
            one: "SELECT video_id, wdbs FROM VideoWDBSLinks WHERE video_id = ?1 AND wdbs = ?2",
            build: build_link,
        },
        Kind::DriveSequence => Spec {
            table: "DriveSequence",
            all: "SELECT drive, video_id, position FROM DriveSequence ORDER BY drive, position, video_id",
            one: "SELECT drive, video_id, position FROM DriveSequence WHERE drive = ?1 AND video_id = ?2",
            build: build_sequence,
        },
        Kind::Glossary => Spec {
            table: "Glossary",
            all: "SELECT term, definition, drives FROM Glossary ORDER BY term",
            one: "SELECT term, definition, drives FROM Glossary WHERE term = ?1",
            build: build_glossary,
        },
        Kind::Biography => Spec {
            table: "Biographies",
            all: "SELECT handle, display_name, bio, wikipedia, website, twitter, instagram, facebook,
                         threads, youtube, tiktok, twitch, reddit, discord, channel_id, subscriber_count
                  FROM Biographies ORDER BY handle",
            one: "SELECT handle, display_name, bio, wikipedia, website, twitter, instagram, facebook,
                         threads, youtube, tiktok, twitch, reddit, discord, channel_id, subscriber_count
                  FROM Biographies WHERE handle = ?1",
            build: build_biography,
        },
        Kind::CustomPrompt => Spec {
            table: "CustomPrompts",
            all: "SELECT handle, local_prompt_text, cloud_prompt_text FROM CustomPrompts ORDER BY handle",
            one: "SELECT handle, local_prompt_text, cloud_prompt_text FROM CustomPrompts WHERE handle = ?1",
            build: build_prompt,
        },
    }
}

pub fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1 COLLATE NOCASE", [table], |r| r.get::<_, i64>(0))
        .map(|n| n > 0)
        .unwrap_or(false)
}

/// Row count of the table behind `kind` (0 when the table doesn't exist).
pub fn count_kind(conn: &Connection, kind: Kind) -> u64 {
    let table = spec(kind).table;
    if !table_exists(conn, table) {
        return 0;
    }
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64
}

/// Streams every row of `kind` to `f` as `(key, payload)`. Returns how many rows were visited.
pub fn for_each_item(
    conn: &Connection,
    kind: Kind,
    opts: &ReadOptions,
    mut f: impl FnMut(&str, Value) -> Result<(), String>,
) -> Result<u64, String> {
    let spec = spec(kind);
    if !table_exists(conn, spec.table) {
        return Ok(0);
    }
    let mut stmt = conn.prepare(spec.all).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut n = 0;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if let Some((k, data)) = (spec.build)(row, opts) {
            f(&k, data)?;
            n += 1;
        }
    }
    Ok(n)
}

/// Loads one item by key, or `None` when it no longer exists.
pub fn load_item(conn: &Connection, kind: Kind, item_key: &str, opts: &ReadOptions) -> Result<Option<Value>, String> {
    let spec = spec(kind);
    if !table_exists(conn, spec.table) {
        return Ok(None);
    }
    let parts: Vec<&str> = if kind == Kind::VideoLink {
        match split_link_key(item_key) {
            Some((v, w)) => vec![v, w],
            None => return Ok(None),
        }
    } else if kind == Kind::DriveSequence {
        match split_sequence_key(item_key) {
            Some((d, v)) => vec![d, v],
            None => return Ok(None),
        }
    } else {
        vec![item_key]
    };
    let mut stmt = conn.prepare(spec.one).map_err(|e| e.to_string())?;
    let built = stmt
        .query_row(params_from_iter(parts.iter()), |row| Ok((spec.build)(row, opts)))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(built.flatten().map(|(_, data)| data))
}

/// The allowlisted settings currently stored in `conn` (never keys, tokens or paths).
pub fn read_syncable_settings(conn: &Connection) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if !table_exists(conn, "Settings") {
        return out;
    }
    let Ok(mut stmt) = conn.prepare("SELECT key, value FROM Settings ORDER BY key") else {
        return out;
    };
    let Ok(mut rows) = stmt.query([]) else {
        return out;
    };
    while let Ok(Some(row)) = rows.next() {
        if let (Some(k), Some(v)) = (os(row, 0), os(row, 1)) {
            if is_syncable_setting(&k) {
                out.insert(k, v);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE Videos (video_id TEXT PRIMARY KEY, title TEXT, author TEXT, handle TEXT, length_seconds INTEGER,
                transcript TEXT, summary TEXT, view_count INTEGER, published_at TEXT, tags TEXT, WDBS TEXT);
             CREATE TABLE VideoWDBSLinks (video_id TEXT NOT NULL, wdbs TEXT NOT NULL, PRIMARY KEY (video_id, wdbs));
             CREATE TABLE DriveSequence (drive TEXT NOT NULL, video_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (drive, video_id));
             CREATE TABLE Settings (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO Videos VALUES ('v1', 'T', 'A', '@a', 60, 'words', NULL, 5, '2024-01-01', 'x,y', 'θψUAP');
             INSERT INTO VideoWDBSLinks VALUES ('v1', 'θψCRYPTO');
             INSERT INTO DriveSequence VALUES (':CS-DSA', 'v1', 1);
             INSERT INTO Settings VALUES ('showDrive', 'false'), ('api_key', 'SECRET'), ('venice_api_key', 'SECRET2');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn streams_and_loads_the_same_payload() {
        let conn = db();
        let mut streamed = vec![];
        let n = for_each_item(&conn, Kind::Video, &ReadOptions::default(), |k, v| {
            streamed.push((k.to_string(), v));
            Ok(())
        })
        .unwrap();
        assert_eq!(n, 1);
        let loaded = load_item(&conn, Kind::Video, "v1", &ReadOptions::default()).unwrap().unwrap();
        assert_eq!(streamed[0].1, loaded, "scan and serve must agree, or hashes would churn");
        assert_eq!(loaded["title"], "T");
        assert_eq!(loaded["summary"], Value::Null);
    }

    #[test]
    fn transcripts_can_be_left_out() {
        let conn = db();
        let v = load_item(&conn, Kind::Video, "v1", &ReadOptions { transcripts: false }).unwrap().unwrap();
        assert_eq!(v["transcript"], Value::Null);
        assert_eq!(v["title"], "T");
    }

    #[test]
    fn links_use_composite_keys_and_missing_tables_are_empty() {
        let conn = db();
        let key = link_key("v1", "θψCRYPTO");
        assert!(load_item(&conn, Kind::VideoLink, &key, &ReadOptions::default()).unwrap().is_some());
        assert!(load_item(&conn, Kind::VideoLink, "nope", &ReadOptions::default()).unwrap().is_none());
        assert!(load_item(&conn, Kind::VideoLink, "v1|θψOTHER", &ReadOptions::default()).unwrap().is_none());
        // No glossary table in this database.
        assert_eq!(for_each_item(&conn, Kind::Glossary, &ReadOptions::default(), |_, _| Ok(())).unwrap(), 0);
        assert_eq!(count_kind(&conn, Kind::Glossary), 0);
        assert_eq!(count_kind(&conn, Kind::Video), 1);
    }

    #[test]
    fn sequence_items_use_composite_keys() {
        let conn = db();
        let key = sequence_key(":CS-DSA", "v1");
        let loaded = load_item(&conn, Kind::DriveSequence, &key, &ReadOptions::default()).unwrap().unwrap();
        assert_eq!((loaded["drive"].as_str(), loaded["video_id"].as_str(), loaded["position"].as_i64()), (Some(":CS-DSA"), Some("v1"), Some(1)));
        assert!(load_item(&conn, Kind::DriveSequence, "nope", &ReadOptions::default()).unwrap().is_none());
        assert!(load_item(&conn, Kind::DriveSequence, ":CS-DSA|other", &ReadOptions::default()).unwrap().is_none());
        assert_eq!(count_kind(&conn, Kind::DriveSequence), 1);
        let mut streamed = vec![];
        for_each_item(&conn, Kind::DriveSequence, &ReadOptions::default(), |k, v| {
            streamed.push((k.to_string(), v));
            Ok(())
        })
        .unwrap();
        assert_eq!(streamed, vec![(key, loaded)]);
    }

    #[test]
    fn glossary_terms_carry_their_drives() {
        let conn = db();
        // `drives` lives directly on Glossary (see src-tauri/src/db/glossary.rs) — no separate
        // join table to read, so this reader always knows a term's filings, never "unknown".
        conn.execute_batch(
            "CREATE TABLE Glossary (term TEXT PRIMARY KEY, definition TEXT NOT NULL, drives TEXT NOT NULL DEFAULT '');
             INSERT INTO Glossary VALUES
                 ('Halving', 'Supply cut', ':FIN' || char(10) || ':CRYPTO'),
                 ('Loose', 'No drive', ''),
                 ('qt', '', '');",
        )
        .unwrap();

        let halving = load_item(&conn, Kind::Glossary, "Halving", &ReadOptions::default()).unwrap().unwrap();
        assert_eq!(halving["drives"], serde_json::json!([":CRYPTO", ":FIN"]), "sorted, so the hash is stable");
        let loose = load_item(&conn, Kind::Glossary, "Loose", &ReadOptions::default()).unwrap().unwrap();
        assert_eq!(loose["drives"], serde_json::json!([]), "empty is a known, empty set");

        let mut streamed = std::collections::BTreeMap::new();
        for_each_item(&conn, Kind::Glossary, &ReadOptions::default(), |k, v| {
            streamed.insert(k.to_string(), v);
            Ok(())
        })
        .unwrap();
        assert_eq!(streamed["Halving"], halving, "scan and serve must agree");
    }

    #[test]
    fn only_allowlisted_settings_are_read() {
        let s = read_syncable_settings(&db());
        assert_eq!(s.get("showDrive").map(String::as_str), Some("false"));
        assert!(!s.contains_key("api_key"));
        assert!(!s.contains_key("venice_api_key"));
        assert_eq!(s.len(), 1);
    }
}
