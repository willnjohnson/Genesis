use crate::Video;
use rusqlite::{params, Connection, Result};
use super::summaries::{append_channel_info_footer, clean_blockquote_lines, clear_transcript_after_summary, has_real_summary};
use super::search::regenerate_tokens_from_transcript;

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

pub fn save_transcript(db_path: &str, video_id: &str, transcript: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE videos SET transcript = ?1 WHERE video_id = ?2",
        params![transcript, video_id],
    )?;
    regenerate_tokens_from_transcript(&conn, video_id)?;
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

pub fn get_unique_handles(db_path: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT DISTINCT handle FROM videos WHERE handle IS NOT NULL AND handle != '' ORDER BY handle")?;
    let handles = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(handles)
}
