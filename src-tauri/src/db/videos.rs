use crate::{Video, types::normalize_published_at};
use rusqlite::{params, Connection, OptionalExtension, Result};
use super::summaries::{append_channel_info_footer, clean_blockquote_lines, clear_transcript_after_summary, has_real_summary};
use super::settings::get_setting_bool;
use super::search::{regenerate_tokens_from_transcript, video_row, video_columns_sql, filter_kind_where, library_order_by};

/// Pages the Library grid: optionally filtered by `filter_kind` ("transcript"/"summary"/
/// None-or-"all"), ordered per `sort_field`/`sort_order` (see `library_order_by`), and capped to
/// `limit` rows starting at `offset` so a several-thousand-video library never has to be pulled
/// into memory at once. Returns the page of videos alongside the total count of rows matching the
/// filters (ignoring limit/offset), which the frontend uses for "X of Y results" and to know
/// whether there's another page to load. `include_content` gates whether transcript/summary text
/// is decoded and returned at all — pass `false` for grid/list views that only need metadata and
/// the has_transcript/has_summary flags.
pub fn list_videos(
    db_path: &str,
    filter_kind: Option<&str>,
    sort_field: Option<&str>,
    sort_order: Option<&str>,
    limit: i64,
    offset: i64,
    include_content: bool,
) -> Result<(Vec<Video>, i64)> {
    let conn = Connection::open(db_path)?;

    let where_sql = filter_kind_where("", filter_kind);

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM Videos WHERE {where_sql}"),
        [],
        |row| row.get(0),
    )?;

    let columns = video_columns_sql("");
    let order = library_order_by("", sort_field, sort_order);
    let query = format!(
        "SELECT {columns} FROM Videos WHERE {where_sql} ORDER BY {order} LIMIT ?1 OFFSET ?2"
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
    summary: Option<&str>,
) -> Result<()> {
    let video_id = video_id.trim();
    let published_at = normalize_published_at(published_at);
    let conn = Connection::open(db_path)?;
    // Update first, insert only when there's no such video. An upsert (INSERT .. ON CONFLICT DO UPDATE)
    // can't be used: the production database's BEFORE INSERT trigger (trgVideosBeforeINS_Videos_SyncBioHandle)
    // re-inserts the row itself and cancels the original, so for a video that already exists the
    // ON CONFLICT clause never gets a say and the re-insert fails with a UNIQUE violation.
    let updated = conn.execute(
        "UPDATE Videos SET
            title=?2,
            author=?3,
            length_seconds=?4,
            transcript=?5,
            view_count=?6,
            published_at=?7,
            handle=?8,
            summary=COALESCE(?9, summary)
         WHERE video_id=?1",
        params![video_id, title, author, length, transcript, view_count, published_at, handle, summary],
    )?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO Videos (video_id, title, author, length_seconds, transcript, view_count, published_at, handle, summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![video_id, title, author, length, transcript, view_count, published_at, handle, summary],
        )?;
    }
    // The production database's own INSERT trigger defaults a new video's WDBS to the raw "θψ"
    // prefix marker when it can't infer anything smarter (see the schema handoff doc). Since
    // "θψ" is alphabetic and also the universal prefix every real WDBS value starts with, FTS5
    // indexes it as a literal searchable term that matches every video — normalizing it to ":"
    // (punctuation, not indexed at all) right after save keeps new videos from re-introducing the
    // problem the one-time migration in schema.rs::init_db already cleaned up for existing ones.
    // Cheap: video_id is the primary key, so this never scans the table.
    let _ = conn.execute(
        "UPDATE Videos SET WDBS = ':' WHERE video_id = ?1 AND WDBS = 'θψ'",
        params![video_id],
    );
    regenerate_tokens_from_transcript(&conn, video_id)?;
    // Covers the "summarize before saving" workflow: a real summary can already be provided
    // at insert time, so it needs the same quote-marker cleanup applied on later saves.
    clean_blockquote_lines(&conn, video_id)?;
    append_channel_info_footer(&conn, video_id)?;
    if summary.map(has_real_summary).unwrap_or(false) && get_setting_bool(&conn, "setTranscriptAfterSummarizeToNA") {
        clear_transcript_after_summary(&conn, video_id)?;
    }
    Ok(())
}

/// Deletes a video by id. The FTS-index cleanup and biography cascade-delete happen via
/// SQLite triggers (see db/schema.rs), not here. Links to the video (and to its channel's
/// biography, if that went with it) are removed from the text that held them, see db/links.rs.
pub fn delete_video(db_path: &str, video_id: &str) -> Result<()> {
    use super::links::{apply_link_edits, LinkEdit, LinkKind};
    let conn = Connection::open(db_path)?;
    let handle: Option<String> = conn
        .query_row("SELECT handle FROM Videos WHERE video_id = ?", params![video_id], |r| r.get(0))
        .optional()?
        .flatten();
    conn.execute("DELETE FROM Videos WHERE video_id = ?", params![video_id])?;

    let mut edits = vec![LinkEdit::Unlink(LinkKind::Video, video_id.to_string())];
    if let Some(handle) = handle.filter(|h| !h.trim().is_empty()) {
        let bio_remains: bool = conn
            .query_row(
                "SELECT 1 FROM Biographies WHERE lower(handle) = lower(?)",
                params![handle],
                |_| Ok(()),
            )
            .optional()
            .unwrap_or(None)
            .is_some();
        if !bio_remains {
            edits.push(LinkEdit::Unlink(LinkKind::Bio, handle));
        }
    }
    drop(conn);
    // The delete itself has succeeded; a failure tidying links must not undo or hide that.
    if let Err(e) = apply_link_edits(db_path, &edits) {
        log::warn!("Couldn't remove links to deleted video {video_id}: {e}");
    }
    Ok(())
}

