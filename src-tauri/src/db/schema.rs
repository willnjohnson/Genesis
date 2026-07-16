use rusqlite::{params, Connection, Result};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use super::biography::populate_biographies_from_videos;

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

    // FTS sync + biography-cascade triggers. CREATE TRIGGER IF NOT EXISTS is idempotent and
    // cheap (catalog lookup only, no data scan), so — like the FTS5 table create above — this
    // stays unconditional rather than gated behind `already_migrated`.
    //
    // TODO(one-time migration shim): the three DROPs below only exist to clean up the old
    // ftsVideos_* trigger names from installs created before the trg_ftsVideos_* rename. Once
    // we're confident no install still ships with those old names, delete these three lines
    // (the CREATE TRIGGER IF NOT EXISTS statements below are the permanent part and should stay).
    let _ = conn.execute("DROP TRIGGER IF EXISTS ftsVideos_insert", []);
    let _ = conn.execute("DROP TRIGGER IF EXISTS ftsVideos_delete", []);
    let _ = conn.execute("DROP TRIGGER IF EXISTS ftsVideos_update", []);

    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_ftsVideos_BeforeDEL
        BEFORE DELETE ON videos
        BEGIN
            INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens)
            VALUES ('delete', OLD.rowid, OLD.title, OLD.summary, OLD.tokens);
        END",
        [],
    );
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_ftsVideos_AfterDEL
        AFTER DELETE ON videos
        BEGIN
            DELETE FROM biographies
            WHERE lower(biographies.handle) = lower(OLD.handle)
            AND OLD.handle IS NOT NULL
            AND (SELECT COUNT(*) FROM videos
                 WHERE lower(videos.handle) = lower(OLD.handle)) = 0;
        END",
        [],
    );
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_ftsVideos_AfterINS
        AFTER INSERT ON videos
        BEGIN
            INSERT INTO ftsVideos(rowid, title, summary, tokens) VALUES (new.rowid, new.title, new.summary, new.tokens);
        END",
        [],
    );
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_ftsVideos_AfterUPD
        AFTER UPDATE ON videos
        BEGIN
            INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens) VALUES ('delete', old.rowid, old.title, old.summary, old.tokens);
            INSERT INTO ftsVideos(rowid, title, summary, tokens) VALUES (new.rowid, new.title, new.summary, new.tokens);
        END",
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

        // Migration: Populate biographies from existing video handles
        // Ensures channels that have been saved previously appear in the Biography view
        if let Err(e) = populate_biographies_from_videos(db_path) {
            log::warn!("Failed to populate biographies from videos: {}", e);
        }

        migrated_db_paths().lock().unwrap().insert(db_path.to_string());
    }

    Ok(())
}

pub fn vacuum_db(db_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("VACUUM", [])?;
    Ok(())
}

pub fn get_history_stats(db_path: &str) -> Result<i64> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM search_history")?;
    let count: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(count)
}
