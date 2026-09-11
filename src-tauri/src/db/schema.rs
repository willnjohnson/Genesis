use rusqlite::{params, Connection, Result};

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

pub(crate) fn table_exists(conn: &Connection, table_name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        params![table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

// Used to idempotently ALTER TABLE ... ADD COLUMN for columns introduced after a database was
// first created — SQLite has no "ADD COLUMN IF NOT EXISTS", so callers check this first.
fn column_exists(conn: &Connection, table_name: &str, column_name: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name.eq_ignore_ascii_case(column_name));
    Ok(exists)
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

    // Indexes backing the Library grid's sort/filter options. Without these, sorting a
    // several-thousand-row library by e.g. view count is a full table scan + temp-b-tree sort
    // on every query, even with a small LIMIT (verified via EXPLAIN QUERY PLAN). IF NOT EXISTS
    // makes repeat calls a fast no-op, so this is safe to run unconditionally.
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosDateAdded ON videos(date_added)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosPublishedAt ON videos(published_at)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosViewCount ON videos(view_count)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosVideoType ON videos(video_type)", []);

    // Warp Drive taxonomy: `WDBS` indirectly ties a video to a row in `tblWDBS` (the Warp Drive
    // repository). `tblWDBS` itself, plus the computed/IMMUTABLE `fkWDBS` column that directly
    // enforces that reference, are owned entirely by the hand-maintained production database this
    // app is expected to run against — Kinesis itself never creates them (see the "internal use
    // only" note in the schema handoff doc). `WDBS` is added here as a plain nullable column so
    // Kinesis keeps working end-to-end (search, display, edit) against a from-scratch database
    // too, without trying to reproduce the taxonomy machinery.
    if !column_exists(&conn, "videos", "WDBS")? {
        conn.execute("ALTER TABLE videos ADD COLUMN WDBS TEXT", [])?;
    }

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
            discord TEXT NOT NULL DEFAULT '',
            channel_id TEXT NOT NULL DEFAULT '',
            subscriber_count INTEGER NOT NULL DEFAULT 9999
        )",
        [],
    )?;
    // channel_id/subscriber_count were added after some databases already existed; ADD COLUMN
    // backfills them onto those. channel_id is the YouTube channel's immutable ID (captured once,
    // at the creator's first save, since handles can change but this can't); subscriber_count
    // seeds at 9999 as an "unknown/needs backfill" sentinel until the (future) backend routine
    // that keeps it continually in sync takes over.
    if !column_exists(&conn, "biographies", "channel_id")? {
        conn.execute("ALTER TABLE biographies ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''", [])?;
    }
    if !column_exists(&conn, "biographies", "subscriber_count")? {
        conn.execute("ALTER TABLE biographies ADD COLUMN subscriber_count INTEGER NOT NULL DEFAULT 9999", [])?;
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

    // Create custom_prompts table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS custom_prompts (
            handle TEXT PRIMARY KEY,
            local_prompt_text TEXT,
            cloud_prompt_text TEXT
        )",
        [],
    )?;

    // Warp Drive "symbolic links": a video's single canonical Warp Drive lives in videos.WDBS
    // (owned by the production tblWDBS/fkWDBS schema — see above), but a video can additionally
    // show up under any number of OTHER Warp Drive categories without changing that canonical
    // value. This table is entirely Kinesis's own bookkeeping (not part of the production
    // schema), so unlike WDBS/fkWDBS it's fully created and owned here regardless of whether
    // tblWDBS is present. See db/wdbs.rs for how this and videos.WDBS are merged when building
    // the Drive/Warp Drive tree and paging a category's videos.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS video_wdbs_links (
            video_id TEXT NOT NULL,
            wdbs     TEXT NOT NULL,
            PRIMARY KEY (video_id, wdbs)
        )",
        [],
    )?;
    // Cleans up symlink rows when their video is deleted. Independent of the tblWDBS-gated
    // trigger block further down — this table has nothing to do with the deprecated FTS
    // triggers or the production schema, so it's always created.
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_kinesis_wdbs_links_cascade_del
        AFTER DELETE ON videos
        BEGIN
            DELETE FROM video_wdbs_links WHERE video_id = OLD.video_id;
        END",
        [],
    );

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
        ("showDrive", "true"),
        ("allowEditBio", "true"),
        ("allowEditTranscriptOnNA", "true"),
        ("navigation_orientation", "horizontal"),
        ("librarySearchLimit", "1024"),
        ("hideShortsInSearch", "true"),
        ("setTranscriptAfterSummarizeToNA", "false"),
        // Off by default: WDBS taxonomy editing is meant to be gated to bona fide IKLAO Admin
        // Users once the IKLAO Cloud is stood up. Until then it's an opt-in switch (mirrors
        // allowEditBio's "settings-table flag, no dedicated UI toggle yet" convention).
        ("allowEditWDBS", "false"),
        ("venice_model", "zai-org-glm-5"),
    ];

    for (key, val) in defaults.iter() {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            params![key, val],
        )?;
    }

    // One-time normalization of the "unassigned Warp Drive" placeholder from "θψ" to ":". "θψ" is
    // made of ordinary alphabetic Unicode characters, so FTS5's tokenizer indexes it as a real
    // searchable term — since it's also the universal prefix every real WDBS value starts with, a
    // Library/Portal search for it matched every video regardless of whether one was assigned.
    // ":" is punctuation, which the tokenizer doesn't index at all, so it can't leak into search
    // results that way. This only ever needs to run once (it's a full-table scan with no index on
    // WDBS), so it's gated behind a settings flag rather than repeated on every launch/search —
    // db::videos::save_video separately normalizes each newly-saved video's row on the spot,
    // since the production database's own INSERT trigger still writes the "θψ" default going
    // forward and this app has no way to change that trigger itself.
    let migrated_placeholder: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'migratedWdbsPlaceholder' AND value = 'true'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if migrated_placeholder == 0 {
        let _ = conn.execute("UPDATE videos SET WDBS = ':' WHERE WDBS = 'θψ'", []);
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('migratedWdbsPlaceholder', 'true')",
            [],
        )?;
    }

    // Create FTS5 virtual table for library video search — idempotent and cheap even when it
    // already exists, so this stays unconditional. `wdbs` is indexed alongside title/summary/
    // tokens so a Warp Drive designator search (":UAP floating" — see db/search.rs) can match
    // against it directly via FTS5 MATCH.
    let _ = conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS ftsVideos USING fts5(title, summary, tokens, wdbs, content='videos')",
        [],
    );
    // Backfills `wdbs` onto an ftsVideos table created before this column existed. FTS5 has
    // supported ALTER TABLE ADD COLUMN since SQLite 3.31; this is a harmless no-op (swallowed
    // "duplicate column" error) on a table the CREATE above just built with wdbs already in it.
    let _ = conn.execute("ALTER TABLE ftsVideos ADD COLUMN wdbs", []);

    // ACTION REQUIRED (per Kinesis DB schema update): trg_ftsVideos_AfterDEL/AfterINS/BeforeDEL/
    // AfterUPD are deprecated — the hand-maintained production database now owns FTS-sync and
    // WDBS referential-integrity via its own 10-trigger schema (see tblWDBS/fkWDBS above), and
    // these four app-created triggers must be permanently dropped so they don't fight the new
    // ones. Unconditional and idempotent: a DB that never had them just no-ops here.
    let _ = conn.execute("DROP TRIGGER IF EXISTS trg_ftsVideos_AfterDEL", []);
    let _ = conn.execute("DROP TRIGGER IF EXISTS trg_ftsVideos_AfterINS", []);
    let _ = conn.execute("DROP TRIGGER IF EXISTS trg_ftsVideos_BeforeDEL", []);
    let _ = conn.execute("DROP TRIGGER IF EXISTS trg_ftsVideos_AfterUPD", []);

    // Compatibility path for databases that DON'T have the production tblWDBS/10-trigger schema
    // (i.e. a from-scratch or pre-WDBS database created by this app itself, not the hand-
    // maintained one). Without this, such a database would silently lose FTS-sync-on-write and
    // biography cascade-delete entirely once the four deprecated triggers above are dropped.
    // Recreated under new names (not the deprecated ones) so they can never collide with
    // whatever the production schema's own 10 triggers are named. Skipped entirely when tblWDBS
    // is present, since that schema already does this (and more) itself — running both would
    // double-insert into ftsVideos on every write.
    if !table_exists(&conn, "tblWDBS")? {
        let _ = conn.execute(
            "CREATE TRIGGER IF NOT EXISTS trg_kinesis_fts_before_del
            BEFORE DELETE ON videos
            BEGIN
                INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens, wdbs)
                VALUES ('delete', OLD.rowid, OLD.title, OLD.summary, OLD.tokens, OLD.WDBS);
            END",
            [],
        );
        let _ = conn.execute(
            "CREATE TRIGGER IF NOT EXISTS trg_kinesis_biography_cascade_del
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
            "CREATE TRIGGER IF NOT EXISTS trg_kinesis_fts_after_ins
            AFTER INSERT ON videos
            BEGIN
                INSERT INTO ftsVideos(rowid, title, summary, tokens, wdbs)
                VALUES (new.rowid, new.title, new.summary, new.tokens, new.WDBS);
            END",
            [],
        );
        let _ = conn.execute(
            "CREATE TRIGGER IF NOT EXISTS trg_kinesis_fts_after_upd
            AFTER UPDATE ON videos
            BEGIN
                INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens, wdbs)
                VALUES ('delete', old.rowid, old.title, old.summary, old.tokens, old.WDBS);
                INSERT INTO ftsVideos(rowid, title, summary, tokens, wdbs)
                VALUES (new.rowid, new.title, new.summary, new.tokens, new.WDBS);
            END",
            [],
        );
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
