use crate::Video;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::collections::HashSet;
use super::summaries::has_real_summary;

// Canonical column order for every video_row() caller, as a single source of truth: video_id,
// title, author, handle, length_seconds, transcript, view_count, published_at, date_added, tags,
// summary, has_transcript, has_summary. `alias` is an optional table-alias prefix (e.g. "v.") for
// queries that join against other tables; pass "" for a plain single-table SELECT. Used by
// search_library_videos below and by db::videos::list_videos.
pub(crate) fn video_columns_sql(alias: &str) -> String {
    let cols = [
        "video_id", "title", "author", "handle", "length_seconds", "transcript",
        "view_count", "published_at", "date_added", "tags", "summary", "WDBS",
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
    let raw_summary: Option<String> = row.get(10).unwrap_or(None);
    Ok(Video {
        id: row.get::<_, String>(0).unwrap_or_default(),
        title: row.get::<_, Option<String>>(1).unwrap_or(None).unwrap_or_else(|| "Unknown".to_string()),
        author: row.get::<_, Option<String>>(2).unwrap_or(None),
        length_seconds: row.get::<_, Option<i32>>(4).unwrap_or(None),
        view_count: view_count_str,
        thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", row.get::<_, String>(0).unwrap_or_default()),
        published_at: row.get::<_, Option<String>>(7).unwrap_or(None).unwrap_or_else(|| "".to_string()),
        status: Some("saved".to_string()),
        date_added: row.get::<_, Option<String>>(8).unwrap_or(None),
        handle: row.get::<_, Option<String>>(3).unwrap_or(None),
        transcript: if include_content { row.get::<_, Option<String>>(5).unwrap_or(None) } else { None },
        tags: row.get::<_, Option<String>>(9).unwrap_or(None),
        summary: if include_content { raw_summary.clone() } else { None },
        wdbs: row.get::<_, Option<String>>(11).unwrap_or(None),
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

// Builds an FTS5 MATCH expression from free-text search words: each word gets a trailing '*' for
// prefix matching, and words containing FTS5-special characters get quoted. A word starting with
// ':' is a Warp Drive designator (e.g. ":UAP", either leftmost by convention or anywhere in the
// query — see the search revision doc) and gets translated into the storage encoding the WDBS
// column actually uses (':' -> 'θψ', '-' -> '_'), e.g. ":UAP-GERB-VVV" -> "θψUAP_GERB_VVV*". A
// bare ':' means "Universe" (no restriction), which is redundant with an unfiltered search, so
// it's dropped rather than turned into a dead θψ* term. Shared by search_library_videos and
// db::wdbs::list_videos_by_wdbs (searching within one Warp Drive category — see App.tsx's Drive
// panel toggle). Returns "" when there's nothing left to match on, which callers must treat as
// "skip the FTS5 MATCH entirely" — FTS5 rejects an empty MATCH string as a syntax error rather
// than treating it as "match everything".
pub(crate) fn build_fts_query(free_text: &str) -> String {
    free_text
        .split_whitespace()
        .filter_map(|w| {
            if let Some(rest) = w.strip_prefix(':') {
                if rest.is_empty() {
                    return None;
                }
                let encoded = rest.replace('-', "_");
                return Some(format!("θψ{}*", encoded));
            }
            Some(if w.chars().any(|c| matches!(c, '"' | '*' | '(' | ')' | '-' | '+' | '~' | ' ')) {
                format!("\"{}\"*", w.replace('"', "\"\""))
            } else {
                format!("{}*", w)
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
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
/// `limit`/`offset` drive Library grid pagination (300 rows per page, "load more" on scroll);
/// `filter_kind`/`sort_field`/`sort_order` mirror the grid's filter/sort buttons so results stay
/// consistent with whatever the user had selected, including while a free-text search is active.
pub fn search_library_videos(
    db_path: &str,
    query: &str,
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

    let filter_where = filter_kind_where("v.", filter_kind);
    let columns = video_columns_sql("v.");
    let order = library_order_by("v.", sort_field, sort_order);

    // Exact match compares against the tag list wrapped in delimiters (",tag1,tag2,") so a
    // pattern of "%,<value>,%" only matches a whole tag, not a substring spanning two tags or a
    // partial word within one; contains-match is the existing plain substring LIKE. SQLite's
    // LIKE is case-insensitive for ASCII by default, which covers the "ignoring casing" ask.
    let tag_col = if tag_exact { "(',' || v.tags || ',')" } else { "v.tags" };
    let tag_pattern = |v: &str| if tag_exact { format!("%,{},%", v) } else { format!("%{}%", v) };

    let fts_query = build_fts_query(free_text);

    let mut videos = Vec::new();
    let total: i64;

    if fts_query.is_empty() {
        // No free-text search term left to match on (e.g. a bare handle:/video:/tag_search:
        // facet, or a query of just ":") — skip the FTS5 MATCH entirely rather than passing it
        // an empty/wildcard query, which FTS5 rejects as a syntax error and would otherwise fail
        // the whole search.
        let where_sql = format!(
            "(?1 = '' OR v.handle LIKE ?2)
               AND (?3 = '' OR v.video_id LIKE ?4)
               AND (?5 = '' OR {tag_col} LIKE ?6)
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
        let where_sql = format!(
            "ftsVideos MATCH ?1
               AND (?2 = '' OR v.handle LIKE ?3)
               AND (?4 = '' OR v.video_id LIKE ?5)
               AND (?6 = '' OR {tag_col} LIKE ?7)
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
            AND word NOT IN (SELECT culls FROM stop_words)
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

// Lowercases, replaces every non-alphanumeric character with a space, and splits on whitespace —
// the same cleaning `regenerate_tokens_from_transcript` applies to transcript words, reused here
// for title/name text that never goes through that SQL pipeline.
fn clean_words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|w| w.to_string())
        .collect()
}

/// "More like this": finds other videos similar to `video_id` by BM25-ranking the `ftsVideos`
/// index against a term list built from the seed video's own `tokens` (transcript-derived,
/// already deduped/stopword-filtered) and title words, then moving any candidate that shares a
/// curated glossary tag with the seed ahead of ones that don't (see the tag-tiering step below).
/// The seed's own author/handle words are excluded from that term list — without this, two videos
/// from the same channel would often look "similar" purely because the channel's own name is
/// repeated in both (self-intros, outros), which isn't real topical similarity. Needs no
/// precomputed/stored state: it's a live query against the same FTS5 index regular search already
/// uses, so a newly added video is eligible the instant its `ftsVideos` row exists, same as search
/// results are.
pub fn get_similar_videos(db_path: &str, video_id: &str, limit: i64) -> Result<Vec<Video>> {
    let conn = Connection::open(db_path)?;

    let seed = conn
        .query_row(
            "SELECT tokens, title, author, handle, tags FROM videos WHERE video_id = ?1",
            params![video_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                ))
            },
        )
        .optional()?;
    let Some((tokens, title, author, handle, seed_tags_raw)) = seed else {
        return Ok(vec![]);
    };
    let seed_tags: HashSet<String> = seed_tags_raw.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();

    // The seed's own channel name (both fields, since either can be set independently) — every
    // word of it is excluded from the term list below.
    let mut exclude: HashSet<String> = HashSet::new();
    for name in [author.as_deref(), handle.as_deref()].into_iter().flatten() {
        exclude.extend(clean_words(name));
    }

    let stopwords: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT culls FROM stop_words")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let collected: HashSet<String> = rows.filter_map(|r| r.ok()).collect();
        collected
    };

    // `tokens` is already clean/deduped/stopword-filtered by regenerate_tokens_from_transcript —
    // just split it. Title words get the same treatment inline since they never go through that
    // pipeline. No frequency/importance ordering survives the DISTINCT in `tokens`, so the MAX_TERMS
    // cap below takes an arbitrary subset rather than the "most distinctive" terms — bm25's own
    // IDF weighting during the actual MATCH is what does the real relevance work, so this bounds
    // query size without materially hurting ranking quality.
    const MAX_TERMS: usize = 100;
    let mut seen: HashSet<String> = HashSet::new();
    let mut terms: Vec<String> = Vec::new();
    for w in tokens.split_whitespace() {
        if terms.len() >= MAX_TERMS {
            break;
        }
        if exclude.contains(w) {
            continue;
        }
        if seen.insert(w.to_string()) {
            terms.push(w.to_string());
        }
    }
    for w in clean_words(&title) {
        if terms.len() >= MAX_TERMS {
            break;
        }
        if w.len() <= 2 || stopwords.contains(&w) || exclude.contains(&w) {
            continue;
        }
        if seen.insert(w.clone()) {
            terms.push(w);
        }
    }

    if terms.is_empty() {
        // No transcript and a too-short/generic title — nothing to match on. An empty FTS5 MATCH
        // string is a syntax error, not "match everything", so this must be skipped rather than
        // run (same rule build_fts_query's own docs call out).
        return Ok(vec![]);
    }

    let match_query = terms.join(" OR ");
    let columns = video_columns_sql("v.");
    // bm25() column weights follow ftsVideos' own column order (title, summary, tokens, WDBS):
    // a shared title word counts for more than a shared summary word, more than a shared
    // transcript token, and WDBS (a taxonomy code, not real language) is zeroed out entirely so
    // it can't coincidentally influence ranking. Lower bm25() is a better match, hence ASC.
    //
    // Pulls more candidates than `limit` so the tag-tiering step below has a real pool to promote
    // matches from — a candidate that shares a tag with the seed but ranks outside the top `limit`
    // on raw BM25 alone still needs to be in hand to be promoted ahead of ones that don't share a
    // tag. Bounded well below "the whole library" so this stays cheap regardless of `limit`.
    let overfetch = (limit.saturating_mul(5)).clamp(limit, 200);
    let sql = format!(
        "SELECT {columns}
         FROM videos AS v
         JOIN ftsVideos ON v.rowid = ftsVideos.rowid
         WHERE ftsVideos MATCH ?1 AND v.video_id != ?2
         ORDER BY bm25(ftsVideos, 2.0, 1.5, 1.0, 0.0) ASC
         LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let video_iter = stmt.query_map(params![match_query, video_id, overfetch], |row| video_row(row, false))?;
    let mut candidates = Vec::new();
    for v in video_iter {
        candidates.push(v?);
    }

    // A shared curated glossary tag is a stronger, human-judged similarity signal than incidental
    // keyword overlap — promote every tag-sharing candidate ahead of every non-sharing one.
    // `Iterator::partition` preserves relative order within each side, so the existing BM25 order
    // is kept as the tiebreaker inside both tiers.
    if !seed_tags.is_empty() {
        let (shares_tag, rest): (Vec<Video>, Vec<Video>) = candidates.into_iter().partition(|v| {
            v.tags
                .as_deref()
                .map(|t| t.split(',').any(|tag| seed_tags.contains(tag.trim())))
                .unwrap_or(false)
        });
        candidates = shares_tag.into_iter().chain(rest).collect();
    }

    candidates.truncate(limit as usize);
    Ok(candidates)
}

#[cfg(test)]
mod similar_videos_tests {
    use crate::db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db_path() -> String {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir()
            .join(format!("kinesis_similar_videos_test_{}.db", n))
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn excludes_shared_channel_name_but_ranks_real_topical_overlap() {
        let db_path = temp_db_path();
        db::init_db(&db_path).unwrap();

        // vidA and vidB are from the same channel and both repeat the channel's own name, but
        // are otherwise about unrelated topics — without excluding the channel name from the
        // match terms, that shared "Same Channel" mention alone would make them look similar.
        db::save_video(
            &db_path, "vidA", "Quantum Computing Basics", "Same Channel", 600,
            "Discussing quantum computing breakthroughs and quantum error correction algorithms with quantum bits. Same Channel here to explain more.",
            100, "2026-01-01T00:00:00Z", "@samechannel", None,
        ).unwrap();
        db::save_video(
            &db_path, "vidB", "Cooking Pasta Tonight", "Same Channel", 600,
            "Cooking a delicious pasta dinner tonight with fresh tomatoes and basil. Same Channel back again with another recipe.",
            100, "2026-01-02T00:00:00Z", "@samechannel", None,
        ).unwrap();
        // vidC is from a different channel entirely but genuinely overlaps with vidA's topic.
        db::save_video(
            &db_path, "vidC", "Quantum Error Correction Explained", "Different Creator", 600,
            "Quantum computing is advancing fast, with new quantum error correction techniques emerging using quantum bits every year.",
            100, "2026-01-03T00:00:00Z", "@differentcreator", None,
        ).unwrap();
        // vidD has no transcript and no title — nothing to match on at all.
        db::save_video(&db_path, "vidD", "", "Nobody", 0, "", 0, "2026-01-04T00:00:00Z", "", None).unwrap();

        let results = db::get_similar_videos(&db_path, "vidA", 10).unwrap();
        let ids: Vec<&str> = results.iter().map(|v| v.id.as_str()).collect();

        assert!(ids.contains(&"vidC"), "a genuinely topical overlap should surface as similar: {:?}", ids);
        assert!(!ids.contains(&"vidB"), "sharing only the channel's own repeated name shouldn't count as similar: {:?}", ids);
        assert!(!ids.contains(&"vidA"), "the seed video should never recommend itself");

        let empty = db::get_similar_videos(&db_path, "vidD", 10).unwrap();
        assert!(empty.is_empty(), "a video with no transcript/title and nothing to match on should return an empty list, not error");

        std::fs::remove_file(&db_path).ok();
    }

    #[test]
    fn shared_glossary_tag_outranks_stronger_raw_keyword_overlap() {
        let db_path = temp_db_path();
        db::init_db(&db_path).unwrap();

        // vidA is the seed, tagged "Quantum Computing".
        db::save_video(
            &db_path, "vidA", "Quantum Computing Basics", "Creator A", 600,
            "Quantum computing involves qubits entanglement superposition decoherence algorithms correction circuits gates processors.",
            100, "2026-01-01T00:00:00Z", "@creatora", None,
        ).unwrap();
        db::save_tags(&db_path, "vidA", "Quantum Computing").unwrap();

        // vidE shares far more raw vocabulary with vidA (would win on BM25 alone) but has no tags.
        db::save_video(
            &db_path, "vidE", "Deep Dive", "Creator E", 600,
            "Quantum computing involves qubits entanglement superposition decoherence algorithms correction circuits gates processors technology.",
            100, "2026-01-02T00:00:00Z", "@creatore", None,
        ).unwrap();

        // vidF shares much less raw vocabulary with vidA, but carries the same curated tag.
        db::save_video(
            &db_path, "vidF", "Beginner Concepts", "Creator F", 600,
            "Qubits and superposition are core quantum computing concepts explained simply for beginners.",
            100, "2026-01-03T00:00:00Z", "@creatorf", None,
        ).unwrap();
        db::save_tags(&db_path, "vidF", "Quantum Computing").unwrap();

        let results = db::get_similar_videos(&db_path, "vidA", 10).unwrap();
        let ids: Vec<&str> = results.iter().map(|v| v.id.as_str()).collect();
        let pos_e = ids.iter().position(|&id| id == "vidE");
        let pos_f = ids.iter().position(|&id| id == "vidF");

        assert!(pos_e.is_some() && pos_f.is_some(), "both candidates should be found: {:?}", ids);
        assert!(pos_f < pos_e, "a shared curated tag should outrank stronger raw keyword overlap alone: {:?}", ids);

        std::fs::remove_file(&db_path).ok();
    }
}
