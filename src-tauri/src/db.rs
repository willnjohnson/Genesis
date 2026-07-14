use crate::Video;
use regex::Regex;
use rusqlite::{params, Connection, Result};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

// init_db is called defensively from several commands (fetch_saved_videos, search_library) on
// every invocation, not just at app startup. Its schema-verification (CREATE TABLE IF NOT
// EXISTS, column-existence checks) is cheap and safe to redo every time, but the one-time data
// migrations below it (tokens backfill, trigger recreation, biography population) each do a
// full scan of `videos` — with thousands of rows this made every Library/library-search
// navigation pay for a full-table migration that only ever needed to run once. This tracks
// which db paths have already had that one-time work done this session.
fn migrated_db_paths() -> &'static Mutex<HashSet<String>> {
    static PATHS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

// Common English words culled from generated FTS tokens (videos.tokens). Words are stored with
// apostrophes stripped since the token-generation query strips punctuation before comparing
// against this list (e.g. "don't" -> "dont").
const DEFAULT_STOPWORDS: &[&str] = &[
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
    "arent", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
    "but", "by", "cant", "cannot", "could", "couldnt", "did", "didnt", "do", "does", "doesnt",
    "doing", "dont", "down", "during", "each", "few", "for", "from", "further", "had", "hadnt",
    "has", "hasnt", "have", "havent", "having", "he", "hed", "hell", "hes", "her", "here", "heres",
    "hers", "herself", "him", "himself", "his", "how", "hows", "i", "id", "ill", "im", "ive", "if",
    "in", "into", "is", "isnt", "it", "its", "itself", "lets", "me", "more", "most", "mustnt",
    "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "ought",
    "our", "ours", "ourselves", "out", "over", "own", "same", "shant", "she", "shed", "shell",
    "shes", "should", "shouldnt", "so", "some", "such", "than", "that", "thats", "the", "their",
    "theirs", "them", "themselves", "then", "there", "theres", "these", "they", "theyd", "theyll",
    "theyre", "theyve", "this", "those", "through", "to", "too", "under", "until", "up", "very",
    "was", "wasnt", "we", "wed", "well", "were", "werent", "weve", "what", "whats", "when", "whens",
    "where", "wheres", "which", "while", "who", "whos", "whom", "why", "whys", "with", "wont",
    "would", "wouldnt", "you", "youd", "youll", "youre", "youve", "your", "yours", "yourself",
    "yourselves",
];

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        params![table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn init_db(db_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    
    // Verify all required tables exist; if not, this is likely a corrupted/partial database
    let required_tables = ["videos", "settings", "glossary", "biographies", "search_history", "custom_prompts"];
    let mut missing_tables = Vec::new();
    
    for table in &required_tables {
        if !table_exists(&conn, table).unwrap_or(false) {
            missing_tables.push(*table);
        }
    }
    
    // If we're missing critical tables (not just videos), log a warning
    if !missing_tables.is_empty() {
        log::info!("Creating missing database tables: {:?}", missing_tables);
    }

    // Create videos table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS videos (
            video_id     TEXT PRIMARY KEY,
            title        TEXT,
            author       TEXT,
            handle       TEXT,
            length_seconds INTEGER,
            transcript   TEXT,
            summary      TEXT,
            view_count   INTEGER DEFAULT 0,
            video_type   TEXT DEFAULT 'standard',
            published_at DATETIME,
            date_added   DATETIME DEFAULT CURRENT_TIMESTAMP,
            tags         TEXT DEFAULT '',
            tokens       TEXT DEFAULT ''
        )",
        [],
    )?;

    // Migration: Add tags column if it doesn't exist (for existing databases)
    let has_tags: Result<i32> = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('videos') WHERE name='tags'",
        [],
        |row| row.get(0),
    );
    if has_tags.unwrap_or(0) == 0 {
        let _ = conn.execute("ALTER TABLE videos ADD COLUMN tags TEXT DEFAULT ''", []);
    }

    // Migration: Add tokens column if it doesn't exist (for existing databases)
    let has_tokens: Result<i32> = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('videos') WHERE name='tokens'",
        [],
        |row| row.get(0),
    );
    if has_tokens.unwrap_or(0) == 0 {
        let _ = conn.execute("ALTER TABLE videos ADD COLUMN tokens TEXT DEFAULT ''", []);
    }

    // Indexes backing the Library grid's sort/filter options. Without these, sorting a
    // several-thousand-row library by e.g. view count is a full table scan + temp-b-tree sort
    // on every query, even with a small LIMIT (verified via EXPLAIN QUERY PLAN). IF NOT EXISTS
    // makes repeat calls a fast no-op, so this is safe to run unconditionally.
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosDateAdded ON videos(date_added)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosPublishedAt ON videos(published_at)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosViewCount ON videos(view_count)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosVideoType ON videos(video_type)", []);

    // Create StopWords table: common words culled out of generated FTS tokens
    conn.execute(
        "CREATE TABLE IF NOT EXISTS StopWords (
            Culls TEXT PRIMARY KEY
        )",
        [],
    )?;

    let stopword_count: i64 = conn.query_row("SELECT COUNT(*) FROM StopWords", [], |row| row.get(0))?;
    if stopword_count == 0 {
        for word in DEFAULT_STOPWORDS {
            conn.execute("INSERT OR IGNORE INTO StopWords (Culls) VALUES (?1)", params![word])?;
        }
    }

    // Create settings table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        )",
        [],
    )?;

    // Create glossary table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS glossary (
            term TEXT PRIMARY KEY,
            definition TEXT NOT NULL
        )",
        [],
    )?;

    // Create biographies table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS biographies (
            handle TEXT PRIMARY KEY,
            display_name TEXT NOT NULL DEFAULT '',
            bio TEXT NOT NULL DEFAULT '',
            wikipedia TEXT NOT NULL DEFAULT '',
            website TEXT NOT NULL DEFAULT '',
            twitter TEXT NOT NULL DEFAULT '',
            instagram TEXT NOT NULL DEFAULT '',
            facebook TEXT NOT NULL DEFAULT '',
            threads TEXT NOT NULL DEFAULT '',
            youtube TEXT NOT NULL DEFAULT '',
            tiktok TEXT NOT NULL DEFAULT '',
            twitch TEXT NOT NULL DEFAULT '',
            reddit TEXT NOT NULL DEFAULT '',
            discord TEXT NOT NULL DEFAULT ''
        )",
        [],
    )?;

    // Migration: Add new biography columns if they don't exist
    let has_twitch: Result<i32> = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('biographies') WHERE name='twitch'",
        [],
        |row| row.get(0),
    );
    if has_twitch.unwrap_or(0) == 0 {
        let _ = conn.execute("ALTER TABLE biographies ADD COLUMN twitch TEXT NOT NULL DEFAULT ''", []);
    }

    let has_reddit: Result<i32> = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('biographies') WHERE name='reddit'",
        [],
        |row| row.get(0),
    );
    if has_reddit.unwrap_or(0) == 0 {
        let _ = conn.execute("ALTER TABLE biographies ADD COLUMN reddit TEXT NOT NULL DEFAULT ''", []);
    }

    let has_discord: Result<i32> = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('biographies') WHERE name='discord'",
        [],
        |row| row.get(0),
    );
    if has_discord.unwrap_or(0) == 0 {
        let _ = conn.execute("ALTER TABLE biographies ADD COLUMN discord TEXT NOT NULL DEFAULT ''", []);
    }

    // Create search_history table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS search_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            search_query TEXT NOT NULL,
            searched_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(search_query)
        )",
        [],
    )?;

    // Migration: Ensure settings table exists for old databases that might be missing it
    let table_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
        [],
        |row| row.get(0),
    )?;

    if table_count == 0 {
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )?;
    }

    // Create custom_prompts table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS custom_prompts (
            handle TEXT PRIMARY KEY,
            local_prompt_text TEXT,
            cloud_prompt_text TEXT
        )",
        [],
    )?;

    // Initialize default settings if they don't exist
    let defaults = [
        ("showSearch", "true"),
        ("allowDeletionLibrary", "true"),
        ("allowModificationGlossary", "true"),
        ("showSummarizeButton", "false"),
        ("showSummarizeOllama", "true"),
        ("showSummarizeVenice", "true"),
        ("showSynthesizeVenice", "true"),
        ("showSynthesizePixabay", "true"),
        ("showSynthesizeUpload", "true"),
        ("showGlossarySearchByTag", "true"),
        ("showGlossarySearchInLibrary", "true"),
        ("showBiography", "true"),
        ("allowEditBio", "true"),
        ("navigation_orientation", "horizontal"),
    ];

    for (key, val) in defaults.iter() {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            params![key, val],
        )?;
    }

    // Migration: Ensure search_history has the correct new schema (drop and recreate if it lacks search_query)
    if conn
        .query_row(
            "SELECT search_query FROM search_history LIMIT 1",
            [],
            |_| Ok(()),
        )
        .is_err()
    {
        let _ = conn.execute("DROP TABLE search_history", []);
        conn.execute(
            "CREATE TABLE IF NOT EXISTS search_history (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                search_query TEXT NOT NULL,
                searched_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(search_query)
            )",
            [],
        )?;
    }

    // Migration: Add missing columns or update column types for older database files
    // Use a robust check to ensure columns are exactly as expected
    let schema_ok = {
        let mut stmt = conn.prepare("PRAGMA table_info(videos)").unwrap();
        let mut rows = stmt.query([]).unwrap();
        let mut found_published_at_dt = false;
        while let Some(row) = rows.next().unwrap() {
            let name: String = row.get(1).unwrap();
            let type_str: String = row.get(2).unwrap();
            if name == "published_at" && type_str.to_uppercase() == "DATETIME" {
                found_published_at_dt = true;
            }
        }
        found_published_at_dt
    };

    if !schema_ok {
        // Check if table has published_at at all
        let has_col = conn
            .query_row(
                "SELECT name FROM pragma_table_info('videos') WHERE name='published_at'",
                [],
                |_| Ok(()),
            )
            .is_ok();

        if !has_col {
            // Simple expansion for very old DBs
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN handle TEXT", []);
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN length_seconds INTEGER", []);
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN summary TEXT", []);
            let _ = conn.execute(
                "ALTER TABLE videos ADD COLUMN view_count INTEGER DEFAULT 0",
                [],
            );
            let _ = conn.execute(
                "ALTER TABLE videos ADD COLUMN video_type TEXT DEFAULT 'standard'",
                [],
            );
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN published_at DATETIME", []);
            let _ = conn.execute(
                "ALTER TABLE videos ADD COLUMN date_added DATETIME DEFAULT CURRENT_TIMESTAMP",
                [],
            );
        } else {
            // Full migration needed to change TEXT to DATETIME
            let _ = conn.execute_batch(
                "
                BEGIN TRANSACTION;
                CREATE TABLE videos_new (
                    video_id     TEXT PRIMARY KEY,
                    title        TEXT,
                    author       TEXT,
                    handle       TEXT,
                    length_seconds INTEGER,
                    transcript   TEXT,
                    summary      TEXT,
                    view_count   INTEGER DEFAULT 0,
                    video_type   TEXT DEFAULT 'standard',
                    published_at DATETIME,
                    date_added   DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO videos_new (
                    video_id, title, author, handle, length_seconds, 
                    transcript, summary, view_count, video_type, 
                    published_at, date_added
                )
                SELECT 
                    video_id, title, author, 
                    COALESCE(handle, ''), 
                    COALESCE(length_seconds, 0), 
                    COALESCE(transcript, ''), 
                    COALESCE(summary, ''), 
                    COALESCE(view_count, 0), 
                    COALESCE(video_type, 'standard'), 
                    published_at, 
                    COALESCE(date_added, CURRENT_TIMESTAMP)
                FROM videos;
                DROP TABLE videos;
                ALTER TABLE videos_new RENAME TO videos;
                COMMIT;
            ",
            );
        }
    }

    // Create FTS5 virtual table for library video search — idempotent and cheap even when it
    // already exists, so this stays unconditional (unlike the migrations below).
    let _ = conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS ftsVideos USING fts5(title, summary, tokens, content='videos')",
        [],
    );

    // The rest of this function does one-time data migrations, each a full scan (or worse) over
    // `videos` — safe to skip after the first successful run this session for this db_path.
    let already_migrated = migrated_db_paths().lock().unwrap().contains(db_path);
    if !already_migrated {
        // Migration: Populate tokens for existing videos that may not have them
        let _ = conn.execute(
            "UPDATE videos SET tokens = COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(transcript, '') WHERE tokens IS NULL OR tokens = ''",
            [],
        );

        let _ = conn.execute("DROP TRIGGER IF EXISTS ftsVideos_insert", []);
        let _ = conn.execute("DROP TRIGGER IF EXISTS ftsVideos_delete", []);
        let _ = conn.execute("DROP TRIGGER IF EXISTS ftsVideos_update", []);

        let _ = conn.execute(
            "CREATE TRIGGER ftsVideos_insert AFTER INSERT ON videos BEGIN
                INSERT INTO ftsVideos(rowid, title, summary, tokens) VALUES (new.rowid, new.title, new.summary, new.tokens);
            END",
            [],
        );
        let _ = conn.execute(
            "CREATE TRIGGER ftsVideos_delete AFTER DELETE ON videos BEGIN
                INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens) VALUES ('delete', old.rowid, old.title, old.summary, old.tokens);
            END",
            [],
        );
        let _ = conn.execute(
            "CREATE TRIGGER ftsVideos_update AFTER UPDATE ON videos BEGIN
                INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens) VALUES ('delete', old.rowid, old.title, old.summary, old.tokens);
                INSERT INTO ftsVideos(rowid, title, summary, tokens) VALUES (new.rowid, new.title, new.summary, new.tokens);
            END",
            [],
        );

        // Migration: Populate biographies from existing video handles
        // Ensures channels that have been saved previously appear in the Biography view
        if let Err(e) = populate_biographies_from_videos(db_path) {
            log::warn!("Failed to populate biographies from videos: {}", e);
        }

        migrated_db_paths().lock().unwrap().insert(db_path.to_string());
    }

    Ok(())
}

