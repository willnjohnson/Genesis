use rusqlite::{params, Connection, Result};
use crate::Video;

pub fn init_db(db_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;

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
            date_added   DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

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

    // Initialize default settings if they don't exist
    let defaults = [
        ("showSearch", "true"),
        ("allowDeletionLibrary", "true"),
        ("allowModificationGlossary", "true"),
    ];

    for (key, val) in defaults.iter() {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            params![key, val],
        )?;
    }

    // Migration: Ensure search_history has the correct new schema (drop and recreate if it lacks search_query)
    if conn.query_row("SELECT search_query FROM search_history LIMIT 1", [], |_| Ok(())).is_err() {
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
        let has_col = conn.query_row("SELECT name FROM pragma_table_info('videos') WHERE name='published_at'", [], |_| Ok(())).is_ok();
        
        if !has_col {
            // Simple expansion for very old DBs
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN handle TEXT", []);
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN length_seconds INTEGER", []);
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN summary TEXT", []);
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN view_count INTEGER DEFAULT 0", []);
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN video_type TEXT DEFAULT 'standard'", []);
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN published_at DATETIME", []);
            let _ = conn.execute("ALTER TABLE videos ADD COLUMN date_added DATETIME DEFAULT CURRENT_TIMESTAMP", []);
        } else {
            // Full migration needed to change TEXT to DATETIME
            let _ = conn.execute_batch("
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
            ");
        }
    }

    Ok(())
}



pub fn list_videos(db_path: &str, video_type_filter: Option<&str>) -> Result<Vec<Video>> {
    let conn = Connection::open(db_path)?;
    
    let query = match video_type_filter {
        Some("short") => "SELECT video_id, title, author, length_seconds, view_count, published_at, date_added, handle, video_type, transcript FROM videos WHERE video_type = 'short' ORDER BY date_added DESC, rowid DESC",
        Some("standard") => "SELECT video_id, title, author, length_seconds, view_count, published_at, date_added, handle, video_type, transcript FROM videos WHERE video_type = 'standard' ORDER BY date_added DESC, rowid DESC",
        _ => "SELECT video_id, title, author, length_seconds, view_count, published_at, date_added, handle, video_type, transcript FROM videos ORDER BY date_added DESC, rowid DESC",
    };
    
    let mut stmt = conn.prepare(query)?;
    let video_iter = stmt.query_map([], |row| {
        let view_count_str = match row.get::<_, Option<i64>>(4) {
            Ok(Some(0)) | Ok(None) => "Saved".to_string(),
            Ok(Some(n)) => n.to_string(),
            Err(_) => {
                match row.get::<_, Option<String>>(4) {
                    Ok(Some(ref s)) if s == "0" => "Saved".to_string(),
                    Ok(Some(s)) => s,
                    _ => "Saved".to_string(),
                }
            }
        };
        Ok(Video {
            id: row.get::<_, String>(0).unwrap_or_default(),
            title: row.get::<_, Option<String>>(1).unwrap_or(None).unwrap_or_else(|| "Unknown".to_string()),
            author: row.get::<_, Option<String>>(2).unwrap_or(None),
            length_seconds: match row.get::<_, Option<i32>>(3) {
                Ok(v) => v,
                Err(_) => row.get::<_, Option<String>>(3).unwrap_or(None).and_then(|s| s.parse().ok()),
            },
            view_count: view_count_str,
            thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", row.get::<_, String>(0).unwrap_or_default()),
            published_at: row.get::<_, Option<String>>(5).unwrap_or(None).unwrap_or_else(|| "".to_string()),
            status: Some("saved".to_string()),
            date_added: row.get::<_, Option<String>>(6).unwrap_or(None),
            handle: row.get::<_, Option<String>>(7).unwrap_or(None),
            video_type: row.get::<_, Option<String>>(8).unwrap_or(None),
            transcript: row.get::<_, Option<String>>(9).unwrap_or(None),
        })
    })?;

    let mut videos = Vec::new();
    for video in video_iter {
        videos.push(video?);
    }
    Ok(videos)
}

pub fn save_video(db_path: &str, video_id: &str, title: &str, author: &str, length: i32, transcript: &str, view_count: i64, published_at: &str, handle: &str, video_type: &str, summary: Option<&str>) -> Result<()> {
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

pub fn get_video_full(db_path: &str, video_id: &str) -> Result<Option<(String, String, String, i32, String, i64, String, String, String, String)>> {
     let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT video_id, title, author, length_seconds, transcript, view_count, published_at, handle, video_type, date_added FROM videos WHERE video_id = ?")?;
    let mut rows = stmt.query(params![video_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, Option<String>>(1).unwrap_or(None).unwrap_or_else(|| "Unknown".to_string()),
            row.get::<_, Option<String>>(2).unwrap_or(None).unwrap_or_else(|| "Unknown".to_string()),
            match row.get::<_, Option<i32>>(3) {
                Ok(Some(v)) => v,
                Err(_) => row.get::<_, Option<String>>(3).unwrap_or(None).and_then(|s| s.parse().ok()).unwrap_or(0),
                _ => 0,
            },
            row.get::<_, Option<String>>(4).unwrap_or(None).unwrap_or_else(|| "".to_string()),
            match row.get::<_, Option<i64>>(5) {
                Ok(Some(n)) => n,
                Err(_) => match row.get::<_, Option<String>>(5) {
                    Ok(Some(s)) => s.parse::<i64>().unwrap_or(0),
                    _ => 0,
                },
                _ => 0,
            },
            row.get::<_, Option<String>>(6).unwrap_or(None).unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<String>>(7).unwrap_or(None).unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<String>>(8).unwrap_or(None).unwrap_or_else(|| "standard".to_string()),
            row.get::<_, Option<String>>(9).unwrap_or(None).unwrap_or_else(|| "".to_string())
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
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM videos")?;
    let count: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(count)
}

pub fn get_history_stats(db_path: &str) -> Result<i64> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM search_history")?;
    let count: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(count)
}

pub fn save_summary(db_path: &str, video_id: &str, summary: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE videos SET summary = ?1 WHERE video_id = ?2",
        params![summary, video_id],
    )?;
    Ok(())
}

pub fn get_summary(db_path: &str, video_id: &str) -> Result<Option<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT summary FROM videos WHERE video_id = ?")?;
    let mut rows = stmt.query(params![video_id])?;
    if let Some(row) = rows.next()? {
        Ok(row.get(0)?)
    } else {
        Ok(None)
    }
}

pub fn get_summarized_count(db_path: &str) -> Result<i64> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM videos WHERE summary IS NOT NULL AND summary != ''")?;
    let count: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(count)
}

pub fn get_videos_with_summaries(db_path: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT video_id FROM videos WHERE summary IS NOT NULL AND summary != ''")?;
    let mut rows = stmt.query([])?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        ids.push(row.get(0)?);
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
    let mut stmt = conn.prepare("SELECT term, definition FROM glossary ORDER BY term COLLATE NOCASE")?;
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