/// One saved video by id, or None when it isn't in the library.
pub fn get_video_by_id(db_path: &str, video_id: &str, include_content: bool) -> Result<Option<Video>> {
    let conn = Connection::open(db_path)?;
    let columns = video_columns_sql("");
    conn.query_row(
        &format!("SELECT {columns} FROM Videos WHERE video_id = ?1"),
        params![video_id.trim()],
        |row| video_row(row, include_content),
    )
    .optional()
}

pub fn check_video_exists(db_path: &str, video_id: &str) -> Result<bool> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT 1 FROM Videos WHERE video_id = ?")?;
    let mut rows = stmt.query(params![video_id])?;
    Ok(rows.next()?.is_some())
}

pub fn get_transcript(db_path: &str, video_id: &str) -> Result<Option<String>> {
    let video_id = video_id.trim();
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT transcript FROM Videos WHERE video_id = ?")?;
    let mut rows = stmt.query(params![video_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

/// Fetches full video details as a fixed-order tuple: (video_id, title, author, length_seconds,
/// transcript, view_count, published_at, handle, date_added, summary, tags). Callers index into
/// it positionally (see e.g. commands/youtube.rs's save_video and ollama::summarize_transcript)
/// — keep that order in sync with any change here.
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
    )>,
> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT video_id, title, author, length_seconds, transcript, view_count, published_at, handle, date_added, summary, tags FROM Videos WHERE video_id = ?")?;
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
                .unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<String>>(9)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
            row.get::<_, Option<String>>(10)
                .unwrap_or(None)
                .unwrap_or_else(|| "".to_string()),
        )))
    } else {
        Ok(None)
    }
}

pub fn get_db_stats(db_path: &str) -> Result<i64> {
    get_video_count(db_path, None)
}

/// What the library holds, for Settings > Database.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct LibraryStats {
    pub channel_count: i64,
    /// Every Drive entry at any depth, counting the levels above an assigned one too (a video in
    /// ":UAP-GERB" makes both ":UAP" and ":UAP-GERB" exist). The unassigned placeholder isn't one.
    pub drive_count: i64,
    /// Standard Glossary Tags (with a definition) and Quick Tags (without), counted separately.
    pub glossary_count: i64,
    pub quick_tag_count: i64,
    pub biography_count: i64,
    pub attachment_count: i64,
    /// What attachments take up in the database (after compression), each distinct file once.
    pub attachment_bytes: i64,
}

pub fn get_library_stats(db_path: &str) -> Result<LibraryStats> {
    let conn = Connection::open(db_path)?;
    // A table that isn't there (an older or hand-made database) counts as empty.
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0) };

    let mut drives: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut paths: Vec<String> = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT WDBS FROM Videos WHERE WDBS IS NOT NULL AND WDBS != ''
         UNION SELECT wdbs FROM VideoWDBSLinks WHERE wdbs != ''",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            paths.extend(rows.filter_map(|r| r.ok()));
        }
    }
    for path in paths {
        if super::wdbs::is_unassigned_sentinel(&path) {
            continue;
        }
        let body = path.strip_prefix("θψ").unwrap_or(&path);
        let mut prefix = String::new();
        for segment in body.split('_').filter(|s| !s.is_empty()) {
            if !prefix.is_empty() {
                prefix.push('_');
            }
            prefix.push_str(segment);
            drives.insert(prefix.clone());
        }
    }

    Ok(LibraryStats {
        channel_count: count("SELECT COUNT(DISTINCT LOWER(LTRIM(handle, '@'))) FROM Videos WHERE handle IS NOT NULL AND TRIM(handle, '@ ') != ''"),
        drive_count: drives.len() as i64,
        glossary_count: count("SELECT COUNT(*) FROM Glossary WHERE TRIM(definition) != ''"),
        quick_tag_count: count("SELECT COUNT(*) FROM Glossary WHERE TRIM(definition) = ''"),
        biography_count: count("SELECT COUNT(*) FROM Biographies"),
        attachment_count: count("SELECT COUNT(*) FROM VideoAttachments"),
        attachment_bytes: count("SELECT COALESCE(SUM(stored_size), 0) FROM AttachmentBlobs"),
    })
}

#[cfg(test)]
mod library_stats_tests {
    use super::*;
    use crate::db::{add_video_wdbs_link, init_db, update_video_wdbs};