pub fn list_videos(
    db_path: &str,
    video_type_filter: Option<&str>,
    include_content: bool,
) -> Result<Vec<Video>> {
    let conn = Connection::open(db_path)?;

    let query = match video_type_filter {
        Some("short") => "SELECT video_id, title, author, length_seconds, view_count, published_at, date_added, handle, video_type, transcript, tags, summary, CASE WHEN transcript IS NOT NULL AND transcript != '' THEN 1 ELSE 0 END AS has_transcript, CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END AS has_summary FROM videos WHERE video_type = 'short' ORDER BY date_added DESC, rowid DESC",
        Some("standard") => "SELECT video_id, title, author, length_seconds, view_count, published_at, date_added, handle, video_type, transcript, tags, summary, CASE WHEN transcript IS NOT NULL AND transcript != '' THEN 1 ELSE 0 END AS has_transcript, CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END AS has_summary FROM videos WHERE video_type = 'standard' ORDER BY date_added DESC, rowid DESC",
        _ => "SELECT video_id, title, author, length_seconds, view_count, published_at, date_added, handle, video_type, transcript, tags, summary, CASE WHEN transcript IS NOT NULL AND transcript != '' THEN 1 ELSE 0 END AS has_transcript, CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END AS has_summary FROM videos ORDER BY date_added DESC, rowid DESC",
    };

    let mut stmt = conn.prepare(query)?;
    let video_iter = stmt.query_map([], |row| {
        let view_count_str = match row.get::<_, Option<i64>>(4) {
            Ok(Some(0)) | Ok(None) => "Saved".to_string(),
            Ok(Some(n)) => n.to_string(),
            Err(_) => match row.get::<_, Option<String>>(4) {
                Ok(Some(ref s)) if s == "0" => "Saved".to_string(),
                Ok(Some(s)) => s,
                _ => "Saved".to_string(),
            },
        };
        let raw_summary: Option<String> = row.get(11).unwrap_or(None);
        Ok(Video {
            id: row.get::<_, String>(0).unwrap_or_default(),
            title: row
                .get::<_, Option<String>>(1)
                .unwrap_or(None)
                .unwrap_or_else(|| "Unknown".to_string()),
            author: row.get::<_, Option<String>>(2).unwrap_or(None),
            length_seconds: match row.get::<_, Option<i32>>(3) {
                Ok(v) => v,
                Err(_) => row
                    .get::<_, Option<String>>(3)
                    .unwrap_or(None)
                    .and_then(|s| s.parse().ok()),
            },
            view_count: view_count_str,
            thumbnail: format!(
                "https://i.ytimg.com/vi/{}/hqdefault.jpg",
                row.get::<_, String>(0).unwrap_or_default()
            ),
            published_at: row
                .get::<_, Option<String>>(5)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
            status: Some("saved".to_string()),
            date_added: row.get::<_, Option<String>>(6).unwrap_or(None),
            handle: row.get::<_, Option<String>>(7).unwrap_or(None),
            video_type: row.get::<_, Option<String>>(8).unwrap_or(None),
            transcript: if include_content {
                row.get::<_, Option<String>>(9).unwrap_or(None)
            } else {
                None
            },
            tags: row.get::<_, Option<String>>(10).unwrap_or(None),
            summary: if include_content { raw_summary.clone() } else { None },
            has_transcript: Some(row.get::<_, i64>(12).unwrap_or(0) > 0),
            has_summary: Some(raw_summary.as_deref().map(has_real_summary).unwrap_or(false)),
        })
    })?;

    let mut videos = Vec::new();
    for video in video_iter {
        videos.push(video?);
    }
    Ok(videos)
}

