use rusqlite::{params, Connection, Result};
use super::settings::get_setting_bool;

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
pub(crate) fn append_channel_info_footer(conn: &Connection, video_id: &str) -> Result<()> {
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

pub fn save_summary(db_path: &str, video_id: &str, summary: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    // The caller's `summary` may already carry a "Channel Info:" footer — the edit-summary UI
    // round-trips the full displayed text (footer included) back through here. Strip it before
    // storing so append_channel_info_footer below adds exactly one fresh footer instead of the
    // old one getting duplicated alongside it.
    let bare_summary = match summary.find("Channel Info:") {
        Some(idx) => summary[..idx].trim_end(),
        None => summary,
    };
    conn.execute(
        "UPDATE videos SET summary = ?1 WHERE video_id = ?2",
        params![bare_summary, video_id],
    )?;
    // Some providers (e.g. Venice.ai) emit markdown blockquote lines with stray embedded
    // quote marks (`> "like this," he said`); strip quotes from just those lines.
    clean_blockquote_lines(&conn, video_id)?;
    // A video can be (re-)summarized before its channel's biography row exists yet, in which
    // case save_video's earlier attempt was a no-op; this retries it, deriving a fresh footer
    // from the current biography/author data every time.
    append_channel_info_footer(&conn, video_id)?;
    if has_real_summary(bare_summary) {
        if get_setting_bool(&conn, "setTranscriptAfterSummarizeToNA") {
            clear_transcript_after_summary(&conn, video_id)?;
        }
    } else {
        // The user wiped an existing summary back to empty: restore the transcript so they can
        // view/edit/re-fetch it, but only the 'N/A' placeholder clear_transcript_after_summary
        // itself wrote — never touch a transcript that's populated, or empty for some other
        // reason (e.g. mid re-fetch already).
        conn.execute(
            "UPDATE videos SET transcript = '' WHERE transcript = 'N/A' AND video_id = ?1",
            params![video_id],
        )?;
    }
    Ok(())
}

// Strips embedded `"` quote marks from any line of `summary` that starts with a markdown
// blockquote marker (`>`), leaving all other lines untouched. Splits on newlines via a
// recursive CTE (rowid-scoped to this one video), reassembles, and only writes back if the
// result actually differs from what's stored.
pub(crate) fn clean_blockquote_lines(conn: &Connection, video_id: &str) -> Result<()> {
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
pub(crate) fn clear_transcript_after_summary(conn: &Connection, video_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE videos SET transcript = 'N/A' WHERE video_id = ?1",
        params![video_id],
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
