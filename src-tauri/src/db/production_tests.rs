//! Kinesis against the hand-maintained production schema (production_schema.sql: mixed-case table
//! names, every table STRICT, the ten-trigger WDBS/FTS machinery). Guards the one thing the
//! from-scratch tests can't: that init_db leaves such a database alone and every Kinesis operation
//! works on it, including under STRICT's type rules.

use rusqlite::Connection;
use std::collections::BTreeSet;

use super::{attachments, biography, custom_prompts, glossary, schema, search, settings, videos, wdbs};

const PRODUCTION_SCHEMA: &str = include_str!("production_schema.sql");

fn production_db(name: &str) -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("kinesis_production_{name}_{nanos}.db"));
    let path = path.to_string_lossy().to_string();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(PRODUCTION_SCHEMA).unwrap();
    // The production database always has the root Warp Drive node (a new video defaults to it).
    conn.execute("INSERT INTO tblWDBS (WDBS, lev, WDID, WDInfo) VALUES (':', 0, '', '')", []).unwrap();
    path
}

/// Every (type, name) in the schema apart from SQLite's own bookkeeping and FTS5's shadow tables.
fn schema_objects(path: &str) -> BTreeSet<(String, String)> {
    let conn = Connection::open(path).unwrap();
    let mut stmt = conn
        .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'ftsVideos_%'")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap().filter_map(|r| r.ok()).collect()
}

