use crate::Video;
use rusqlite::{params, Connection, Result};
use super::summaries::{append_channel_info_footer, clean_blockquote_lines, clear_transcript_after_summary, has_real_summary};
use super::search::{regenerate_tokens_from_transcript, video_row, video_columns_sql, filter_kind_where, library_order_by};

/// Pages the Library grid: optionally filtered to one `video_type` ("short"/"standard") and one
/// `filter_kind` ("transcript"/"summary"/None-or-"all"), ordered per `sort_field`/`sort_order`
/// (see `library_order_by`), and capped to `limit` rows starting at `offset` so a several-
/// thousand-video library never has to be pulled into memory at once. Returns the page of videos
/// alongside the total count of rows matching the filters (ignoring limit/offset), which the
/// frontend uses for "X of Y results" and to know whether there's another page to load.
/// `include_content` gates whether transcript/summary text is decoded and returned at all — pass
/// `false` for grid/list views that only need metadata and the has_transcript/has_summary flags.
pub fn list_videos(
    db_path: &str,
    video_type_filter: Option<&str>,
    filter_kind: Option<&str>,
    sort_field: Option<&str>,
    sort_order: Option<&str>,
    limit: i64,
    offset: i64,
    include_content: bool,
) -> Result<(Vec<Video>, i64)> {
    let conn = Connection::open(db_path)?;

    let video_type_where = match video_type_filter {
        Some("short") => "video_type = 'short'",
        Some("standard") => "video_type = 'standard'",
        _ => "1=1",
    };
    let filter_where = filter_kind_where("", filter_kind);
    let where_sql = format!("{video_type_where} AND {filter_where}");

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM videos WHERE {where_sql}"),
        [],
        |row| row.get(0),
    )?;

    let columns = video_columns_sql("");
    let order = library_order_by("", sort_field, sort_order);
    let query = format!(
        "SELECT {columns} FROM videos WHERE {where_sql} ORDER BY {order} LIMIT ?1 OFFSET ?2"
    );

    let mut stmt = conn.prepare(&query)?;
    let video_iter = stmt.query_map(params![limit, offset], |row| video_row(row, include_content))?;

    let mut videos = Vec::new();
    for video in video_iter {
        videos.push(video?);
    }
    Ok((videos, total))
}

/// Upserts a video's metadata and transcript. On conflict, `summary` only overwrites the
/// existing value when `Some` — passing `None` preserves whatever summary was already saved,
/// so callers that don't have a fresh summary in hand (e.g. a plain re-save) can't wipe one out.
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

/// Deletes a video by id. The FTS-index cleanup and biography cascade-delete happen via
/// SQLite triggers (see db/schema.rs), not here.
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

/// Fetches full video details as a fixed-order tuple: (video_id, title, author, length_seconds,
/// transcript, view_count, published_at, handle, video_type, date_added, summary, tags).
/// Callers index into it positionally (see e.g. commands/youtube.rs's save_video and
/// ollama::summarize_transcript) — keep that order in sync with any change here.
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
            row.get::<_, Option<i32>>(3).unwrap_or(None).unwrap_or(0),
            row.get::<_, Option<String>>(4)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<i64>>(5).unwrap_or(None).unwrap_or(0),
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

/// Counts videos matching an optional type filter and an optional case-sensitive substring
/// match across title/author/handle/transcript (manually escaped and inlined into the query,
/// not parameterized, since the LIKE pattern itself is built per-column here).
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
