use crate::Video;
use regex::Regex;
use rusqlite::{params, Connection, Result};
use super::summaries::has_real_summary;

// Canonical column order for every video_row() caller, as a single source of truth: video_id,
// title, author, handle, length_seconds, transcript, view_count, published_at, video_type,
// date_added, tags, summary, has_transcript, has_summary. `alias` is an optional table-alias
// prefix (e.g. "v.") for queries that join against other tables; pass "" for a plain single-table
// SELECT. Used by search_library_videos below and by db::videos::list_videos.
pub(crate) fn video_columns_sql(alias: &str) -> String {
    let cols = [
        "video_id", "title", "author", "handle", "length_seconds", "transcript",
        "view_count", "published_at", "video_type", "date_added", "tags", "summary",
    ];
    let prefixed = cols.iter().map(|c| format!("{alias}{c}")).collect::<Vec<_>>().join(", ");
    format!(
        "{prefixed}, \
         CASE WHEN {alias}transcript IS NOT NULL AND {alias}transcript != '' AND {alias}transcript != 'N/A' THEN 1 ELSE 0 END AS has_transcript, \
         CASE WHEN {alias}summary IS NOT NULL AND {alias}summary != '' THEN 1 ELSE 0 END AS has_summary"
    )
}

// Row-mapper matching the column order built by video_columns_sql above.
//
// `include_content` gates whether the transcript/summary text is exposed on the returned Video.
// summary is still always decoded from the row (has_summary needs it regardless of the flag);
// transcript is only decoded when requested, since it can be far larger and has_transcript is
// derived from the precomputed SQL column, not from the transcript text itself.
pub(crate) fn video_row(row: &rusqlite::Row, include_content: bool) -> rusqlite::Result<Video> {
    let view_count_str = match row.get::<_, Option<i64>>(6).unwrap_or(None) {
        Some(0) | None => "Saved".to_string(),
        Some(n) => n.to_string(),
    };
    let raw_summary: Option<String> = row.get(11).unwrap_or(None);
    Ok(Video {
        id: row.get::<_, String>(0).unwrap_or_default(),
        title: row.get::<_, Option<String>>(1).unwrap_or(None).unwrap_or_else(|| "Unknown".to_string()),
        author: row.get::<_, Option<String>>(2).unwrap_or(None),
        length_seconds: row.get::<_, Option<i32>>(4).unwrap_or(None),
        view_count: view_count_str,
        thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", row.get::<_, String>(0).unwrap_or_default()),
        published_at: row.get::<_, Option<String>>(7).unwrap_or(None).unwrap_or_else(|| "".to_string()),
        status: Some("saved".to_string()),
        date_added: row.get::<_, Option<String>>(9).unwrap_or(None),
        handle: row.get::<_, Option<String>>(3).unwrap_or(None),
        video_type: row.get::<_, Option<String>>(8).unwrap_or(None),
        transcript: if include_content { row.get::<_, Option<String>>(5).unwrap_or(None) } else { None },
        tags: row.get::<_, Option<String>>(10).unwrap_or(None),
        summary: if include_content { raw_summary.clone() } else { None },
        has_transcript: Some(row.get::<_, i64>(12).unwrap_or(0) > 0),
        has_summary: Some(raw_summary.as_deref().map(has_real_summary).unwrap_or(false)),
    })
}

// SQL boolean expression (against the `summary` column on `alias`) mirroring
// `summaries::has_real_summary()`: true when there's non-whitespace content before any
// "Channel Info: ..." footer that append_channel_info_footer() appends. Needed because the
// `has_summary` column produced by video_columns_sql() above only checks non-empty, not "real".
// SQLite's TRIM(X) with no second argument only strips literal space characters, not newlines —
// a footer-only summary (e.g. "\n\nChannel Info: Name") leaves a "\n\n" remainder that TRIM
// wouldn't touch, so this must pass an explicit strip-set covering space/newline/CR/tab or every
// footer-only summary reads as "has real content" and both filter buttons below break.
fn has_real_summary_sql(alias: &str) -> String {
    format!(
        "TRIM(SUBSTR(COALESCE({alias}summary, ''), 1, \
         CASE WHEN INSTR(COALESCE({alias}summary, ''), 'Channel Info:') > 0 \
              THEN INSTR(COALESCE({alias}summary, ''), 'Channel Info:') - 1 \
              ELSE LENGTH(COALESCE({alias}summary, '')) END), ' ' || CHAR(10) || CHAR(13) || CHAR(9)) != ''"
    )
}

// WHERE-clause fragment for the Library grid's All Videos / Transcript Only / With AI Summary
// filter buttons (`filter_kind`: None/"all", "transcript", "summary"). 'N/A' is the sentinel
// clear_transcript_after_summary() writes once a real summary exists — it's not real transcript
// content, so it must be excluded here the same way regenerate_tokens_from_transcript already does.
pub(crate) fn filter_kind_where(alias: &str, filter_kind: Option<&str>) -> String {
    match filter_kind {
        Some("transcript") => format!(
            "(({alias}transcript IS NOT NULL AND {alias}transcript != '' AND {alias}transcript != 'N/A') AND NOT ({}))",
            has_real_summary_sql(alias)
        ),
        Some("summary") => has_real_summary_sql(alias),
        _ => "1=1".to_string(),
    }
}

// ORDER BY clause for the Library grid's Date Added / Date Bookmarked / Views sort buttons.
// `sort_field`: "added" -> date_added (bookmark time), "popularity" -> view_count, otherwise
// (None/"date") -> published_at (YouTube's publish date). Ties break on rowid so pagination
// (LIMIT/OFFSET) across pages stays stable.
pub(crate) fn library_order_by(alias: &str, sort_field: Option<&str>, sort_order: Option<&str>) -> String {
    let col = match sort_field {
        Some("added") => "date_added",
        Some("popularity") => "view_count",
        _ => "published_at",
    };
    let dir = if sort_order == Some("asc") { "ASC" } else { "DESC" };
    format!("{alias}{col} {dir}, {alias}rowid {dir}")
}

