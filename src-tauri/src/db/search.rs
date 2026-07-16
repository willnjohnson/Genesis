use crate::Video;
use regex::Regex;
use rusqlite::{params, Connection, Result};
use super::summaries::has_real_summary;

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
pub(crate) fn regenerate_tokens_from_transcript(conn: &Connection, video_id: &str) -> Result<()> {
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