// True if `summary` has real AI-generated content beyond the auto-appended "Channel Info: ..."
// footer (see append_channel_info_footer) — the footer alone must never be mistaken for an
// existing AI summary, since that would hide the "Summarize" action and skip the video in
// bulk-summarize runs.
pub fn has_real_summary(summary: &str) -> bool {
    let content = match summary.find("Channel Info:") {
        Some(idx) => &summary[..idx],
        None => summary,
    };
    !content.trim().is_empty()
}

// Appends a "Channel Info: ..." footer to a video's summary (feeding the ftsVideos.summary
// FTS5 column), always at the very bottom. Guarded so repeated saves/refetches/re-summarizes
// of the same video don't duplicate it. Prefers the channel's biography display_name, but
// falls back to the video's own `author` field so this doesn't depend on a biographies row
// having been created yet (that row is only upserted lazily, e.g. from the video-save flow,
// and can be missing entirely for videos saved before that ran or via other paths).
fn append_channel_info_footer(conn: &Connection, video_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE videos AS a
         SET summary = IFNULL(a.summary, '') || (char(10) || char(10) || 'Channel Info: ' || src.name)
         FROM (
             SELECT v.video_id AS vid, COALESCE(NULLIF(TRIM(b.display_name), ''), v.author) AS name
             FROM videos v
             LEFT JOIN biographies b ON b.handle = v.handle
             WHERE v.video_id = ?1
         ) AS src
         WHERE a.video_id = src.vid
           AND src.name IS NOT NULL AND src.name NOT IN ('', 'Unknown')
           AND (a.summary IS NULL OR a.summary NOT LIKE '%Channel Info:%')",
        params![video_id],
    )?;
    Ok(())
}