/// Paged/sorted/filtered library search. Returns `(videos for this page, total matching count)`.
/// `limit`/`offset` drive Library grid pagination (100 rows per page, "load more" on scroll);
/// `filter_kind`/`sort_field`/`sort_order` mirror the grid's filter/sort buttons so results stay
/// consistent with whatever the user had selected, including while a free-text search is active.
pub fn search_library_videos(
    db_path: &str,
    query: &str,
    video_type_filter: Option<&str>,
    filter_kind: Option<&str>,
    sort_field: Option<&str>,
    sort_order: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<(Vec<Video>, i64)> {
    let conn = Connection::open(db_path)?;

    let facet_re = Regex::new(r#"([a-z_]+):(?:"([^"]*)"|([^ ]*))"#).unwrap();
    let mut handle_val = "";
    let mut video_val = "";
    let mut tag_val = "";
    // tag_search:"exact tag" (quoted) means an exact, case-insensitive match against one of the
    // video's comma-separated tags; tag_search:contains (bare) means a substring match — the
    // same quoted-vs-bare distinction every other facet value already gets from this regex's two
    // capture groups. Replaces the old trailing-`#` convention.
    let mut tag_exact = false;
    let mut remaining = query.to_string();

    for cap in facet_re.captures_iter(query) {
        let facet_type = &cap[1];
        let quoted = cap.get(2).map(|m| m.as_str());
        let value = quoted.unwrap_or_else(|| cap.get(3).map(|m| m.as_str()).unwrap_or(""));
        match facet_type {
            "handle" => handle_val = value,
            "video" => video_val = value,
            "tag_search" => {
                tag_val = value;
                tag_exact = quoted.is_some();
            }
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
    let filter_where = filter_kind_where("v.", filter_kind);
    let columns = video_columns_sql("v.");
    let order = library_order_by("v.", sort_field, sort_order);

    // Exact match compares against the tag list wrapped in delimiters (",tag1,tag2,") so a
    // pattern of "%,<value>,%" only matches a whole tag, not a substring spanning two tags or a
    // partial word within one; contains-match is the existing plain substring LIKE. SQLite's
    // LIKE is case-insensitive for ASCII by default, which covers the "ignoring casing" ask.
    let tag_col = if tag_exact { "(',' || v.tags || ',')" } else { "v.tags" };
    let tag_pattern = |v: &str| if tag_exact { format!("%,{},%", v) } else { format!("%{}%", v) };

    let mut videos = Vec::new();
    let total: i64;

    if free_text.is_empty() {
        // No free-text search term (e.g. a bare handle:/video:/tag_search: facet) — skip the
        // FTS5 MATCH entirely rather than passing it an empty/wildcard query, which FTS5
        // rejects as a syntax error and would otherwise fail the whole search.
        let where_sql = format!(
            "(?1 = '' OR v.handle LIKE ?2)
               AND (?3 = '' OR v.video_id LIKE ?4)
               AND (?5 = '' OR {tag_col} LIKE ?6)
               AND {video_type_where}
               AND {filter_where}"
        );
        let count_sql = format!("SELECT COUNT(*) FROM videos AS v WHERE {where_sql}");
        total = conn.query_row(
            &count_sql,
            params![
                handle_val, format!("%{}%", handle_val),
                video_val, format!("%{}%", video_val),
                tag_val, tag_pattern(tag_val)
            ],
            |row| row.get(0),
        )?;

        let sql = format!(
            "SELECT {columns} FROM videos AS v WHERE {where_sql} ORDER BY {order} LIMIT ?7 OFFSET ?8"
        );
        let mut stmt = conn.prepare(&sql)?;
        let video_iter = stmt.query_map(
            params![
                handle_val, format!("%{}%", handle_val),
                video_val, format!("%{}%", video_val),
                tag_val, tag_pattern(tag_val),
                limit, offset
            ],
            |row| video_row(row, true),
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

        let where_sql = format!(
            "ftsVideos MATCH ?1
               AND (?2 = '' OR v.handle LIKE ?3)
               AND (?4 = '' OR v.video_id LIKE ?5)
               AND (?6 = '' OR {tag_col} LIKE ?7)
               AND {video_type_where}
               AND {filter_where}"
        );
        let count_sql = format!(
            "SELECT COUNT(*) FROM videos AS v JOIN ftsVideos ON v.rowid = ftsVideos.rowid WHERE {where_sql}"
        );
        total = conn.query_row(
            &count_sql,
            params![
                fts_query,
                handle_val, format!("%{}%", handle_val),
                video_val, format!("%{}%", video_val),
                tag_val, tag_pattern(tag_val)
            ],
            |row| row.get(0),
        )?;

        let sql = format!(
            "SELECT {columns}
             FROM videos AS v
             JOIN ftsVideos ON v.rowid = ftsVideos.rowid
             WHERE {where_sql}
             ORDER BY {order}
             LIMIT ?8 OFFSET ?9"
        );
        let mut stmt = conn.prepare(&sql)?;
        let video_iter = stmt.query_map(
            params![
                fts_query,
                handle_val, format!("%{}%", handle_val),
                video_val, format!("%{}%", video_val),
                tag_val, tag_pattern(tag_val),
                limit, offset
            ],
            |row| video_row(row, true),
        )?;
        for video in video_iter {
            videos.push(video?);
        }
    }

    Ok((videos, total))
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
