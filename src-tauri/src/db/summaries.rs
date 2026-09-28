use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Result};
use super::links::{find_links, LinkKind};
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
        "UPDATE Videos AS a
         SET summary = IFNULL(a.summary, '') || (char(10) || char(10) || 'Channel Info: ' || src.name)
         FROM (
             SELECT v.video_id AS vid, COALESCE(NULLIF(TRIM(b.display_name), ''), v.author) AS name
             FROM Videos v
             LEFT JOIN Biographies b ON b.handle = v.handle
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
        "UPDATE Videos SET summary = ?1 WHERE video_id = ?2",
        params![bare_summary, video_id],
    )?;
    // A video can be (re-)summarized before its channel's biography row exists yet, in which
    // case save_video's earlier attempt was a no-op; this retries it, deriving a fresh footer
    // from the current biography/author data every time.
    append_channel_info_footer(&conn, video_id)?;
    sync_terms_from_video_text(&conn, video_id)?;
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
            "UPDATE Videos SET transcript = '' WHERE transcript = 'N/A' AND video_id = ?1",
            params![video_id],
        )?;
    }
    Ok(())
}

/// Every Glossary term name that has a real definition somewhere (in at least one Drive) — used
/// only by the one-time backfill below, to recognize a *legacy* hand-added Term (from before this
/// file existed, when the sidebar's "+" dropdown was the only way a Term-with-a-definition could
/// ever land in `Videos.tags`). Ongoing sync doesn't use this: see `sync_terms_from_video_text`'s
/// doc comment for why a definition check alone can't tell a Term from a Quick Tag in general.
fn term_names_with_definitions(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT term FROM Glossary WHERE TRIM(definition) <> ''")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// Every unique glossary key linked in `text`, in the order first seen.
fn glossary_links_in(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for link in find_links(text) {
        if link.kind == LinkKind::Glossary && seen.insert(link.key.clone()) {
            out.push(link.key);
        }
    }
    out
}

/// Applies `linked_now` (the current transcript+summary union, already deduped) to a video's
/// `Videos.tags`, using `VideoLinkedTerms` as the record of what a *previous* sync put there: a tag
/// only ever gets dropped here if it's in that record and no longer in `linked_now` — a same-named
/// genuine Quick Tag (never in `VideoLinkedTerms`) is never touched. Leaves `VideoLinkedTerms`
/// itself for the caller to update, since the one-time backfill needs one extra step first (see
/// `backfill_terms_from_summaries`).
fn apply_linked_terms(conn: &Connection, video_id: &str, current: &str, previously_linked: &HashSet<String>, linked_now: &[String]) -> Result<()> {
    let linked_now_set: HashSet<&str> = linked_now.iter().map(|s| s.as_str()).collect();
    let current_tags: Vec<String> = current.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    let mut kept_tags: Vec<String> = current_tags
        .into_iter()
        .filter(|t| !previously_linked.contains(t) || linked_now_set.contains(t.as_str()))
        .collect();
    let mut present: HashSet<String> = kept_tags.iter().cloned().collect();
    for key in linked_now {
        if present.insert(key.clone()) {
            kept_tags.push(key.clone());
        }
    }
    let new_value = kept_tags.join(",");
    if new_value != current {
        conn.execute("UPDATE Videos SET tags = ?1 WHERE video_id = ?2", params![new_value, video_id])?;
    }
    Ok(())
}

fn set_linked_terms(conn: &Connection, video_id: &str, linked_now: &[String]) -> Result<()> {
    conn.execute("DELETE FROM VideoLinkedTerms WHERE video_id = ?1", params![video_id])?;
    for term in linked_now {
        conn.execute("INSERT INTO VideoLinkedTerms (video_id, term) VALUES (?1, ?2)", params![video_id, term])?;
    }
    Ok(())
}

/// Keeps a video's Term tags in exact lockstep with its transcript *and* AI Summary: the union of
/// every unique `[Text](kinesis://glossary/Key)` link across both texts becomes (or stays) a tag,
/// and any tag `VideoLinkedTerms` says a previous sync added that's no longer linked in either is
/// dropped. A same-named genuine Quick Tag is never touched, even with no Glossary definition of
/// its own — this doesn't lean on "has a definition" to tell the two apart (a term can perfectly
/// well be linked with no formal Glossary entry yet), it leans on `VideoLinkedTerms`'s actual record
/// of what sync itself put there. The sidebar's own Terms panel shows a further-scoped view of this
/// (only the links in whichever of the two is currently being read — see VideoTagsPanel.tsx), but
/// what's persisted here (and so what Library search/kinpak export/sync see) is the union, so a
/// term linked only in the transcript isn't invisible to them just because the summary tab happens
/// to be the one usually open. Reads both texts itself rather than taking one as a parameter, since
/// either one changing can change the union — called from `save_summary`, `save_transcript` and
/// `save_video` (every place either text is saved).
pub fn sync_terms_from_video_text(conn: &Connection, video_id: &str) -> Result<()> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT COALESCE(tags, ''), COALESCE(transcript, ''), COALESCE(summary, '') FROM Videos WHERE video_id = ?1",
            params![video_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((current, transcript, summary)) = row else { return Ok(()) };

    let mut seen = HashSet::new();
    let linked_now: Vec<String> = glossary_links_in(&transcript)
        .into_iter()
        .chain(glossary_links_in(&summary))
        .filter(|k| seen.insert(k.clone()))
        .collect();

    let mut stmt = conn.prepare("SELECT term FROM VideoLinkedTerms WHERE video_id = ?1")?;
    let previously_linked: HashSet<String> = stmt.query_map(params![video_id], |row| row.get(0))?.collect::<Result<_>>()?;
    drop(stmt);
    apply_linked_terms(conn, video_id, &current, &previously_linked, &linked_now)?;
    set_linked_terms(conn, video_id, &linked_now)?;
    Ok(())
}

/// One-time backfill (see the `migratedTermsFromSummaryLinks` gate in schema.rs): reconciles every
/// video's Term tags against its current transcript/AI Summary right away, rather than waiting for
/// either to be saved again. Two things only this (not the ongoing `sync_terms_from_video_text`)
/// needs to do, because it's the one moment `VideoLinkedTerms` doesn't have an answer yet:
/// - Retire a *legacy* hand-added Term (added through the sidebar's now-removed "+" dropdown, before
///   this file existed) that has no matching link in either text — recognized by having a real
///   Glossary definition, since that dropdown was the only way such a tag could ever have gotten
///   there. Left alone otherwise, it would linger forever: nothing else knows it was ever a Term.
/// - Seed each video's `VideoLinkedTerms` baseline from what's linked right now, so
///   `sync_terms_from_video_text` has real provenance to work from the next time either text saves.
pub fn backfill_terms_from_summaries(conn: &Connection) -> Result<()> {
    let has_definition = term_names_with_definitions(conn)?;
    let mut stmt = conn.prepare(
        "SELECT video_id, COALESCE(tags, ''), COALESCE(transcript, ''), COALESCE(summary, '') FROM Videos
         WHERE COALESCE(tags, '') <> '' OR COALESCE(summary, '') <> '' OR COALESCE(transcript, '') <> ''",
    )?;
    let rows: Vec<(String, String, String, String)> =
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?.collect::<Result<_>>()?;
    for (video_id, current, transcript, summary) in rows {
        let mut seen = HashSet::new();
        let linked_now: Vec<String> =
            glossary_links_in(&transcript).into_iter().chain(glossary_links_in(&summary)).filter(|k| seen.insert(k.clone())).collect();
        let linked_now_set: HashSet<&str> = linked_now.iter().map(|s| s.as_str()).collect();

        let current_tags: Vec<String> = current.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        let pruned: Vec<String> = current_tags.into_iter().filter(|t| !(has_definition.contains(t) && !linked_now_set.contains(t.as_str()))).collect();
        let pruned_value = pruned.join(",");
        if pruned_value != current {
            conn.execute("UPDATE Videos SET tags = ?1 WHERE video_id = ?2", params![pruned_value, video_id])?;
        }
        // Empty on a from-scratch database (this is the one and only time it's ever seeded from
        // scratch), so this is exactly apply_linked_terms with nothing yet on record to drop.
        apply_linked_terms(conn, &video_id, &pruned_value, &HashSet::new(), &linked_now)?;
        set_linked_terms(conn, &video_id, &linked_now)?;
    }
    Ok(())
}

/// Every quote-mark-ish character `strip_quoteblock_quotes` treats as one: straight double/single,
/// the curly/smart pairs, low/high German-style quotes, and both sizes of guillemet.
const QUOTE_CHARS: &[char] = &['"', '\'', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{201A}', '\u{201E}', '\u{2039}', '\u{203A}', '\u{00AB}', '\u{00BB}'];

/// `text` with every quote-mark character (see `QUOTE_CHARS`) taken out of any line that starts
/// with a markdown blockquote marker (`>`) — a blockquote already visually quotes its content, so
/// an AI that also wraps it in literal quote marks doubles up (`> "like this," he said`). Leaves
/// every other line untouched. This is the "Strip extra quotes in quoteblocks" post-processing
/// option (Settings > API Key > Venice), applied once to a freshly generated Venice summary (see
/// venice.rs) — not on every save any more, so a plain edited or Ollama-generated summary is never
/// touched by it.
pub(crate) fn strip_quoteblock_quotes(text: &str) -> String {
    text.split('\n')
        .map(|line| if line.starts_with('>') { line.chars().filter(|c| !QUOTE_CHARS.contains(c)).collect::<String>() } else { line.to_string() })
        .collect::<Vec<_>>()
        .join("\n")
}

/// True for a character in one of the common emoji blocks (pictographs, emoticons, transport,
/// dingbats, flags, skin-tone modifiers) or a modifier that attaches to one (variation selector,
/// zero-width joiner). Not a complete implementation of Unicode's emoji property — arrows and a few
/// rarer blocks are deliberately left out, since they're more often meant as plain punctuation than
/// decoration — but it covers what an LLM actually reaches for.
fn is_emoji_char(c: char) -> bool {
    // Skin-tone modifiers (0x1F3FB..=0x1F3FF) fall inside 0x1F300..=0x1F5FF already, so they don't
    // need (and can't have, without a redundant-pattern warning) an arm of their own.
    matches!(c as u32,
        0x1F300..=0x1F5FF | 0x1F600..=0x1F64F | 0x1F680..=0x1F6FF | 0x1F900..=0x1F9FF |
        0x1FA70..=0x1FAFF | 0x1F1E6..=0x1F1FF | 0x2600..=0x26FF | 0x2700..=0x27BF |
        0x200D | 0xFE0F
    )
}

/// `s` with a leading run of emoji (and the single space after it, if any) removed.
fn strip_leading_emoji(s: &str) -> &str {
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        if is_emoji_char(c) { rest = &rest[c.len_utf8()..]; } else { break; }
    }
    rest.trim_start_matches(' ')
}

/// Splits a line already known to start with one or more of `marker_char` (e.g. `#` for a header,
/// `>` for a quoteblock) into that run of markers and whatever comes after it.
fn split_marker_run(trimmed: &str, marker_char: char) -> (&str, &str) {
    let after = trimmed.trim_start_matches(marker_char);
    let marker_len = trimmed.len() - after.len();
    trimmed.split_at(marker_len)
}

/// Strips a leading run of emoji from the start of every markdown header (after its `#`s),
/// quoteblock (after its `>`s), list item (after its `-`/`*`/`1.` marker) and ordinary paragraph
/// line. Never touches a blank line or a code line — stripping from inside code would corrupt it —
/// and never an emoji in the middle of a line, only a leading one. This is the "Strip emojis at the
/// beginning of headers and paragraphs" post-processing option (Settings > API Key > Venice), off by
/// default, applied the same way and at the same point as `strip_quoteblock_quotes` above.
pub(crate) fn strip_header_and_paragraph_emojis(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let trimmed = line.trim_start();
            let indent = &line[..line.len() - trimmed.len()];
            if trimmed.is_empty() || trimmed.starts_with('`') {
                return line.to_string();
            }
            // Header ("# " / "## ") or quoteblock ("> " / ">> "): a run of the marker char, then a
            // single space, then content — the emoji comes right after that space.
            for marker_char in ['#', '>'] {
                if trimmed.starts_with(marker_char) {
                    let (marker, rest) = split_marker_run(trimmed, marker_char);
                    return match rest.strip_prefix(' ') {
                        Some(after_space) => format!("{indent}{marker} {}", strip_leading_emoji(after_space)),
                        None => line.to_string(),
                    };
                }
            }
            // Unordered list ("- " / "* ") or ordered ("1. ", "12. ", ...): the marker, then content.
            if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
                let marker = &trimmed[..trimmed.len() - rest.len()];
                return format!("{indent}{marker}{}", strip_leading_emoji(rest));
            }
            let digits_len = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
            if digits_len > 0 {
                if let Some(rest) = trimmed[digits_len..].strip_prefix(". ") {
                    let marker = &trimmed[..trimmed.len() - rest.len()];
                    return format!("{indent}{marker}{}", strip_leading_emoji(rest));
                }
            }
            // Ordinary paragraph.
            format!("{indent}{}", strip_leading_emoji(trimmed))
        })
        .collect::<Vec<_>>()
        .join("\n")
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
        "UPDATE Videos SET transcript = 'N/A' WHERE video_id = ?1",
        params![video_id],
    )?;
    Ok(())
}

