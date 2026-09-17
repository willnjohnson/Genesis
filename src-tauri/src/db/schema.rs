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

// Now that Kinesis creates its own bare-bones tblWDBS (see below) on every database, its mere
// presence no longer tells apart a from-scratch/local database from a hand-maintained production
// one with the real WDBS referential-integrity schema — both have the table now. Checking for one
// of that schema's own triggers by name instead still distinguishes them: only a genuine
// production database has ever created trgVideosBeforeUPD_Videos_ValidateWDBS (Kinesis never
// creates it itself), so its presence is what the compatibility-trigger gate further down actually
// needs to test for.
fn trigger_exists(conn: &Connection, trigger_name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name=?",
        params![trigger_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

// Used to idempotently ALTER TABLE ... ADD COLUMN for columns introduced after a database was
// first created — SQLite has no "ADD COLUMN IF NOT EXISTS", so callers check this first. Case-
// folded so e.g. a pre-existing `WDBS` is recognized as satisfying a check for `wdbs` — SQLite
// itself already treats those as the exact same column (identifiers are case-insensitive), so
// this just needs to agree so it doesn't add a second, redundant column beside the first.
fn column_exists(conn: &Connection, table_name: &str, column_name: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name.eq_ignore_ascii_case(column_name));
    Ok(exists)
}

// Unlike `column_exists` above, this does NOT fold case — it's for telling apart two spellings
// that a case-insensitive check would wrongly treat as "the same column" (`ChannelID` vs
// `channel_id` differ by more than case, an added underscore, but so would e.g. `WDBS` vs
// `WDbs`). Used only by the legacy-column migration below, to detect one *specific* old spelling
// to migrate away from — everywhere else, the case-folding behavior of `column_exists` is what's
// wanted (it agrees with what SQLite itself considers "the same column").
fn column_exists_exact(conn: &Connection, table_name: &str, column_name: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == column_name);
    Ok(exists)
}

// Finds an existing column on `table` that's plausibly the same logical field as `canonical`
// under some other historical spelling — `ChannelID`, `ChannelId`, `Channel_Id`, etc. should all
// count as "the same field" as `channel_id`. Compared by lowercasing and stripping underscores
// from both sides, so any of those spellings normalizes to the same "channelid" as the canonical
// one — a single hardcoded old spelling isn't enough here, since the exact legacy casing isn't
// something this app controls or can rely on (it's whatever some other, external database or
// tool happened to use — see migrate_legacy_column below). Returns the column's real, on-disk
// spelling (not the canonical one), since that's what a RENAME COLUMN needs to reference it by.
fn find_legacy_column(conn: &Connection, table: &str, canonical: &str) -> Result<Option<String>> {
    fn normalize(name: &str) -> String {
        name.chars().filter(|c| *c != '_').flat_map(|c| c.to_lowercase()).collect()
    }
    let canonical_norm = normalize(canonical);
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names.into_iter().find(|n| n != canonical && normalize(n) == canonical_norm))
}