pub fn save_video(
    db_path: &str,
    video_id: &str,
    title: &str,
    author: &str,
    length: i32,
    transcript: &str,
    view_count: i64,
    published_at: &str,
    handle: &str,
    video_type: &str,
    summary: Option<&str>,
) -> Result<()> {
    let video_id = video_id.trim();
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT INTO videos (video_id, title, author, length_seconds, transcript, view_count, published_at, handle, video_type, summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(video_id) DO UPDATE SET
            title=excluded.title,
            author=excluded.author,
            length_seconds=excluded.length_seconds,
            transcript=excluded.transcript,
            view_count=excluded.view_count,
            published_at=excluded.published_at,
            handle=excluded.handle,
            video_type=excluded.video_type,
            summary=COALESCE(excluded.summary, videos.summary)",
        params![video_id, title, author, length, transcript, view_count, published_at, handle, video_type, summary],
    )?;
    regenerate_tokens_from_transcript(&conn, video_id)?;
    // Covers the "summarize before saving" workflow: a real summary can already be provided
    // at insert time, so it needs the same quote-marker cleanup applied on later saves.
    clean_blockquote_lines(&conn, video_id)?;
    append_channel_info_footer(&conn, video_id)?;
    if summary.map(has_real_summary).unwrap_or(false) {
        clear_transcript_after_summary(&conn, video_id)?;
    }
    Ok(())
}

pub fn delete_video(db_path: &str, video_id: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM videos WHERE video_id = ?", params![video_id])?;
    Ok(())
}

pub fn check_video_exists(db_path: &str, video_id: &str) -> Result<bool> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT 1 FROM videos WHERE video_id = ?")?;
    let mut rows = stmt.query(params![video_id])?;
    Ok(rows.next()?.is_some())
}

pub fn get_transcript(db_path: &str, video_id: &str) -> Result<Option<String>> {
    let video_id = video_id.trim();
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT transcript FROM videos WHERE video_id = ?")?;
    let mut rows = stmt.query(params![video_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn get_video_full(
    db_path: &str,
    video_id: &str,
) -> Result<
    Option<(
        String,
        String,
        String,
        i32,
        String,
        i64,
        String,
        String,
        String,
        String,
        String,
        String,
    )>,
> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT video_id, title, author, length_seconds, transcript, view_count, published_at, handle, video_type, date_added, summary, tags FROM videos WHERE video_id = ?")?;
    let mut rows = stmt.query(params![video_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, Option<String>>(1)
                .unwrap_or(None)
                .unwrap_or_else(|| "Unknown".to_string()),
            row.get::<_, Option<String>>(2)
                .unwrap_or(None)
                .unwrap_or_else(|| "Unknown".to_string()),
            match row.get::<_, Option<i32>>(3) {
                Ok(Some(v)) => v,
                Err(_) => row
                    .get::<_, Option<String>>(3)
                    .unwrap_or(None)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                _ => 0,
            },
            row.get::<_, Option<String>>(4)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
            match row.get::<_, Option<i64>>(5) {
                Ok(Some(n)) => n,
                Err(_) => match row.get::<_, Option<String>>(5) {
                    Ok(Some(s)) => s.parse::<i64>().unwrap_or(0),
                    _ => 0,
                },
                _ => 0,
            },
            row.get::<_, Option<String>>(6)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<String>>(7)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<String>>(8)
                .unwrap_or(None)
                .unwrap_or_else(|| "standard".to_string()),
            row.get::<_, Option<String>>(9)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<String>>(10)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<String>>(11)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
        )))
    } else {
        Ok(None)
    }
}

pub fn vacuum_db(db_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("VACUUM", [])?;
    Ok(())
}

pub fn get_setting(db_path: &str, key: &str) -> Result<Option<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_setting(db_path: &str, key: &str, value: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value)
         VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete_setting(db_path: &str, key: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM settings WHERE key = ?", params![key])?;
    Ok(())
}