pub fn get_summary(db_path: &str, video_id: &str) -> Result<Option<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT summary FROM Videos WHERE video_id = ?")?;
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
        conn.prepare("SELECT summary FROM Videos WHERE summary IS NOT NULL AND summary != ''")?;
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
        conn.prepare("SELECT video_id, summary FROM Videos WHERE summary IS NOT NULL AND summary != ''")?;
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

#[cfg(test)]
mod save_speed_tests {
    use super::*;
    use crate::db::init_db;

    /// `cargo test --lib -- --ignored --nocapture summary_save_speed`: how long saving a summary takes,
    /// for summaries of a few sizes, on a video that also has a long transcript.
    #[test]
    #[ignore]
    fn summary_save_speed() {
        let path = std::env::temp_dir().join(format!("kinesis_summary_speed_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = path.to_string_lossy().to_string();
        init_db(&db).unwrap();
        for (lines, clear) in [(50usize, false), (500, false), (5_000, false), (5_000, true)] {
            let conn = Connection::open(&db).unwrap();
            conn.execute("DELETE FROM Videos", []).unwrap();
            let transcript = "word another words here ".repeat(20_000); // ~480k characters
            conn.execute("INSERT INTO Videos (video_id, title, author, transcript) VALUES ('v', 'T', 'A', ?1)", params![transcript]).unwrap();
            conn.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('setTranscriptAfterSummarizeToNA', ?1)", params![clear.to_string()]).unwrap();
            drop(conn);
            let summary: String = (0..lines).map(|i| format!("- point {i}: a line of the summary text that is a typical length
")).collect();
            let t = std::time::Instant::now();
            save_summary(&db, "v", &summary).unwrap();
            println!("{:>6} lines ({:>7} bytes), clear transcript {clear}: {:?}", lines, summary.len(), t.elapsed());
        }
    }
}

#[cfg(test)]
mod post_process_tests {
    use super::*;

    #[test]
    fn every_quote_character_is_stripped_from_a_blockquote_line_only() {
        let text = "> \u{201C}curly\u{201D} and 'single' and \u{00AB}guillemets\u{00BB}\nnormal \"kept\" line";
        assert_eq!(strip_quoteblock_quotes(text), "> curly and single and guillemets\nnormal \"kept\" line");
    }

    #[test]
    fn an_indented_blockquote_marker_is_not_a_quote() {
        // Only a line actually starting with '>' counts — matches markdown's own rule (a blockquote
        // can't be indented) and the option's stated scope ("in quoteblocks").
        assert_eq!(strip_quoteblock_quotes("  > \"indented\" isn't a quoteblock"), "  > \"indented\" isn't a quoteblock");
    }

    #[test]
    fn a_leading_emoji_is_stripped_from_a_header_after_its_hashes() {
        assert_eq!(strip_header_and_paragraph_emojis("## \u{1F389} Big News"), "## Big News");
    }

    #[test]
    fn a_leading_emoji_run_is_stripped_from_a_paragraph() {
        assert_eq!(strip_header_and_paragraph_emojis("\u{1F44B}\u{1F600} Hello there"), "Hello there");
    }

    #[test]
    fn a_leading_emoji_is_stripped_from_a_list_item_and_a_quoteblock() {
        let text = "- \u{1F389} bullet\n* \u{1F389} bullet\n1. \u{1F389} ordered\n12. \u{1F389} ordered\n> \u{1F389} quoted\n>> \u{1F389} nested";
        let expected = "- bullet\n* bullet\n1. ordered\n12. ordered\n> quoted\n>> nested";
        assert_eq!(strip_header_and_paragraph_emojis(text), expected);
    }

    #[test]
    fn a_code_line_and_a_blank_line_are_left_alone() {
        let text = "`\u{1F389} code`\n\nplain";
        assert_eq!(strip_header_and_paragraph_emojis(text), text);
    }

    #[test]
    fn an_emoji_in_the_middle_of_a_paragraph_is_left_alone() {
        assert_eq!(strip_header_and_paragraph_emojis("Great news \u{1F389} today"), "Great news \u{1F389} today");
    }
}

#[cfg(test)]
mod term_sync_tests {
    use super::*;
    use crate::db::init_db;

    fn setup() -> (String, Connection) {
        // A monotonic counter alongside the timestamp: these tests run in parallel, and on Windows
        // SystemTime's resolution is coarse enough that two threads can land on the exact same
        // nanosecond value, giving two tests the same filename and an intermittent UNIQUE-constraint
        // failure on whichever one loses the race to insert its 'v' row first.
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "kinesis_term_sync_{}_{}_{n}.db",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let _ = std::fs::remove_file(&path);
        let db_path = path.to_string_lossy().to_string();
        init_db(&db_path).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        conn.execute("INSERT INTO Videos (video_id, title) VALUES ('v', 'T')", []).unwrap();
        (db_path, conn)
    }

    fn tags_of(conn: &Connection) -> Vec<String> {
        let raw: String = conn.query_row("SELECT COALESCE(tags, '') FROM Videos WHERE video_id = 'v'", [], |r| r.get(0)).unwrap();
        raw.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
    }

    #[test]
    fn linked_terms_become_tags() {
        let (db_path, conn) = setup();
        save_summary(&db_path, "v", "See [Bitcoin](kinesis://glossary/Bitcoin) and [Halving](kinesis://glossary/Halving).").unwrap();
        let mut tags = tags_of(&conn);
        tags.sort();
        assert_eq!(tags, vec!["Bitcoin".to_string(), "Halving".to_string()]);
    }

    #[test]
    fn removing_a_link_removes_its_tag() {
        let (db_path, conn) = setup();
        save_summary(&db_path, "v", "See [Bitcoin](kinesis://glossary/Bitcoin) and [Halving](kinesis://glossary/Halving).").unwrap();
        save_summary(&db_path, "v", "See [Bitcoin](kinesis://glossary/Bitcoin) only now.").unwrap();
        assert_eq!(tags_of(&conn), vec!["Bitcoin".to_string()]);
    }

    #[test]
    fn a_duplicate_link_to_the_same_term_is_one_tag() {
        let (db_path, conn) = setup();
        save_summary(&db_path, "v", "[Bitcoin](kinesis://glossary/Bitcoin) ... later, [Bitcoin](kinesis://glossary/Bitcoin) again.").unwrap();
        assert_eq!(tags_of(&conn), vec!["Bitcoin".to_string()]);
    }

    #[test]
    fn a_quick_tag_with_no_definition_is_left_alone() {
        let (db_path, conn) = setup();
        conn.execute("UPDATE Videos SET tags = 'my-quick-tag' WHERE video_id = 'v'", []).unwrap();
        save_summary(&db_path, "v", "See [Bitcoin](kinesis://glossary/Bitcoin).").unwrap();
        let mut tags = tags_of(&conn);
        tags.sort();
        assert_eq!(tags, vec!["Bitcoin".to_string(), "my-quick-tag".to_string()]);
    }

    #[test]
    fn the_backfill_retires_a_legacy_hand_added_term_with_no_matching_link() {
        // Simulates a Term added through the sidebar's old "+" dropdown, before this file existed —
        // there's no VideoLinkedTerms row for it (nothing ever synced this video before), so only
        // the backfill's own has-a-definition check can recognize and retire it.
        let (db_path, conn) = setup();
        conn.execute("INSERT INTO Glossary (term, definition, drives) VALUES ('Bitcoin', 'A cryptocurrency.', '')", []).unwrap();
        conn.execute("UPDATE Videos SET tags = 'Bitcoin', summary = 'Just some prose, no links here.' WHERE video_id = 'v'", []).unwrap();
        backfill_terms_from_summaries(&conn).unwrap();
        assert_eq!(tags_of(&conn), Vec::<String>::new());
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn ordinary_sync_leaves_a_hand_added_term_with_no_provenance_alone() {
        // The mirror image of the backfill test above: sync_terms_from_video_text (what every
        // ordinary save runs) only ever drops a tag VideoLinkedTerms says IT added — a hand-added
        // Term-with-a-definition that predates any sync is invisible to it (that's what the
        // one-time backfill is for), not something an everyday save should go pruning.
        let (db_path, conn) = setup();
        conn.execute("INSERT INTO Glossary (term, definition, drives) VALUES ('Bitcoin', 'A cryptocurrency.', '')", []).unwrap();
        conn.execute("UPDATE Videos SET tags = 'Bitcoin' WHERE video_id = 'v'", []).unwrap();
        save_summary(&db_path, "v", "Just some prose, no links here.").unwrap();
        assert_eq!(tags_of(&conn), vec!["Bitcoin".to_string()]);
    }

    #[test]
    fn a_non_glossary_link_kind_is_ignored() {
        let (db_path, conn) = setup();
        save_summary(&db_path, "v", "See [Ann](kinesis://bio/Ann) and [Bitcoin](kinesis://glossary/Bitcoin).").unwrap();
        assert_eq!(tags_of(&conn), vec!["Bitcoin".to_string()]);
    }

    #[test]
    fn backfill_reconciles_every_video_in_one_pass() {
        let (db_path, conn) = setup();
        // "Stale" is a legacy hand-added Term (a real Glossary definition, no matching link) that
        // the backfill should retire; a plain undefined/unlinked/no-provenance name — a genuine
        // Quick Tag's shape — would be indistinguishable from one and is deliberately left alone
        // (see ordinary_sync_leaves_a_hand_added_term_with_no_provenance_alone above).
        conn.execute("INSERT INTO Glossary (term, definition, drives) VALUES ('Stale', 'An old definition.', '')", []).unwrap();
        conn.execute("UPDATE Videos SET tags = 'Stale', summary = '[Fresh](kinesis://glossary/Fresh)' WHERE video_id = 'v'", []).unwrap();
        backfill_terms_from_summaries(&conn).unwrap();
        assert_eq!(tags_of(&conn), vec!["Fresh".to_string()]);
        let _ = std::fs::remove_file(&db_path);
    }
}