// Reconciles a legacy spelling of `to` (found via find_legacy_column above) with the one Kinesis's
// own code actually reads and writes, covering three cases:
//  - Only the legacy spelling exists (a database that predates `to`, e.g. one hand-populated — or
//    populated by some other tool — under the old name): rename it into place, so the real data
//    ends up under the name the rest of the app expects, instead of the app treating it as unset.
//  - Both exist: an earlier run already went ahead and added an empty `to` column right alongside
//    the real legacy-spelled data, because a plain case-insensitive "does this exist" check treats
//    e.g. `ChannelID` and `channel_id` as different columns (they differ by more than case — an
//    added underscore — so it doesn't recognize `to` as already covered by the legacy one). Drop
//    that empty duplicate first, then rename the real column into place, so the real data isn't
//    discarded.
//  - Neither exists (a genuinely fresh database): nothing to reconcile; the caller's own ADD
//    COLUMN (run right after this) seeds `to` from scratch.
fn migrate_legacy_column(conn: &Connection, table: &str, to: &str) -> Result<()> {
    if let Some(from) = find_legacy_column(conn, table, to)? {
        if column_exists_exact(conn, table, to)? {
            conn.execute(&format!("ALTER TABLE {table} DROP COLUMN {to}"), [])?;
        }
        conn.execute(&format!("ALTER TABLE {table} RENAME COLUMN \"{from}\" TO {to}"), [])?;
    }
    Ok(())
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

    // `StopWords` predates this app's snake_case convention for tables it creates and owns —
    // renamed in place (an ALTER TABLE RENAME TO, not a drop+recreate, so no data is lost) so a
    // long-running install ends up on the same name a fresh install gets from here on. The check
    // is exact-case (`table_exists` compares against sqlite_master.name, whose default BINARY
    // collation makes `=` case-sensitive) specifically so it can tell "still under the old name"
    // apart from "already renamed" — a case-insensitive check couldn't, since by that measure the
    // old and new names would look identical. Case-only differences elsewhere (e.g. `Culls`/
    // `culls`) don't need this treatment at all: SQLite matches identifiers case-insensitively, so
    // old and new casing already refer to the exact same column with zero functional difference —
    // only a genuinely different spelling (like an added underscore) needs an actual rename.
    if table_exists(&conn, "StopWords")? && !table_exists(&conn, "stop_words")? {
        conn.execute("ALTER TABLE StopWords RENAME TO stop_words", [])?;
    }
    // `ftsVideos`/`WDBS` are kept under their original casing (not renamed to `fts_videos`/`wdbs`)
    // — an earlier revision of this file did rename `ftsVideos` to `fts_videos` and spell `WDBS`
    // lowercase, but that's since been reverted. Because SQLite matches identifiers case-
    // insensitively, nothing here actually depends on which casing is used — `wdbs`/`WDBS` were
    // always interchangeable with zero functional difference either way — but `ftsVideos` is a
    // genuinely different table name than `fts_videos` (differs by more than case, an added
    // underscore), so a database that already went through the earlier rename needs an actual
    // ALTER TABLE to come back, the same way the StopWords rename above needs one to go forward.
    //
    // Both names can end up coexisting — observed in practice on a database copied mid-migration
    // (e.g. via a db-folder-location change that copies the file, then runs this same init_db
    // against the copy) — where one is the real, populated FTS index and the other is an empty
    // stray from a `CREATE VIRTUAL TABLE IF NOT EXISTS` that ran before the rename below had a
    // chance to. Reconciled by keeping whichever one actually finds a real title in a MATCH query
    // and dropping the other — NOT by comparing `SELECT COUNT(*)` between them (an external-
    // content FTS5 table's plain COUNT(*) just passes through the content table's own row count
    // regardless of whether its index was ever populated, so an empty, never-indexed stray reports
    // the exact same count as a fully-indexed one) and NOT via `integrity-check` either (that only
    // checks the index's internal consistency, not whether it actually reflects the content
    // table's current rows — an empty index is trivially "consistent" with itself and passes it
    // too). Deliberately conservative: if the evidence isn't clear-cut (no usable sample word, or
    // both/neither table matches it), nothing is dropped — an extra unused table sitting around is
    // a mess to clean up later, but silently deleting the wrong one because a heuristic guessed
    // wrong is real data loss, so ambiguity here defaults to doing nothing rather than guessing.
    if table_exists(&conn, "fts_videos")? && table_exists(&conn, "ftsVideos")? {
        let sample_word: Option<String> = conn
            .query_row("SELECT title FROM videos WHERE title IS NOT NULL AND title != ''", [], |row| row.get::<_, String>(0))
            .ok()
            .and_then(|title| {
                title.split_whitespace()
                    .find(|w| w.len() > 2 && w.chars().all(|c| c.is_alphanumeric()))
                    .map(|w| w.to_string())
            });
        if let Some(word) = sample_word {
            let phrase = format!("\"{word}\"");
            let fts_videos_matches: i64 = conn
                .query_row("SELECT COUNT(*) FROM fts_videos WHERE fts_videos MATCH ?1", params![phrase], |row| row.get(0))
                .unwrap_or(0);
            let ftsvideos_matches: i64 = conn
                .query_row("SELECT COUNT(*) FROM ftsVideos WHERE ftsVideos MATCH ?1", params![phrase], |row| row.get(0))
                .unwrap_or(0);
            if fts_videos_matches > 0 && ftsvideos_matches == 0 {
                conn.execute("DROP TABLE ftsVideos", [])?;
                conn.execute("ALTER TABLE fts_videos RENAME TO ftsVideos", [])?;
            } else if ftsvideos_matches > 0 && fts_videos_matches == 0 {
                conn.execute("DROP TABLE fts_videos", [])?;
            }
        }
    } else if table_exists(&conn, "fts_videos")? {
        conn.execute("ALTER TABLE fts_videos RENAME TO ftsVideos", [])?;
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
            published_at DATETIME,
            date_added   DATETIME DEFAULT CURRENT_TIMESTAMP,
            tags         TEXT DEFAULT '',
            tokens       TEXT DEFAULT ''
        )",
        [],
    )?;

    // `tags`/`tokens` were added to the CREATE TABLE above after some databases already existed
    // (same situation as WDBS/channel_id/subscriber_count elsewhere in this file); ADD COLUMN
    // backfills them onto those. Without this, any database created before these columns existed
    // has no way to ever gain them (CREATE TABLE IF NOT EXISTS is a no-op once the table is
    // there), and save_tags/regenerate_tokens_from_transcript — plus the compatibility FTS
    // triggers below, which reference new.tokens/old.tokens on every insert/update — fail outright
    // with "no such column: tokens" the first time anything touches that video.
    if !column_exists(&conn, "videos", "tags")? {
        conn.execute("ALTER TABLE videos ADD COLUMN tags TEXT DEFAULT ''", [])?;
    }
    if !column_exists(&conn, "videos", "tokens")? {
        conn.execute("ALTER TABLE videos ADD COLUMN tokens TEXT DEFAULT ''", [])?;
    }

    // `video_type` ("short"/"standard", derived from length) never ended up wired to any shipped
    // UI — no badge/filter reachable from the Library grid actually used it — and is being
    // retired as dead weight. DROP INDEX before DROP COLUMN so a database that still has the
    // index doesn't leave it dangling. Best-effort (not `?`): a hand-maintained production
    // database may still have its own trigger (trgVideosBeforeINS_Videos_SyncBioHandle)
    // referencing this column until that's updated separately on that database directly — SQLite
    // refuses to drop a column any trigger still references, and that shouldn't block the rest of
    // init_db (or app startup) from succeeding while it's pending.
    if column_exists(&conn, "videos", "video_type")? {
        let _ = conn.execute("DROP INDEX IF EXISTS idxVideosVideoType", []);
        let _ = conn.execute("ALTER TABLE videos DROP COLUMN video_type", []);
    }

    // Indexes backing the Library grid's sort/filter options. Without these, sorting a
    // several-thousand-row library by e.g. view count is a full table scan + temp-b-tree sort
    // on every query, even with a small LIMIT (verified via EXPLAIN QUERY PLAN). IF NOT EXISTS
    // makes repeat calls a fast no-op, so this is safe to run unconditionally.
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosDateAdded ON videos(date_added)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosPublishedAt ON videos(published_at)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idxVideosViewCount ON videos(view_count)", []);

    // Warp Drive taxonomy: `WDBS` indirectly ties a video to a row in `tblWDBS` (the Warp Drive
    // repository) — see db/wdbs.rs. The computed/IMMUTABLE `fkWDBS` column that directly enforces
    // that reference, along with the referential-integrity trigger
    // (trgVideosBeforeUPD_Videos_ValidateWDBS) and the rest of its 10-trigger schema, are still
    // owned entirely by the hand-maintained production database this app is expected to run
    // against — Kinesis never creates any of those (see the "internal use only" note in the schema
    // handoff doc, and trigger_exists's own comment above for how the compatibility path further
    // down tells a production database apart from a from-scratch one now that this is no longer
    // true of tblWDBS itself). `WDBS` is added here as a plain nullable column so Kinesis keeps
    // working end-to-end (search, display, edit) against a from-scratch database too, without
    // trying to reproduce the taxonomy machinery. No migration is needed for a database whose
    // column ended up declared lowercase `wdbs` by an earlier revision of this file — SQLite
    // matches identifiers case-insensitively, so `WDBS` and `wdbs` already refer to the exact same
    // column (this check folds case for exactly that reason), and every query in this codebase now
    // spells it uppercase regardless of which case a given database has it under.
    if !column_exists(&conn, "videos", "WDBS")? {
        conn.execute("ALTER TABLE videos ADD COLUMN WDBS TEXT", [])?;
    }

    // tblWDBS itself: unlike fkWDBS/the validation trigger above, Kinesis now creates and owns
    // this table directly (a change from earlier versions, which assumed it only ever existed
    // because a hand-maintained production database provided it) — see db/wdbs.rs's
    // ensure_wdbs_path_exists/get_wdbs_tree/set_wdbs_alias/set_wdbs_icon for what actually reads
    // and writes it. `WDBS` is the display-format path (":UAP-GERB-VVV") of one taxonomy node;
    // `lev` its depth (1 = top-level); `WDID` its own raw segment name; `WDInfo`/`WDIcon` the
    // curated alias/icon a user can set on it (see WdbsTreePanel.tsx's right-click menu);
    // `WDDefault` mirrors the production schema's own column of the same name (unused by Kinesis
    // itself, kept only so a row shaped like this is also acceptable there).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tblWDBS (
            WDBS      TEXT PRIMARY KEY,
            lev       INTEGER NOT NULL DEFAULT 0,
            WDID      TEXT NOT NULL DEFAULT '',
            WDInfo    TEXT NOT NULL DEFAULT '',
            WDIcon    TEXT NOT NULL DEFAULT '',
            WDDefault INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )?;
    // Migrates a tblWDBS that predates the column shape above — either a hand-maintained
    // production database using its older (`Keep`, `Lev`, `WDAlias`) shape, or a database created
    // by an earlier revision of this app's own now-removed WDAlias-based alias support (see
    // set_wdbs_alias's own history). `Lev`/`lev` differ only by case, which SQLite already treats
    // as the same column, so a `column_exists_exact` check (unlike `column_exists`) is what's
    // needed to tell "still declared as `Lev`" apart from "already `lev`". `Keep`/`WDAlias` are
    // dropped outright — SQLite has supported DROP COLUMN since 3.35 (2021), well before the
    // bundled version this app links against.
    if column_exists_exact(&conn, "tblWDBS", "Lev")? && !column_exists_exact(&conn, "tblWDBS", "lev")? {
        conn.execute("ALTER TABLE tblWDBS RENAME COLUMN Lev TO lev", [])?;
    }
    if column_exists(&conn, "tblWDBS", "Keep")? {
        conn.execute("ALTER TABLE tblWDBS DROP COLUMN Keep", [])?;
    }
    if column_exists(&conn, "tblWDBS", "WDAlias")? {
        conn.execute("ALTER TABLE tblWDBS DROP COLUMN WDAlias", [])?;
    }
    if !column_exists(&conn, "tblWDBS", "WDIcon")? {
        conn.execute("ALTER TABLE tblWDBS ADD COLUMN WDIcon TEXT NOT NULL DEFAULT ''", [])?;
    }

    // Create stop_words table: common words culled out of generated FTS tokens
    conn.execute(
        "CREATE TABLE IF NOT EXISTS stop_words (
            culls TEXT PRIMARY KEY
        )",
        [],
    )?;

    let stopword_count: i64 = conn.query_row("SELECT COUNT(*) FROM stop_words", [], |row| row.get(0))?;
    if stopword_count == 0 {
        for word in DEFAULT_STOPWORDS {
            conn.execute("INSERT OR IGNORE INTO stop_words (culls) VALUES (?1)", params![word])?;
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
            subscriber_count INTEGER NOT NULL DEFAULT -1
        )",
        [],
    )?;
    // channel_id/subscriber_count were added after some databases already existed. Some of those
    // databases already had equivalent data under some other historical spelling (e.g. `ChannelID`/
    // `SubscriberCount`) — migrate_legacy_column renames the real data into place (matching by
    // logical field, not one hardcoded exact spelling, since the legacy casing isn't something
    // this app controls — see find_legacy_column), reconciling it with any empty `channel_id`/
    // `subscriber_count` a previous run may have already added right alongside it (see that
    // function's own comment for why a plain case-insensitive existence check doesn't catch this
    // — `ChannelID` vs `channel_id` differ by more than case). The ADD COLUMN calls below then
    // only ever fire for a database that genuinely has neither spelling. channel_id is the YouTube
    // channel's immutable ID (captured once, at the creator's first save, since handles can change
    // but this can't); subscriber_count seeds at -1 as an "unknown/needs backfill" sentinel
    // (negative, since a real count never is, unlike the old 9999 which could in principle
    // coincidentally match a real one) until the (future) backend routine that keeps it
    // continually in sync takes over.
    migrate_legacy_column(&conn, "biographies", "channel_id")?;
    migrate_legacy_column(&conn, "biographies", "subscriber_count")?;
    if !column_exists(&conn, "biographies", "channel_id")? {
        conn.execute("ALTER TABLE biographies ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''", [])?;
    }
    if !column_exists(&conn, "biographies", "subscriber_count")? {
        conn.execute("ALTER TABLE biographies ADD COLUMN subscriber_count INTEGER NOT NULL DEFAULT -1", [])?;
    }
    // One-time normalization of existing rows still holding the old 9999 sentinel, so a database
    // that already went through the ADD COLUMN above (under the old default) doesn't keep it
    // forever — gated behind a settings flag rather than repeated on every launch, same pattern as
    // migratedWdbsPlaceholder below.
    let migrated_subscriber_sentinel: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'migratedSubscriberCountSentinel' AND value = 'true'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if migrated_subscriber_sentinel == 0 {
        let _ = conn.execute("UPDATE biographies SET subscriber_count = -1 WHERE subscriber_count = 9999", []);
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('migratedSubscriberCountSentinel', 'true')",
            [],
        )?;
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

    // Warp Drive "symbolic links": a video's single canonical Warp Drive lives in videos.WDBS,
    // validated (on a hand-maintained production database) against the production fkWDBS schema
    // — see above — but a video can additionally show up under any number of OTHER Warp Drive
    // categories without changing that canonical value. This table is entirely Kinesis's own
    // bookkeeping (not part of the production schema), so unlike fkWDBS it's fully created and
    // owned here regardless of which kind of database this is. See db/wdbs.rs for how this and
    // videos.WDBS are merged when building the Drive/Warp Drive tree and paging a category's
    // videos.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS video_wdbs_links (
            video_id TEXT NOT NULL,
            wdbs     TEXT NOT NULL,
            PRIMARY KEY (video_id, wdbs)
        )",
        [],
    )?;
    // Cleans up symlink rows when their video is deleted — but only on a from-scratch database
    // without the production schema (see the trigger_exists-gated block further down, where this
    // is actually created): a hand-maintained production database now has its own equivalent
    // (trgVideosAfterDEL_video_wdbs_links_RemoveRecords), so creating this one there too would
    // just double-run the same DELETE on every video removal for no benefit. Unconditionally
    // dropped here for any database that already has it from an earlier Kinesis version, now that
    // it's redundant wherever the production trigger exists.
    if trigger_exists(&conn, "trgVideosBeforeUPD_Videos_ValidateWDBS")? {
        let _ = conn.execute("DROP TRIGGER IF EXISTS trg_kinesis_wdbs_links_cascade_del", []);
    }

    // One-time backfill of tblWDBS rows for any videos.WDBS/video_wdbs_links assignment made
    // before Kinesis started creating/owning tblWDBS itself (see the tblWDBS block above) —
    // ensure_wdbs_path_exists was a no-op on a from-scratch database back then, so such an
    // assignment could exist with no matching tblWDBS row. Left unregistered, curating an
    // alias/icon on that node via set_wdbs_alias/set_wdbs_icon silently no-ops (their UPDATE
    // matches zero rows) even though the node visibly shows up in the tree — see
    // db::wdbs::backfill_missing_wdbs_paths. Gated behind a settings flag rather than repeated on
    // every launch, same pattern as migratedWdbsPlaceholder/migratedSubscriberCountSentinel above.
    let migrated_wdbs_backfill: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'migratedWdbsTaxonomyBackfill' AND value = 'true'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if migrated_wdbs_backfill == 0 {
        super::wdbs::backfill_missing_wdbs_paths(&conn)?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('migratedWdbsTaxonomyBackfill', 'true')",
            [],
        )?;
    }

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

    // Backfills `WDBS` onto an ftsVideos table created (by an earlier version of this app) before
    // that column existed. Unlike ordinary tables, FTS5 virtual tables reject ALTER TABLE ADD
    // COLUMN outright ("virtual tables may not be altered") — there is no in-place way to add a
    // column to one. A prior version of this migration tried `ALTER TABLE ftsVideos ADD COLUMN
    // WDBS` anyway and swallowed the resulting error, so on any database whose ftsVideos table
    // predates this column, it silently never gained `WDBS` — and every subsequent write (the
    // compatibility triggers below insert into ftsVideos on every video insert/update/delete)
    // failed with "table ftsVideos has no column named WDBS", most visibly when assigning a Warp
    // Drive value. The only real fix is to drop and recreate the table, then ask FTS5 to rebuild
    // its index from the content table — `rebuild` matches columns by name (case-insensitively),
    // so it correctly backfills `WDBS` from the existing `videos.WDBS` values.
    let fts_missing_wdbs = table_exists(&conn, "ftsVideos")? && !column_exists(&conn, "ftsVideos", "WDBS")?;
    if fts_missing_wdbs {
        conn.execute("DROP TABLE ftsVideos", [])?;
    }
    // Create FTS5 virtual table for library video search — idempotent and cheap even when it
    // already exists, so this stays unconditional. `WDBS` is indexed alongside title/summary/
    // tokens so a Warp Drive designator search (":UAP floating" — see db/search.rs) can match
    // against it directly via FTS5 MATCH.
    let _ = conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS ftsVideos USING fts5(title, summary, tokens, WDBS, content='videos')",
        [],
    );
    if fts_missing_wdbs {
        conn.execute("INSERT INTO ftsVideos(ftsVideos) VALUES('rebuild')", [])?;
    }

    // ACTION REQUIRED (per Kinesis DB schema update): trg_ftsVideos_AfterDEL/AfterINS/BeforeDEL/
    // AfterUPD are deprecated — the hand-maintained production database now owns FTS-sync and
    // WDBS referential-integrity via its own 10-trigger schema (see tblWDBS/fkWDBS above), and
    // these four app-created triggers must be permanently dropped so they don't fight the new
    // ones. Unconditional and idempotent: a DB that never had them just no-ops here.
    let _ = conn.execute("DROP TRIGGER IF EXISTS trg_ftsVideos_AfterDEL", []);
    let _ = conn.execute("DROP TRIGGER IF EXISTS trg_ftsVideos_AfterINS", []);
    let _ = conn.execute("DROP TRIGGER IF EXISTS trg_ftsVideos_BeforeDEL", []);
    let _ = conn.execute("DROP TRIGGER IF EXISTS trg_ftsVideos_AfterUPD", []);

    // Compatibility path for databases that DON'T have the production 10-trigger WDBS schema
    // (i.e. a from-scratch or pre-WDBS database created by this app itself, not the hand-
    // maintained one). Without this, such a database would silently lose FTS-sync-on-write and
    // biography cascade-delete entirely once the four deprecated triggers above are dropped.
    // Recreated under new names (not the deprecated ones) so they can never collide with
    // whatever the production schema's own 10 triggers are named. Skipped entirely when that
    // production schema is present, since it already does this (and more) itself — running both
    // would double-insert into ftsVideos on every write.
    //
    // Gated on trgVideosBeforeUPD_Videos_ValidateWDBS specifically (one of the production schema's
    // own triggers), not on tblWDBS's existence — Kinesis creates a bare tblWDBS itself now (see
    // above), so the table alone no longer tells a from-scratch database apart from a hand-
    // maintained production one the way it used to.
    //
    // These bodies are only what a *freshly created* trigger gets — CREATE TRIGGER IF NOT EXISTS
    // is a no-op on a database where the trigger already exists from a previous run, and that
    // existing trigger's stored body doesn't need separate migrating here: renaming fts_videos
    // back to ftsVideos above (an ALTER TABLE ... RENAME TO) already asked SQLite to rewrite every
    // reference to the old name across the whole schema, trigger bodies included, as part of that
    // same rename.
    if !trigger_exists(&conn, "trgVideosBeforeUPD_Videos_ValidateWDBS")? {
        let _ = conn.execute(
            "CREATE TRIGGER IF NOT EXISTS trg_kinesis_fts_before_del
            BEFORE DELETE ON videos
            BEGIN
                INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens, WDBS)
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
                INSERT INTO ftsVideos(rowid, title, summary, tokens, WDBS)
                VALUES (new.rowid, new.title, new.summary, new.tokens, new.WDBS);
            END",
            [],
        );
        let _ = conn.execute(
            "CREATE TRIGGER IF NOT EXISTS trg_kinesis_fts_after_upd
            AFTER UPDATE ON videos
            BEGIN
                INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens, WDBS)
                VALUES ('delete', old.rowid, old.title, old.summary, old.tokens, old.WDBS);
                INSERT INTO ftsVideos(rowid, title, summary, tokens, WDBS)
                VALUES (new.rowid, new.title, new.summary, new.tokens, new.WDBS);
            END",
            [],
        );
        // Cleans up video_wdbs_links symlink rows when their video is deleted — needed here since
        // a from-scratch database has no production trgVideosAfterDEL_video_wdbs_links_RemoveRecords
        // of its own to do this (see the unconditional DROP further up, for when one shows up
        // later via this same database gaining the production schema).
        let _ = conn.execute(
            "CREATE TRIGGER IF NOT EXISTS trg_kinesis_wdbs_links_cascade_del
            AFTER DELETE ON videos
            BEGIN
                DELETE FROM video_wdbs_links WHERE video_id = OLD.video_id;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // A real temp file, not ":memory:" — init_db opens its own Connection each call, and every
    // connection to ":memory:" gets an independent, empty database, so a "set up legacy state,
    // then run init_db against it" test needs the state to actually persist across connections.
    fn temp_db_path(name: &str) -> String {
        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        path.push(format!("kinesis_schema_test_{name}_{nanos}.db"));
        path.to_string_lossy().to_string()
    }



    #[test]
    fn fresh_database_uses_expected_names() {
        let db_path = temp_db_path("fresh");
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        // StopWords/biographies' channel_id/subscriber_count: snake_case, as before.
        assert!(table_exists(&conn, "stop_words").unwrap());
        assert!(!table_exists(&conn, "StopWords").unwrap());
        assert!(column_exists_exact(&conn, "biographies", "channel_id").unwrap());
        assert!(column_exists_exact(&conn, "biographies", "subscriber_count").unwrap());
        // ftsVideos/WDBS: kept under their original casing (reverted from an earlier revision
        // that renamed/lowercased these — see the comments above the rename/ADD COLUMN below).
        assert!(table_exists(&conn, "ftsVideos").unwrap());
        assert!(!table_exists(&conn, "fts_videos").unwrap());
        assert!(column_exists_exact(&conn, "videos", "WDBS").unwrap());
        conn.execute("INSERT INTO biographies (handle) VALUES ('fresh-handle')", []).unwrap();
        let default_subscriber_count: i64 = conn.query_row(
            "SELECT subscriber_count FROM biographies WHERE handle = 'fresh-handle'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(default_subscriber_count, -1);
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn legacy_biography_columns_are_renamed_without_losing_data() {
        let db_path = temp_db_path("bio_legacy");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "CREATE TABLE biographies (
                    handle TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    ChannelID TEXT NOT NULL DEFAULT '',
                    SubscriberCount INTEGER NOT NULL DEFAULT 9999
                )",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO biographies (handle, ChannelID, SubscriberCount) VALUES ('someone', 'UCXXXXX', 12345)",
                [],
            ).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        assert!(!column_exists_exact(&conn, "biographies", "ChannelID").unwrap());
        assert!(!column_exists_exact(&conn, "biographies", "SubscriberCount").unwrap());
        let (channel_id, subscriber_count): (String, i64) = conn.query_row(
            "SELECT channel_id, subscriber_count FROM biographies WHERE handle = 'someone'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(channel_id, "UCXXXXX");
        assert_eq!(subscriber_count, 12345);
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn duplicate_legacy_and_buggy_new_biography_columns_reconcile_to_the_real_data() {
        // Simulates a database already hit by the bug this migration fixes: both the real
        // `ChannelID`/`SubscriberCount` data AND an empty `channel_id`/`subscriber_count` that an
        // earlier (buggy) run already added right alongside it.
        let db_path = temp_db_path("bio_dup");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "CREATE TABLE biographies (
                    handle TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    ChannelID TEXT NOT NULL DEFAULT '',
                    SubscriberCount INTEGER NOT NULL DEFAULT 9999,
                    channel_id TEXT NOT NULL DEFAULT '',
                    subscriber_count INTEGER NOT NULL DEFAULT 9999
                )",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO biographies (handle, ChannelID, SubscriberCount) VALUES ('someone', 'UCREAL', 999)",
                [],
            ).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        assert!(!column_exists_exact(&conn, "biographies", "ChannelID").unwrap());
        assert!(!column_exists_exact(&conn, "biographies", "SubscriberCount").unwrap());
        let (channel_id, subscriber_count): (String, i64) = conn.query_row(
            "SELECT channel_id, subscriber_count FROM biographies WHERE handle = 'someone'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(channel_id, "UCREAL");
        assert_eq!(subscriber_count, 999);
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn legacy_column_matching_is_not_limited_to_one_hardcoded_spelling() {
        // A different historical spelling than the `ChannelID`/`SubscriberCount` the other tests
        // use (`Channel_Id`/`Subscriber_Count` — mixed case AND an underscore) — this is exactly
        // the case a fixed exact-string check would miss, since the real legacy spelling in any
        // given database isn't something this app controls.
        let db_path = temp_db_path("bio_legacy_other_spelling");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "CREATE TABLE biographies (
                    handle TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    Channel_Id TEXT NOT NULL DEFAULT '',
                    Subscriber_Count INTEGER NOT NULL DEFAULT 9999
                )",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO biographies (handle, Channel_Id, Subscriber_Count) VALUES ('someone', 'UCOTHER', 42)",
                [],
            ).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        assert!(!column_exists_exact(&conn, "biographies", "Channel_Id").unwrap());
        assert!(!column_exists_exact(&conn, "biographies", "Subscriber_Count").unwrap());
        let (channel_id, subscriber_count): (String, i64) = conn.query_row(
            "SELECT channel_id, subscriber_count FROM biographies WHERE handle = 'someone'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(channel_id, "UCOTHER");
        assert_eq!(subscriber_count, 42);
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn preexisting_9999_sentinel_is_normalized_to_negative_one() {
        let db_path = temp_db_path("subscriber_sentinel");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "CREATE TABLE biographies (
                    handle TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    channel_id TEXT NOT NULL DEFAULT '',
                    subscriber_count INTEGER NOT NULL DEFAULT 9999
                )",
                [],
            ).unwrap();
            // One row still genuinely unknown (the old sentinel), one with a real count that just
            // happens to differ from it — only the former should change.
            conn.execute("INSERT INTO biographies (handle, subscriber_count) VALUES ('unknown-guy', 9999)", []).unwrap();
            conn.execute("INSERT INTO biographies (handle, subscriber_count) VALUES ('known-guy', 500)", []).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        let unknown: i64 = conn.query_row(
            "SELECT subscriber_count FROM biographies WHERE handle = 'unknown-guy'", [], |row| row.get(0),
        ).unwrap();
        let known: i64 = conn.query_row(
            "SELECT subscriber_count FROM biographies WHERE handle = 'known-guy'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(unknown, -1);
        assert_eq!(known, 500);
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn legacy_stop_words_table_is_renamed_without_losing_data() {
        let db_path = temp_db_path("legacy_stopwords");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute("CREATE TABLE StopWords (Culls TEXT PRIMARY KEY)", []).unwrap();
            conn.execute("INSERT INTO StopWords (Culls) VALUES ('the')", []).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        assert!(table_exists(&conn, "stop_words").unwrap());
        assert!(!table_exists(&conn, "StopWords").unwrap());
        let has_the: i64 = conn.query_row("SELECT COUNT(*) FROM stop_words WHERE culls = 'the'", [], |row| row.get(0)).unwrap();
        assert_eq!(has_the, 1);
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn previously_renamed_fts_videos_table_is_reverted_to_ftsvideos_without_losing_data() {
        // Simulates a database that already went through the earlier (since-reverted) rename to
        // `fts_videos` — init_db should rename it back to `ftsVideos`, preserving both the row
        // data and the FTS index's ability to actually find it (not just the table's existence).
        let db_path = temp_db_path("fts_videos_revert");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute("CREATE TABLE videos (video_id TEXT PRIMARY KEY, title TEXT, summary TEXT, tokens TEXT DEFAULT '', WDBS TEXT)", []).unwrap();
            conn.execute("CREATE VIRTUAL TABLE fts_videos USING fts5(title, summary, tokens, wdbs, content='videos')", []).unwrap();
            conn.execute("INSERT INTO videos (video_id, title, summary, tokens, WDBS) VALUES ('v1', 'Some Title', 'Some Summary', 'some title', ':UAP')", []).unwrap();
            conn.execute("INSERT INTO fts_videos(rowid, title, summary, tokens, wdbs) VALUES (1, 'Some Title', 'Some Summary', 'some title', ':UAP')", []).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        assert!(table_exists(&conn, "ftsVideos").unwrap());
        assert!(!table_exists(&conn, "fts_videos").unwrap());
        let matched_id: String = conn.query_row(
            "SELECT v.video_id FROM videos AS v JOIN ftsVideos ON v.rowid = ftsVideos.rowid WHERE ftsVideos MATCH 'Some'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(matched_id, "v1");
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn coexisting_fts_videos_and_ftsvideos_reconcile_to_whichever_has_real_data() {
        // Simulates the split-brain state observed in practice: a real, populated `fts_videos`
        // (from an earlier revision's rename) sitting alongside an empty stray `ftsVideos` (from
        // a `CREATE VIRTUAL TABLE IF NOT EXISTS` that ran before this file's rename-back had a
        // chance to fire, e.g. because the db file was copied mid-migration). init_db should keep
        // the real data under `ftsVideos` and discard the empty stray, not the other way around.
        let db_path = temp_db_path("fts_videos_coexist");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute("CREATE TABLE videos (video_id TEXT PRIMARY KEY, title TEXT, summary TEXT, tokens TEXT DEFAULT '', WDBS TEXT)", []).unwrap();
            conn.execute("CREATE VIRTUAL TABLE fts_videos USING fts5(title, summary, tokens, wdbs, content='videos')", []).unwrap();
            conn.execute("CREATE VIRTUAL TABLE ftsVideos USING fts5(title, summary, tokens, wdbs, content='videos')", []).unwrap();
            conn.execute("INSERT INTO videos (video_id, title, summary, tokens, WDBS) VALUES ('v1', 'Some Title', 'Some Summary', 'some title', ':UAP')", []).unwrap();
            conn.execute("INSERT INTO fts_videos(rowid, title, summary, tokens, wdbs) VALUES (1, 'Some Title', 'Some Summary', 'some title', ':UAP')", []).unwrap();
            // ftsVideos deliberately left empty, mirroring the stray table's real-world state.
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        assert!(table_exists(&conn, "ftsVideos").unwrap());
        assert!(!table_exists(&conn, "fts_videos").unwrap());
        let matched_id: String = conn.query_row(
            "SELECT v.video_id FROM videos AS v JOIN ftsVideos ON v.rowid = ftsVideos.rowid WHERE ftsVideos MATCH 'Some'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(matched_id, "v1");
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn coexisting_fts_videos_and_ftsvideos_are_left_untouched_when_ambiguous() {
        // Neither table has a usable video to test a MATCH query against (no titles at all) — the
        // reconciliation above must not guess in this case. Deleting the wrong one on a bad guess
        // would be real data loss, so ambiguity here should mean "do nothing" rather than "pick
        // one anyway". Both tables — and all their data — must still exist afterward.
        let db_path = temp_db_path("fts_videos_ambiguous");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute("CREATE TABLE videos (video_id TEXT PRIMARY KEY, title TEXT, summary TEXT, tokens TEXT DEFAULT '', WDBS TEXT)", []).unwrap();
            conn.execute("CREATE VIRTUAL TABLE fts_videos USING fts5(title, summary, tokens, wdbs, content='videos')", []).unwrap();
            conn.execute("CREATE VIRTUAL TABLE ftsVideos USING fts5(title, summary, tokens, wdbs, content='videos')", []).unwrap();
            conn.execute("INSERT INTO videos (video_id, title, summary, tokens, WDBS) VALUES ('v1', NULL, NULL, '', ':UAP')", []).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        assert!(table_exists(&conn, "fts_videos").unwrap());
        assert!(table_exists(&conn, "ftsVideos").unwrap());
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn preexisting_lowercase_wdbs_column_is_not_duplicated_and_stays_queryable_uppercase() {
        // Simulates a database whose `videos.wdbs` column was declared lowercase by the earlier
        // (since-reverted) revision — init_db should recognize it as already satisfying the
        // (case-insensitive) existence check, rather than adding a second `WDBS` column beside it.
        let db_path = temp_db_path("wdbs_case");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute("CREATE TABLE videos (video_id TEXT PRIMARY KEY, title TEXT, summary TEXT, tokens TEXT DEFAULT '', wdbs TEXT)", []).unwrap();
            conn.execute("INSERT INTO videos (video_id, wdbs) VALUES ('v1', ':UAP')", []).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        let wdbs_ish_columns: Vec<String> = conn.prepare("PRAGMA table_info(videos)").unwrap()
            .query_map([], |row| row.get::<_, String>(1)).unwrap()
            .filter_map(|r| r.ok())
            .filter(|n| n.eq_ignore_ascii_case("wdbs"))
            .collect();
        assert_eq!(wdbs_ish_columns.len(), 1, "expected exactly one wdbs-ish column, got {:?}", wdbs_ish_columns);
        let value: String = conn.query_row("SELECT WDBS FROM videos WHERE video_id = 'v1'", [], |row| row.get(0)).unwrap();
        assert_eq!(value, ":UAP");
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn backfills_tblwdbs_rows_for_preexisting_video_assignments() {
        // Simulates a database from before Kinesis created/owned tblWDBS itself (see the tblWDBS
        // block above): a video already has a WDBS designator, but tblWDBS doesn't exist yet, so
        // ensure_wdbs_path_exists was a no-op back when that designator was set and no matching
        // row was ever created for it. Without backfill_missing_wdbs_paths, the node still shows
        // up fine in get_wdbs_tree (built straight from videos.WDBS), but set_wdbs_alias/
        // set_wdbs_icon's UPDATE against tblWDBS would silently match zero rows for it.
        let db_path = temp_db_path("wdbs_backfill");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute("CREATE TABLE videos (video_id TEXT PRIMARY KEY, title TEXT, summary TEXT, tokens TEXT DEFAULT '', WDBS TEXT)", []).unwrap();
            conn.execute("INSERT INTO videos (video_id, WDBS) VALUES ('v1', 'θψUAP_GERB')", []).unwrap();
        }
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        let paths: Vec<String> = conn.prepare("SELECT WDBS FROM tblWDBS ORDER BY WDBS").unwrap()
            .query_map([], |row| row.get::<_, String>(0)).unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(paths, vec![":UAP".to_string(), ":UAP-GERB".to_string()]);
        let changed = conn.execute("UPDATE tblWDBS SET WDInfo = 'Curated' WHERE WDBS = ':UAP-GERB'", []).unwrap();
        assert_eq!(changed, 1, "set_wdbs_alias's UPDATE must actually match the backfilled row");
        drop(conn);
        let _ = fs::remove_file(&db_path);
    }
}