pub fn get_db_stats(db_path: &str) -> Result<i64> {
    get_video_count(db_path, None, None)
}

pub fn get_video_count(
    db_path: &str,
    video_type_filter: Option<&str>,
    search_query: Option<&str>,
) -> Result<i64> {
    let conn = Connection::open(db_path)?;

    let video_type_where = match video_type_filter {
        Some("short") => "video_type = 'short'",
        Some("standard") => "video_type = 'standard'",
        _ => "1=1",
    };

    let search_where = match search_query {
        Some(q) if !q.is_empty() => {
            let escaped = q.replace('\'', "''");
            format!(
                " AND (title LIKE '%{}%' OR author LIKE '%{}%' OR handle LIKE '%{}%' OR transcript LIKE '%{}%')",
                escaped, escaped, escaped, escaped
            )
        }
        _ => String::new(),
    };

    let query = format!(
        "SELECT COUNT(*) FROM videos WHERE {} {}",
        video_type_where, search_where
    );

    let mut stmt = conn.prepare(&query)?;
    let count: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(count)
}

fn video_row(row: &rusqlite::Row) -> rusqlite::Result<Video> {
    let view_count_str = match row.get::<_, Option<i64>>(6) {
        Ok(Some(0)) | Ok(None) => "Saved".to_string(),
        Ok(Some(n)) => n.to_string(),
        Err(_) => match row.get::<_, Option<String>>(6) {
            Ok(Some(ref s)) if s == "0" => "Saved".to_string(),
            Ok(Some(s)) => s,
            _ => "Saved".to_string(),
        },
    };
    let raw_summary: Option<String> = row.get(11).unwrap_or(None);
    Ok(Video {
        id: row.get::<_, String>(0).unwrap_or_default(),
        title: row.get::<_, Option<String>>(1).unwrap_or(None).unwrap_or_else(|| "Unknown".to_string()),
        author: row.get::<_, Option<String>>(2).unwrap_or(None),
        length_seconds: match row.get::<_, Option<i32>>(4) {
            Ok(v) => v,
            Err(_) => row.get::<_, Option<String>>(4).unwrap_or(None).and_then(|s| s.parse().ok()),
        },
        view_count: view_count_str,
        thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", row.get::<_, String>(0).unwrap_or_default()),
        published_at: row.get::<_, Option<String>>(7).unwrap_or(None).unwrap_or_else(|| "".to_string()),
        status: Some("saved".to_string()),
        date_added: row.get::<_, Option<String>>(9).unwrap_or(None),
        handle: row.get::<_, Option<String>>(3).unwrap_or(None),
        video_type: row.get::<_, Option<String>>(8).unwrap_or(None),
        transcript: Some(row.get::<_, Option<String>>(5).unwrap_or(None).unwrap_or_else(|| "".to_string())),
        tags: row.get::<_, Option<String>>(10).unwrap_or(None),
        summary: Some(raw_summary.clone().unwrap_or_else(|| "".to_string())),
        has_transcript: Some(row.get::<_, i64>(12).unwrap_or(0) > 0),
        has_summary: Some(raw_summary.as_deref().map(has_real_summary).unwrap_or(false)),
    })
}