    #[test]
    fn counts_what_the_library_holds() {
        let path = std::env::temp_dir().join(format!("kinesis_libstats_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = path.to_string_lossy().to_string();
        init_db(&db).unwrap();
        assert_eq!(get_library_stats(&db).unwrap(), LibraryStats::default());

        for (id, handle) in [("a", "@One"), ("b", "@one"), ("c", "@Two"), ("d", "@Two")] {
            save_video(&db, id, id, "Author", 60, "words", 1, "2026-01-01T00:00:00Z", handle, None).unwrap();
        }
        update_video_wdbs(&db, "a", "θψUAP_GERB").unwrap();
        update_video_wdbs(&db, "b", "θψUAP").unwrap();
        update_video_wdbs(&db, "c", "θψCRYPTO_DOAC_X").unwrap();
        add_video_wdbs_link(&db, "a", "θψNEWS").unwrap();
        update_video_wdbs(&db, "d", ":").unwrap();

        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO Glossary (term, definition) VALUES ('Halving', 'Cuts rewards'), ('Blank', '  '), ('Quick', '')", []).unwrap();
        conn.execute("INSERT INTO Biographies (handle, display_name) VALUES ('@One', 'One')", []).unwrap();
        drop(conn);
        crate::db::attachments::add_attachment(&db, "a", "n.txt", b"hello ".repeat(100)).unwrap();

        let stats = get_library_stats(&db).unwrap();
        assert_eq!(stats.channel_count, 2, "@One and @one are one channel");
        // UAP, UAP_GERB, CRYPTO, CRYPTO_DOAC, CRYPTO_DOAC_X, NEWS. The ":" placeholder isn't one.
        assert_eq!(stats.drive_count, 6);
        assert_eq!(stats.glossary_count, 1);
        assert_eq!(stats.quick_tag_count, 2);
        assert_eq!(stats.biography_count, 1);
        assert_eq!(stats.attachment_count, 1);
        assert!(stats.attachment_bytes > 0 && stats.attachment_bytes < 600);
        let _ = std::fs::remove_file(&path);
    }
}

/// Counts videos matching an optional case-sensitive substring match across title/author/handle/
/// transcript (manually escaped and inlined into the query, not parameterized, since the LIKE
/// pattern itself is built per-column here).
pub fn get_video_count(
    db_path: &str,
    search_query: Option<&str>,
) -> Result<i64> {
    let conn = Connection::open(db_path)?;

    let search_where = match search_query {
        Some(q) if !q.is_empty() => {
            let escaped = q.replace('\'', "''");
            format!(
                "(title LIKE '%{}%' OR author LIKE '%{}%' OR handle LIKE '%{}%' OR transcript LIKE '%{}%')",
                escaped, escaped, escaped, escaped
            )
        }
        _ => "1=1".to_string(),
    };

    let query = format!("SELECT COUNT(*) FROM Videos WHERE {}", search_where);

    let mut stmt = conn.prepare(&query)?;
    let count: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(count)
}

pub fn save_transcript(db_path: &str, video_id: &str, transcript: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE Videos SET transcript = ?1 WHERE video_id = ?2",
        params![transcript, video_id],
    )?;
    regenerate_tokens_from_transcript(&conn, video_id)?;
    Ok(())
}

pub fn save_tags(db_path: &str, video_id: &str, tags: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE Videos SET tags = ?1 WHERE video_id = ?2",
        params![tags, video_id],
    )?;
    Ok(())
}

/// Updates a video's Warp Drive (WDBS) value. `encoded_wdbs` must already be in storage encoding
/// (θψ prefix, underscores — see commands::wdbs::encode_wdbs_display for the ':'/'-' -> 'θψ'/'_'
/// transform), or `":"` to clear it back to unassigned (see commands::wdbs::update_wdbs for why
/// ":" specifically). Deliberately takes `&str`, not `Option<&str>`: the production database's
/// WDBS column is NOT NULL (every video is always tied to at least "Universe"), so clearing must
/// write a real value rather than SQL NULL — a bare NULL trips that constraint even though "no
/// drive assigned" is otherwise a perfectly valid state. Returns whatever error SQLite raises as-is
/// (including a validating trigger's
/// RAISE(ABORT, ...) against the production tblWDBS schema) — the caller is responsible for
/// turning that into a user-friendly message (see commands::wdbs::update_wdbs), since this layer
/// has no way to know why a given value was rejected.
pub fn update_video_wdbs(db_path: &str, video_id: &str, encoded_wdbs: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE Videos SET WDBS = ?1 WHERE video_id = ?2",
        params![encoded_wdbs, video_id],
    )?;
    // Leaving a Drive takes the video out of that Drive's sequence.
    super::sequences::prune_video_memberships(db_path, video_id);
    Ok(())
}

pub fn get_unique_handles(db_path: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT DISTINCT handle FROM Videos WHERE handle IS NOT NULL AND handle != '' ORDER BY handle")?;
    let handles = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(handles)
}