#[test]
fn init_db_leaves_the_production_schema_exactly_as_it_is() {
    let path = production_db("untouched");
    let before = schema_objects(&path);
    schema::init_db(&path).unwrap();
    schema::init_db(&path).unwrap();
    let after = schema_objects(&path);
    let added: Vec<_> = after.difference(&before).collect();
    let removed: Vec<_> = before.difference(&after).collect();
    assert!(added.is_empty(), "init_db added objects to the production schema: {added:?}");
    assert!(removed.is_empty(), "init_db removed objects from the production schema: {removed:?}");
    // The maintainer's names are the only spellings in play.
    for old in ["stop_words", "video_notes", "video_attachments", "attachment_blobs", "video_wdbs_links", "glossary_drives"] {
        assert!(!before.iter().any(|(_, n)| n == old), "{old}");
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn kinesis_works_end_to_end_on_the_production_schema() {
    let path = production_db("e2e");
    schema::init_db(&path).unwrap();

    // Defaults Kinesis seeds are stored under STRICT's rules without complaint.
    assert_eq!(settings::get_setting(&path, "showDrive").unwrap().as_deref(), Some("true"));
    settings::set_setting(&path, "theme", "dark").unwrap();
    assert_eq!(settings::get_setting(&path, "theme").unwrap().as_deref(), Some("dark"));
    let stop_words: i64 = Connection::open(&path).unwrap().query_row("SELECT COUNT(*) FROM StopWords", [], |r| r.get(0)).unwrap();
    assert!(stop_words > 100, "the default stop words are seeded into an empty StopWords");

    // A video and its channel.
    biography::upsert_biography_from_video(&path, "@creator", "The Creator", Some("UC123"), -1).unwrap();
    videos::save_video(&path, "vid1", "Freebird live", "The Creator", 240, "some words about a free bird and a lone star", 1000, "2024-05-01", "@creator", None).unwrap();
    // Saving a video that's already there updates it (the production insert trigger rules out an upsert).
    videos::save_video(&path, "vid1", "Freebird live", "The Creator", 240, "some words about a free bird and a lone star", 2000, "2024-05-01", "@creator", None).unwrap();
    let video = videos::get_video_by_id(&path, "vid1", true).unwrap().expect("saved");
    assert_eq!(video.title, "Freebird live");
    let (rows, views): (i64, i64) = Connection::open(&path).unwrap()
        .query_row("SELECT COUNT(*), MAX(view_count) FROM Videos", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((rows, views), (1, 2000));
    let tokens: String = Connection::open(&path).unwrap().query_row("SELECT tokens FROM Videos WHERE video_id='vid1'", [], |r| r.get(0)).unwrap();
    assert!(tokens.contains("freebird") || tokens.contains("bird"), "tokens generated: {tokens}");
    videos::save_tags(&path, "vid1", "music, live").unwrap();
    videos::save_transcript(&path, "vid1", "a rewritten transcript").unwrap();

    // Full-text search (through ftsVideos and the production triggers that feed it).
    let (found, total) = search::search_library_videos(&path, "Freebird", None, None, None, 10, 0).unwrap();
    assert_eq!((found.len(), total), (1, 1));

    // Warp Drive assignment: nodes are created first, then the production validation trigger accepts them.
    wdbs::ensure_wdbs_path_exists(&path, ":UAP-GERB").unwrap();
    wdbs::ensure_wdbs_path_exists(&path, ":FIN").unwrap();
    videos::update_video_wdbs(&path, "vid1", "θψUAP_GERB").unwrap();
    assert_eq!(wdbs::get_video_wdbs_primary(&path, "vid1").unwrap().as_deref(), Some("θψUAP_GERB"));
    wdbs::add_video_wdbs_link(&path, "vid1", "θψFIN").unwrap();
    assert_eq!(wdbs::get_video_wdbs_links(&path, "vid1").unwrap(), vec!["θψFIN".to_string()]);
    wdbs::set_wdbs_alias(&path, "θψUAP", "Unidentified").unwrap();
    assert!(!wdbs::get_wdbs_tree(&path).unwrap().is_empty());

    // Glossary with drives, custom prompts, biography edits.
    glossary::save_glossary_term(&path, None, "Halving", "Supply cut", ":FIN").unwrap();
    let entries = glossary::get_glossary_terms(&path).unwrap();
    assert_eq!(entries.iter().map(|e| (e.term.as_str(), e.drives.clone())).collect::<Vec<_>>(), vec![("Halving", vec![":FIN".to_string()])]);
    custom_prompts::set_custom_prompt(&path, "@creator", Some("local"), Some("cloud")).unwrap();
    assert_eq!(biography::get_biographies(&path).unwrap().len(), 1);

    // Notes and attachments live in the Kinesis-owned tables of the same database.
    attachments::set_note(&path, "vid1", "my note").unwrap();
    assert_eq!(attachments::get_note(&path, "vid1").unwrap(), "my note");
    attachments::add_attachment(&path, "vid1", "notes.txt", b"hello attachment".repeat(50)).unwrap();
    assert_eq!(attachments::list_attachments(&path, "vid1").unwrap().len(), 1);

    // Deleting the video cascades through the maintained triggers: links, note, attachments, blobs, bio.
    videos::delete_video(&path, "vid1").unwrap();
    let conn = Connection::open(&path).unwrap();
    let count = |table: &str| -> i64 { conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap() };
    for table in ["Videos", "VideoWDBSLinks", "VideoNotes", "VideoAttachments", "AttachmentBlobs", "Biographies"] {
        assert_eq!(count(table), 0, "{table} should be empty after the only video is deleted");
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_biography_without_a_channel_id_is_accepted_by_the_production_schema() {
    // The pack (or sync item) leaves channel_id out; production declares it NOT NULL with no default.
    let path = production_db("bio_no_channel");
    schema::init_db(&path).unwrap();
    let mut conn = Connection::open(&path).unwrap();
    let item = kinesis_sync_proto::Item {
        kind: "biography".into(),
        key: "@nochannel".into(),
        rev: Some(1),
        hash: String::new(),
        data: serde_json::json!({"display_name": "No Channel", "bio": "hi"}),
    };
    let stats = super::sync::apply_page(&mut conn, &[item], &[], false).unwrap();
    assert!(stats.errors.is_empty(), "{stats:?}");
    let channel: String = conn.query_row("SELECT channel_id FROM Biographies WHERE handle='@nochannel'", [], |r| r.get(0)).unwrap();
    assert_eq!(channel, "");
    drop(conn);
    let _ = std::fs::remove_file(&path);
}