pub fn search_library_videos(
    db_path: &str,
    query: &str,
    video_type_filter: Option<&str>,
) -> Result<Vec<Video>> {
    let conn = Connection::open(db_path)?;

    let facet_re = Regex::new(r#"([a-z_]+):(?:"([^"]*)"|([^ ]*))"#).unwrap();
    let mut handle_val = "";
    let mut video_val = "";
    let mut tag_val = "";
    let mut remaining = query.to_string();

    for cap in facet_re.captures_iter(query) {
        let facet_type = &cap[1];
        let value = cap.get(2).map(|m| m.as_str()).unwrap_or_else(|| cap.get(3).map(|m| m.as_str()).unwrap_or(""));
        match facet_type {
            "handle" => handle_val = value,
            "video" => video_val = value,
            "tag_search" => tag_val = value,
            _ => {}
        }
        remaining = remaining.replace(&cap[0], "");
    }

    let free_text = remaining.trim();

    let video_type_where = match video_type_filter {
        Some("short") => "v.video_type = 'short'",
        Some("standard") => "v.video_type = 'standard'",
        _ => "1=1",
    };

    let columns = "v.video_id, v.title, v.author, v.handle, v.length_seconds, v.transcript, v.view_count, v.published_at, v.video_type, v.date_added, v.tags, v.summary,
                CASE WHEN v.transcript IS NOT NULL AND v.transcript != '' THEN 1 ELSE 0 END AS has_transcript,
                CASE WHEN v.summary IS NOT NULL AND v.summary != '' THEN 1 ELSE 0 END AS has_summary";

    let mut videos = Vec::new();

    if free_text.is_empty() {
        // No free-text search term (e.g. a bare handle:/video:/tag_search: facet) — skip the
        // FTS5 MATCH entirely rather than passing it an empty/wildcard query, which FTS5
        // rejects as a syntax error and would otherwise fail the whole search.
        let sql = format!(
            "SELECT {columns}
             FROM videos AS v
             WHERE (?1 = '' OR v.handle LIKE ?2)
               AND (?3 = '' OR v.video_id LIKE ?4)
               AND (?5 = '' OR v.tags LIKE ?6)
               AND {video_type_where}
             ORDER BY v.date_added DESC, v.rowid DESC
             LIMIT 10240"
        );
        let mut stmt = conn.prepare(&sql)?;
        let video_iter = stmt.query_map(
            params![
                handle_val,
                format!("%{}%", handle_val),
                video_val,
                format!("%{}%", video_val),
                tag_val,
                format!("%{}%", tag_val)
            ],
            video_row,
        )?;
        for video in video_iter {
            videos.push(video?);
        }
    } else {
        let fts_query = free_text
            .split_whitespace()
            .map(|w| {
                if w.chars().any(|c| matches!(c, '"' | '*' | '(' | ')' | '-' | '+' | '~' | ' ')) {
                    format!("\"{}\"*", w.replace('"', "\"\""))
                } else {
                    format!("{}*", w)
                }
            })
            .collect::<Vec<_>>()
            .join(" ");

        let sql = format!(
            "SELECT {columns}
             FROM videos AS v
             JOIN ftsVideos ON v.rowid = ftsVideos.rowid
             WHERE ftsVideos MATCH ?1
               AND (?2 = '' OR v.handle LIKE ?3)
               AND (?4 = '' OR v.video_id LIKE ?5)
               AND (?6 = '' OR v.tags LIKE ?7)
               AND {video_type_where}
             ORDER BY bm25(ftsVideos, 8.0, 10.0, 1.0)
             LIMIT 10240"
        );
        let mut stmt = conn.prepare(&sql)?;
        let video_iter = stmt.query_map(
            params![
                fts_query,
                handle_val,
                format!("%{}%", handle_val),
                video_val,
                format!("%{}%", video_val),
                tag_val,
                format!("%{}%", tag_val)
            ],
            video_row,
        )?;
        for video in video_iter {
            videos.push(video?);
        }
    }

    Ok(videos)
}

// Rebuilds videos.tokens for one video from its transcript: splits into words, strips
// punctuation, lowercases, dedupes, and drops common stop words, producing a compact
// space-separated term list for the FTS5 `tokens` column (bm25 weight 1.0).
fn regenerate_tokens_from_transcript(conn: &Connection, video_id: &str) -> Result<()> {
    conn.execute(
        "WITH
        digits AS (
            SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL
            SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9
        ),
        nums AS (
            SELECT d1.n * 10000 + d2.n * 1000 + d3.n * 100 + d4.n * 10 + d5.n AS n
            FROM digits d1, digits d2, digits d3, digits d4, digits d5
            WHERE d1.n * 10000 + d2.n * 1000 + d3.n * 100 + d4.n * 10 + d5.n BETWEEN 1 AND 50000
        ),
        normalized AS MATERIALIZED (
            SELECT video_id, ' ' || TRIM(
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                        REPLACE(COALESCE(transcript, ''),
                    CHAR(10), ' '), CHAR(13), ' '), CHAR(9), ' '),
                '  ', ' '), '  ', ' '), '  ', ' '),
            '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')
            ) || ' ' AS txt
            FROM videos
            WHERE transcript IS NOT NULL AND transcript != 'N/A'
            AND video_id = ?1
        ),
        word_starts AS (
            SELECT video_id, SUBSTR(txt, n + 1, INSTR(SUBSTR(txt, n + 1), ' ') - 1) AS word
            FROM normalized
            JOIN nums ON nums.n < LENGTH(normalized.txt)
            WHERE SUBSTR(txt, n, 1) = ' ' AND SUBSTR(txt, n + 1, 1) != ' '
        ),
        cleaned AS (
            SELECT video_id, LOWER(
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                        REPLACE(word
                    , '.', ''), ',', ''), '!', ''), '?', ''), ';', '')
                , ':', ''), '\"', ''), '''', ''), '-', ''), '(', '')
                , ')', '')
            ) AS word
            FROM word_starts
            WHERE word != ''
        ),
        unique_terms AS (
            SELECT DISTINCT video_id, word
            FROM cleaned
            WHERE LENGTH(word) > 0
            AND word NOT IN (SELECT Culls FROM StopWords)
        ),
        video_tokens AS (
            SELECT video_id, GROUP_CONCAT(word, ' ') AS tokens
            FROM (
                SELECT video_id, word
                FROM unique_terms
                ORDER BY video_ID
            )
            GROUP BY video_id
        )
        UPDATE videos
        SET tokens = video_tokens.tokens
        FROM video_tokens
        WHERE videos.video_id = video_tokens.video_id",
        params![video_id],
    )?;
    Ok(())
}

pub fn save_transcript(db_path: &str, video_id: &str, transcript: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE videos SET transcript = ?1 WHERE video_id = ?2",
        params![transcript, video_id],
    )?;
    regenerate_tokens_from_transcript(&conn, video_id)?;
    Ok(())
}

pub fn get_history_stats(db_path: &str) -> Result<i64> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM search_history")?;
    let count: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(count)
}

pub fn save_summary(db_path: &str, video_id: &str, summary: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    // Prepend the new summary above any existing "Channel Info:" footer, keeping that footer
    // pinned at the very bottom instead of letting it get overwritten or duplicated.
    conn.execute(
        "UPDATE videos
         SET summary = ?1 || CASE
             WHEN summary LIKE '%Channel Info:%' THEN char(10) || char(10) || substr(summary, instr(summary, 'Channel Info:'))
             ELSE ''
         END
         WHERE video_id = ?2",
        params![summary, video_id],
    )?;
    // Some providers (e.g. Venice.ai) emit markdown blockquote lines with stray embedded
    // quote marks (`> "like this," he said`); strip quotes from just those lines.
    clean_blockquote_lines(&conn, video_id)?;
    // Retry the footer append here too: a video can be (re-)summarized before its channel's
    // biography row exists yet, in which case save_video's earlier attempt was a no-op.
    append_channel_info_footer(&conn, video_id)?;
    if has_real_summary(summary) {
        clear_transcript_after_summary(&conn, video_id)?;
    }
    Ok(())
}

// Strips embedded `"` quote marks from any line of `summary` that starts with a markdown
// blockquote marker (`>`), leaving all other lines untouched. Splits on newlines via a
// recursive CTE (rowid-scoped to this one video), reassembles, and only writes back if the
// result actually differs from what's stored.
fn clean_blockquote_lines(conn: &Connection, video_id: &str) -> Result<()> {
    conn.execute(
        "WITH RECURSIVE
        lines(rid, seq, line, rest) AS (
            SELECT rowid, 1,
                CASE WHEN instr(summary, char(10)) > 0
                     THEN substr(summary, 1, instr(summary, char(10)) - 1)
                     ELSE summary
                END,
                CASE WHEN instr(summary, char(10)) > 0
                     THEN substr(summary, instr(summary, char(10)) + 1)
                     ELSE ''
                END
            FROM videos
            WHERE video_id = ?1
            AND summary IS NOT NULL AND summary != ''
            UNION ALL
            SELECT rid, seq + 1,
                CASE WHEN instr(rest, char(10)) > 0
                     THEN substr(rest, 1, instr(rest, char(10)) - 1)
                     ELSE rest
                END,
                CASE WHEN instr(rest, char(10)) > 0
                     THEN substr(rest, instr(rest, char(10)) + 1)
                     ELSE ''
                END
            FROM lines WHERE rest != ''
        ),
        processed AS (
            SELECT rid, seq,
                CASE
                    WHEN substr(line, 1, 1) = '>'
                    THEN REPLACE(line, '\"', '')
                    ELSE line
                END AS pline
            FROM lines
        ),
        new_summaries AS (
            SELECT rid, group_concat(pline, char(10) ORDER BY seq) AS new_summary
            FROM processed
            WHERE rid IN (
                SELECT DISTINCT rid FROM lines
                WHERE substr(line, 1, 1) = '>'
            )
            GROUP BY rid

            UNION ALL

            SELECT rid, group_concat(pline, char(10) ORDER BY seq) AS new_summary
            FROM processed
            WHERE rid NOT IN (
                SELECT DISTINCT rid FROM lines
                WHERE substr(line, 1, 1) = '>'
            )
            GROUP BY rid
        )
        UPDATE videos
        SET summary = (SELECT new_summary FROM new_summaries WHERE rid = videos.rowid)
        WHERE rowid IN (
            SELECT rid FROM new_summaries
            WHERE new_summary != (SELECT summary FROM videos WHERE rowid = new_summaries.rid)
        )",
        params![video_id],
    )?;
    Ok(())
}

// Frees the now-redundant transcript text once a real AI summary exists for a video: tokens
// were already derived from the transcript (at save_transcript/save_video time), and the
// summary + tokens are what's needed for search going forward, so the (often huge) transcript
// blob is just dead weight in the DB from here on. "." is a sentinel, not a genuinely empty
// value: regenerate_tokens_from_transcript explicitly skips rows where transcript = 'N/A' (so it
// won't wipe the tokens this transcript already produced), and save_transcript treats an empty
// transcript submission as a request to re-pull from YouTube, so a user can restore it later
// (e.g. to regenerate the summary) by clearing the "." in the transcript editor and saving.
fn clear_transcript_after_summary(conn: &Connection, video_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE videos SET transcript = 'N/A' WHERE video_id = ?1",
        params![video_id],
    )?;
    Ok(())
}

pub fn save_tags(db_path: &str, video_id: &str, tags: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE videos SET tags = ?1 WHERE video_id = ?2",
        params![tags, video_id],
    )?;
    Ok(())
}

pub fn get_summary(db_path: &str, video_id: &str) -> Result<Option<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT summary FROM videos WHERE video_id = ?")?;
    let mut rows = stmt.query(params![video_id])?;
    if let Some(row) = rows.next()? {
        let summary: Option<String> = row.get(0)?;
        // A summary consisting only of the "Channel Info:" footer isn't a real AI summary yet.
        Ok(summary.filter(|s| has_real_summary(s)))
    } else {
        Ok(None)
    }
}

pub fn get_summarized_count(db_path: &str) -> Result<i64> {
    let conn = Connection::open(db_path)?;
    let mut stmt =
        conn.prepare("SELECT summary FROM videos WHERE summary IS NOT NULL AND summary != ''")?;
    let mut rows = stmt.query([])?;
    let mut count = 0i64;
    while let Some(row) = rows.next()? {
        let summary: Option<String> = row.get(0)?;
        if summary.as_deref().map(has_real_summary).unwrap_or(false) {
            count += 1;
        }
    }
    Ok(count)
}

pub fn get_videos_with_summaries(db_path: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt =
        conn.prepare("SELECT video_id, summary FROM videos WHERE summary IS NOT NULL AND summary != ''")?;
    let mut rows = stmt.query([])?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        let summary: Option<String> = row.get(1)?;
        if summary.as_deref().map(has_real_summary).unwrap_or(false) {
            ids.push(row.get(0)?);
        }
    }
    Ok(ids)
}

pub fn add_glossary_term(db_path: &str, term: &str, definition: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT INTO glossary (term, definition) VALUES (?1, ?2) ON CONFLICT(term) DO UPDATE SET definition=excluded.definition",
        params![term, definition],
    )?;
    Ok(())
}

pub fn get_glossary_terms(db_path: &str) -> Result<Vec<(String, String)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt =
        conn.prepare("SELECT term, definition FROM glossary ORDER BY term COLLATE NOCASE")?;
    let mut rows = stmt.query([])?;
    let mut terms = Vec::new();
    while let Some(row) = rows.next()? {
        terms.push((row.get(0)?, row.get(1)?));
    }
    Ok(terms)
}

pub fn delete_glossary_term(db_path: &str, term: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM glossary WHERE term = ?", params![term])?;
    Ok(())
}

pub type BiographyRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
);

pub fn upsert_biography_from_video(db_path: &str, handle: &str, display_name: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    let cleaned_handle = handle.trim();
    if cleaned_handle.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO biographies (handle, display_name)
         VALUES (?1, ?2)
         ON CONFLICT(handle) DO UPDATE SET
           display_name = CASE
             WHEN biographies.display_name IS NULL OR TRIM(biographies.display_name) = ''
             THEN excluded.display_name
             ELSE biographies.display_name
           END",
        params![cleaned_handle, display_name.trim()],
    )?;
    Ok(())
}

pub fn get_biographies(db_path: &str) -> Result<Vec<BiographyRow>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT handle, display_name, bio, wikipedia, website, twitter, instagram, facebook, threads, youtube, tiktok, twitch, reddit, discord
         FROM biographies
         ORDER BY
           CASE WHEN TRIM(display_name) = '' THEN handle ELSE display_name END COLLATE NOCASE",
    )?;
    let mut rows = stmt.query([])?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        entries.push((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
            row.get(10)?,
            row.get(11)?,
            row.get(12)?,
            row.get(13)?,
        ));
    }
    Ok(entries)
}

pub fn get_biography_by_handle(db_path: &str, handle: &str) -> Result<Option<BiographyRow>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT handle, display_name, bio, wikipedia, website, twitter, instagram, facebook, threads, youtube, tiktok, twitch, reddit, discord
         FROM biographies
         WHERE LOWER(handle) = LOWER(?)",
    )?;
    let mut rows = stmt.query(params![handle.trim()])?;
    if let Some(row) = rows.next()? {
        Ok(Some((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
            row.get(10)?,
            row.get(11)?,
            row.get(12)?,
            row.get(13)?,
        )))
    } else {
        Ok(None)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn update_biography_details(
    db_path: &str,
    handle: &str,
    bio: &str,
    wikipedia: &str,
    website: &str,
    twitter: &str,
    instagram: &str,
    facebook: &str,
    threads: &str,
    youtube: &str,
    tiktok: &str,
    twitch: &str,
    reddit: &str,
    discord: &str,
) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE biographies
         SET bio = ?2,
             wikipedia = ?3,
             website = ?4,
             twitter = ?5,
             instagram = ?6,
             facebook = ?7,
             threads = ?8,
             youtube = ?9,
             tiktok = ?10,
             twitch = ?11,
             reddit = ?12,
             discord = ?13
         WHERE LOWER(handle) = LOWER(?1)",
        params![
            handle.trim(),
            bio,
            wikipedia,
            website,
            twitter,
            instagram,
            facebook,
            threads,
            youtube,
            tiktok,
            twitch,
            reddit,
            discord
        ],
    )?;
    Ok(())
}

pub fn get_custom_prompt(
    db_path: &str,
    handle: &str,
) -> Result<Option<(Option<String>, Option<String>)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT local_prompt_text, cloud_prompt_text FROM custom_prompts WHERE LOWER(handle) = LOWER(?)",
    )?;
    let mut rows = stmt.query(params![handle])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?)))
    } else {
        Ok(None)
    }
}

pub fn get_all_custom_prompts(
    db_path: &str,
) -> Result<Vec<(String, Option<String>, Option<String>)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT handle, local_prompt_text, cloud_prompt_text FROM custom_prompts ORDER BY handle COLLATE NOCASE")?;
    let mut rows = stmt.query([])?;
    let mut prompts = Vec::new();
    while let Some(row) = rows.next()? {
        prompts.push((row.get(0)?, row.get(1)?, row.get(2)?));
    }
    Ok(prompts)
}

pub fn set_custom_prompt(
    db_path: &str,
    handle: &str,
    local_prompt_text: Option<&str>,
    cloud_prompt_text: Option<&str>,
) -> Result<()> {
    let conn = Connection::open(db_path)?;
    let normalized_handle = handle.to_lowercase();

    // Check if exists (case-insensitive)
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM custom_prompts WHERE LOWER(handle) = LOWER(?)",
        params![normalized_handle],
        |row| Ok(row.get::<_, i32>(0)? > 0),
    )?;

    if exists {
        conn.execute(
            "UPDATE custom_prompts SET local_prompt_text = ?2, cloud_prompt_text = ?3 WHERE LOWER(handle) = LOWER(?1)",
            params![normalized_handle, local_prompt_text, cloud_prompt_text],
        )?;
    } else {
        conn.execute(
            "INSERT INTO custom_prompts (handle, local_prompt_text, cloud_prompt_text) VALUES (?1, ?2, ?3)",
            params![normalized_handle, local_prompt_text, cloud_prompt_text],
        )?;
    }
    Ok(())
}

pub fn delete_custom_prompt(db_path: &str, handle: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "DELETE FROM custom_prompts WHERE LOWER(handle) = LOWER(?)",
        params![handle],
    )?;
    Ok(())
}

pub fn get_unique_handles(db_path: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT DISTINCT handle FROM videos WHERE handle IS NOT NULL AND handle != '' ORDER BY handle")?;
    let handles = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(handles)
}

/// Populate biographies table from existing video handles.
/// For each distinct handle in the videos table:
/// - If no biography entry exists, create one with the author as display_name
/// - If biography entry exists but display_name is empty, update it with author
pub fn populate_biographies_from_videos(db_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    
    // Get distinct handles with their corresponding author (use MIN for deterministic choice)
    let mut stmt = conn.prepare(
        "SELECT handle, MIN(author) as author
         FROM videos
         WHERE handle IS NOT NULL AND handle != ''
         GROUP BY handle"
    )?;
    let rows: Vec<(String, Option<String>)> = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
        ))
    })?.filter_map(|r| r.ok()).collect();

    // One transaction for the whole batch instead of an autocommit round trip per handle.
    let tx = conn.unchecked_transaction()?;
    let mut count = 0;
    for (handle, author_opt) in rows {
        let display_name = author_opt.unwrap_or_else(|| "".to_string());

        // Use upsert that preserves existing non-empty display_name
        tx.execute(
            "INSERT INTO biographies (handle, display_name)
             VALUES (?1, ?2)
             ON CONFLICT(handle) DO UPDATE SET
               display_name = CASE
                 WHEN TRIM(biographies.display_name) = ''
                 THEN excluded.display_name
                 ELSE biographies.display_name
               END",
            params![handle, display_name],
        )?;
        count += 1;
    }
    tx.commit()?;

    log::info!("Populated {} biography entries from existing videos", count);
    Ok(())
}
