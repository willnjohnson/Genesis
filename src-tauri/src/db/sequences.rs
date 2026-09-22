//! Drive sequences: an ordered watch-through list per Drive, behind the sidebar's First / Previous /
//! Next bar.
//!
//! A sequence belongs to a Drive (`:CS-DSA`, the display path in uppercase) and may hold any video
//! filed at or beneath that Drive (its home or an "Also in" link), so `:CS` can walk across
//! `:CS-DSA` and `:CS-OS`. A video is in a given sequence at most once, but can be in the sequences
//! of several Drives, which is how the same video branches differently under `:CS` and `:PYTHON`.
//!
//! Positions are kept 1..N by every write here. Reads only rely on their order, so a gap left by a
//! deleted video (see the cascade trigger in schema.rs) does no harm.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

use super::wdbs::{is_unassigned_sentinel, storage_to_display_path};

fn invalid(msg: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::InvalidInput, msg.into())))
}

/// The stored spelling of a Drive path: trimmed, uppercase, ":" then one or more "-"-separated
/// segments (":CS-DSA"). Anything else is refused, so a sequence can't hang off a malformed path.
pub fn normalize_drive(drive: &str) -> Result<String> {
    let d = drive.trim().to_uppercase();
    let well_formed = d.strip_prefix(':').is_some_and(|body| {
        !body.is_empty()
            && body.split('-').all(|segment| !segment.is_empty())
            && !body.chars().any(|c| c == ':' || c == '_' || c.is_control())
    });
    if well_formed {
        Ok(d)
    } else {
        Err(invalid(format!("'{}' isn't a Drive path like :CS-DSA", drive.trim())))
    }
}

/// True when `path` is `drive` itself or beneath it.
fn covers(drive: &str, path: &str) -> bool {
    path == drive || path.strip_prefix(drive).is_some_and(|rest| rest.starts_with('-'))
}

/// Every Drive a video is filed under (its home and its "Also in" links), as display paths.
fn video_drives(conn: &Connection, video_id: &str) -> Result<Vec<String>> {
    let mut raw: Vec<String> = Vec::new();
    let home: Option<Option<String>> = conn
        .query_row("SELECT WDBS FROM Videos WHERE video_id = ?1", params![video_id], |row| row.get(0))
        .optional()?;
    if let Some(Some(home)) = home {
        raw.push(home);
    }
    // A database that never had links yet simply has no rows here.
    if let Ok(mut stmt) = conn.prepare("SELECT wdbs FROM VideoWDBSLinks WHERE video_id = ?1") {
        raw.extend(stmt.query_map(params![video_id], |row| row.get::<_, String>(0))?.filter_map(|r| r.ok()));
    }
    let mut out: Vec<String> = Vec::new();
    for storage in raw {
        let storage = storage.trim();
        if storage.is_empty() || is_unassigned_sentinel(storage) {
            continue;
        }
        let display = storage_to_display_path(storage).to_uppercase();
        if !out.contains(&display) {
            out.push(display);
        }
    }
    Ok(out)
}

/// Rewrites a sequence's positions as 1..N in their current order.
fn renumber(conn: &Connection, drive: &str) -> Result<()> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT video_id FROM DriveSequence WHERE drive = ?1 ORDER BY position, video_id")?;
        let rows = stmt.query_map(params![drive], |row| row.get(0))?;
        rows.collect::<Result<_>>()?
    };
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE DriveSequence SET position = ?1 WHERE drive = ?2 AND video_id = ?3 AND position != ?1",
            params![(i + 1) as i64, drive, id],
        )?;
    }
    Ok(())
}

/// What adding a batch of videos to a sequence did.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddOutcome {
    pub added: i64,
    /// Skipped: already in this sequence.
    pub already_in: i64,
    /// Skipped: not filed at or beneath this Drive (or not in the library at all).
    pub not_in_drive: i64,
}

/// Appends videos to a Drive's sequence, in the order given. A video already in it, or not filed at
/// or beneath the Drive, is skipped and counted rather than failing the whole batch.
pub fn add_to_drive_sequence(db_path: &str, drive: &str, video_ids: &[String]) -> Result<AddOutcome> {
    let drive = normalize_drive(drive)?;
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    let outcome = append_ids(&tx, &drive, video_ids, true)?;
    tx.commit()?;
    Ok(outcome)
}

/// Appends `video_ids` to the end of `drive`'s sequence (`drive` already normalized). `verify` checks
/// each video is filed at or beneath the Drive; callers that got the ids from that very check
/// (`add_matching_to_drive_sequence`) skip it, since it reads every video's Drive off the table.
fn append_ids(tx: &rusqlite::Transaction, drive: &str, video_ids: &[String], verify: bool) -> Result<AddOutcome> {
    let mut next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) FROM DriveSequence WHERE drive = ?1",
        params![drive],
        |row| row.get(0),
    )?;
    let mut outcome = AddOutcome::default();
    let mut seen: HashSet<String> = HashSet::new();
    for id in video_ids {
        let id = id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let already: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM DriveSequence WHERE drive = ?1 AND video_id = ?2)",
            params![drive, id],
            |row| row.get(0),
        )?;
        if already {
            outcome.already_in += 1;
            continue;
        }
        if verify && !video_drives(tx, id)?.iter().any(|d| covers(drive, d)) {
            outcome.not_in_drive += 1;
            continue;
        }
        next += 1;
        tx.execute(
            "INSERT INTO DriveSequence (drive, video_id, position) VALUES (?1, ?2, ?3)",
            params![drive, id, next],
        )?;
        outcome.added += 1;
    }
    Ok(outcome)
}

/// What to order videos by. Dates sort as the text they're stored as (ISO, so that's chronological);
/// titles sort "naturally", so "Lecture 2" comes before "Lecture 10".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    /// When the video was uploaded to YouTube.
    Published,
    /// When it was added to the library.
    Added,
    Title,
}

impl SortKey {
    pub fn parse(s: &str) -> Result<SortKey> {
        match s {
            "published" => Ok(SortKey::Published),
            "added" => Ok(SortKey::Added),
            "title" => Ok(SortKey::Title),
            other => Err(invalid(format!("'{other}' isn't a way to order videos (published, added or title)."))),
        }
    }
}

/// Case-insensitive comparison in which a run of digits counts as a number, not as characters.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Equal,
            (None, _) => return Less,
            (_, None) => return Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(|c| c.is_ascii_digit()) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(|c| c.is_ascii_digit()) {
                    nb.push(c);
                    bi.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ai.next();
                bi.next();
            }
        }
    }
}

/// A video's sort keys.
#[derive(Default)]
struct KeyRow {
    id: String,
    title: String,
    published: String,
    added: String,
}

fn sort_key_rows(rows: &mut [KeyRow], key: SortKey, descending: bool) {
    // Stable, so videos that tie keep the order they came in.
    rows.sort_by(|a, b| {
        let ord = match key {
            SortKey::Published => a.published.cmp(&b.published),
            SortKey::Added => a.added.cmp(&b.added),
            SortKey::Title => natural_cmp(&a.title, &b.title),
        };
        if descending { ord.reverse() } else { ord }
    });
}

/// `video_ids` reordered by `key`.
fn sort_ids(conn: &Connection, video_ids: &[String], key: SortKey, descending: bool) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT title, published_at, date_added FROM Videos WHERE video_id = ?1")?;
    let mut rows: Vec<KeyRow> = Vec::with_capacity(video_ids.len());
    for id in video_ids {
        let found = stmt
            .query_row(params![id.trim()], |row| {
                Ok(KeyRow {
                    id: id.clone(),
                    title: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    published: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    added: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                })
            })
            .optional()?;
        // An id that isn't in the library sorts as blank; the add itself reports it.
        rows.push(found.unwrap_or_else(|| KeyRow { id: id.clone(), ..Default::default() }));
    }
    sort_key_rows(&mut rows, key, descending);
    Ok(rows.into_iter().map(|r| r.id).collect())
}

/// Like `add_to_drive_sequence`, but the videos are appended ordered by `sort` ("published", "added"
/// or "title"), ascending unless `descending`, whatever order they were given in.
pub fn add_to_drive_sequence_sorted(db_path: &str, drive: &str, video_ids: &[String], sort: &str, descending: bool) -> Result<AddOutcome> {
    let key = SortKey::parse(sort)?;
    let ordered = {
        let conn = Connection::open(db_path)?;
        sort_ids(&conn, video_ids, key, descending)?
    };
    add_to_drive_sequence(db_path, drive, &ordered)
}

/// Takes a video out of a Drive's sequence; the ones after it close up. The only video in a
/// sequence stays: a sequence of one reads the same as no sequence ("1 of 1"), so there is nothing
/// to take it out of.
pub fn remove_from_drive_sequence(db_path: &str, drive: &str, video_id: &str) -> Result<()> {
    let drive = normalize_drive(drive)?;
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM DriveSequence WHERE drive = ?1", params![drive], |row| row.get(0))?;
    if total <= 1 {
        return Err(invalid("The only video in a sequence can't be removed."));
    }
    tx.execute("DELETE FROM DriveSequence WHERE drive = ?1 AND video_id = ?2", params![drive, video_id])?;
    renumber(&tx, &drive)?;
    tx.commit()
}

/// Reorders a Drive's sequence. `ordered` must hold exactly the videos already in it, each once, so a
/// reorder can never add, drop or repeat a video.
pub fn set_drive_sequence_order(db_path: &str, drive: &str, ordered: &[String]) -> Result<()> {
    let drive = normalize_drive(drive)?;
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    let current: HashSet<String> = {
        let mut stmt = tx.prepare("SELECT video_id FROM DriveSequence WHERE drive = ?1")?;
        let rows = stmt.query_map(params![drive], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<_>>()?
    };
    let wanted: HashSet<String> = ordered.iter().cloned().collect();
    if wanted.len() != ordered.len() || wanted != current {
        return Err(invalid("The new order must list each video in the sequence exactly once."));
    }
    for (i, id) in ordered.iter().enumerate() {
        tx.execute(
            "UPDATE DriveSequence SET position = ?1 WHERE drive = ?2 AND video_id = ?3",
            params![(i + 1) as i64, drive, id],
        )?;
    }
    tx.commit()
}

/// Clears a Drive's sequence: every video comes out of it, whatever its length, leaving the Drive
/// with no sequence (the videos themselves are untouched). A Drive with none is a no-op.
pub fn clear_drive_sequence(db_path: &str, drive: &str) -> Result<()> {
    let drive = normalize_drive(drive)?;
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM DriveSequence WHERE drive = ?1", params![drive])?;
    Ok(())
}

/// The storage form of a display path (":CS-DSA" -> "θψCS_DSA"), as Videos.WDBS and
/// VideoWDBSLinks.wdbs spell it.
fn display_to_storage(drive: &str) -> String {
    format!("θψ{}", drive.trim_start_matches(':').replace('-', "_"))
}


/// A Drive one level beneath another, for stepping down into it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChildDrive {
    /// Its display path, e.g. ":DUPED-FRW-PND".
    pub drive: String,
    /// Videos filed at or beneath it (home or "Also in" link).
    pub videos: i64,
    /// How many videos its sequence has (0 = none yet).
    pub sequence_total: i64,
}

/// The Drives one level beneath `drive`, i.e. its sub-drives in the Drive tree, in name order: for
/// ":DUPED-FRW" that's ":DUPED-FRW-PND" and ":DUPED-FRW-VVV", not anything deeper. Found from the
/// videos filed beneath it (a range on idxVideosWDBS, plus the links table), so a Drive appears once
/// something is filed there or below it, whether or not it has a sequence.
pub fn get_child_drives(db_path: &str, drive: &str) -> Result<Vec<ChildDrive>> {
    let drive = normalize_drive(drive)?;
    let conn = Connection::open(db_path)?;
    let own = display_to_storage(&drive);
    // Everything beneath the Drive starts with its path and a "_"; "`" is the character after "_".
    let (from, to) = (format!("{own}_"), format!("{own}`"));

    // Next path segment -> the videos (by rowid, so one filed twice under a child counts once) at or beneath it.
    let mut children: std::collections::BTreeMap<String, HashSet<i64>> = std::collections::BTreeMap::new();
    let mut note = |storage: &str, rowid: i64| {
        let segment = storage.get(from.len()..).unwrap_or("").split('_').next().unwrap_or("");
        if !segment.is_empty() {
            children.entry(segment.to_string()).or_default().insert(rowid);
        }
    };
    {
        let mut stmt = conn.prepare("SELECT rowid, WDBS FROM Videos WHERE WDBS >= ?1 AND WDBS < ?2")?;
        for row in stmt.query_map(params![from, to], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))? {
            let (rowid, storage) = row?;
            note(&storage, rowid);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT v.rowid, l.wdbs FROM VideoWDBSLinks l JOIN Videos v ON v.video_id = l.video_id
             WHERE l.wdbs >= ?1 AND l.wdbs < ?2",
        )?;
        for row in stmt.query_map(params![from, to], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))? {
            let (rowid, storage) = row?;
            note(&storage, rowid);
        }
    }

    let mut out = Vec::with_capacity(children.len());
    for (segment, videos) in children {
        let child = format!("{drive}-{segment}");
        let sequence_total: i64 =
            conn.query_row("SELECT COUNT(*) FROM DriveSequence WHERE drive = ?1", params![child], |row| row.get(0))?;
        out.push(ChildDrive { drive: child, videos: videos.len() as i64, sequence_total });
    }
    Ok(out)
}

/// A video offered for adding to a sequence.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriveVideo {
    pub video_id: String,
    pub title: String,
    pub author: Option<String>,
    pub published_at: Option<String>,
}

/// Rowids of the videos that could be added to a Drive's sequence: everything filed at or beneath the
/// Drive (its home or an "Also in" link) that isn't in the sequence yet, optionally narrowed to those
/// whose title or channel contains `query`.
///
/// Stays off the transcripts: which videos are under the Drive comes from idxVideosWDBS (a range on
/// the path) and the small links table, never from reading the videos themselves.
fn addable_rowids(conn: &Connection, drive: &str, query: &str) -> Result<HashSet<i64>> {
    let own = display_to_storage(drive);
    // Everything beneath the Drive starts with its path and a "_"; "`" is the character after "_".
    let (below_from, below_to) = (format!("{own}_"), format!("{own}`"));

    let mut matched: HashSet<i64> = HashSet::new();
    {
        let mut stmt = conn.prepare("SELECT rowid FROM Videos WHERE WDBS = ?1 OR (WDBS >= ?2 AND WDBS < ?3)")?;
        for id in stmt.query_map(params![own, below_from, below_to], |row| row.get::<_, i64>(0))? {
            matched.insert(id?);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT v.rowid FROM VideoWDBSLinks l JOIN Videos v ON v.video_id = l.video_id
             WHERE l.wdbs = ?1 OR (l.wdbs >= ?2 AND l.wdbs < ?3)",
        )?;
        for id in stmt.query_map(params![own, below_from, below_to], |row| row.get::<_, i64>(0))? {
            matched.insert(id?);
        }
    }
    {
        let mut stmt = conn.prepare("SELECT v.rowid FROM DriveSequence s JOIN Videos v ON v.video_id = s.video_id WHERE s.drive = ?1")?;
        for id in stmt.query_map(params![drive], |row| row.get::<_, i64>(0))? {
            matched.remove(&id?);
        }
    }

    let needle = query.trim().to_lowercase();
    if !needle.is_empty() {
        let mut stmt = conn.prepare("SELECT title, author FROM Videos WHERE rowid = ?1")?;
        matched.retain(|id| {
            stmt.query_row(params![id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)))
                .map(|(title, author)| {
                    title.unwrap_or_default().to_lowercase().contains(&needle) || author.unwrap_or_default().to_lowercase().contains(&needle)
                })
                .unwrap_or(false)
        });
    }
    Ok(matched)
}

/// `matched` in the order `key` gives. The date orders walk the date indexes (cheap, and off the
/// transcripts); a title order reads just the titles of the matches.
fn order_rowids(conn: &Connection, matched: &HashSet<i64>, key: SortKey, descending: bool) -> Result<Vec<i64>> {
    match key {
        SortKey::Published | SortKey::Added => {
            let column = if key == SortKey::Published { "published_at" } else { "date_added" };
            let dir = if descending { "DESC" } else { "ASC" };
            let mut stmt = conn.prepare(&format!("SELECT rowid FROM Videos ORDER BY {column} {dir}, rowid {dir}"))?;
            let mut rows = stmt.query([])?;
            let mut out = Vec::with_capacity(matched.len());
            while let Some(row) = rows.next()? {
                let id: i64 = row.get(0)?;
                if matched.contains(&id) {
                    out.push(id);
                }
            }
            Ok(out)
        }
        SortKey::Title => {
            let mut stmt = conn.prepare("SELECT title FROM Videos WHERE rowid = ?1")?;
            let mut titled: Vec<(i64, String)> = Vec::with_capacity(matched.len());
            for &id in matched {
                let title: Option<String> = stmt.query_row(params![id], |row| row.get(0))?;
                titled.push((id, title.unwrap_or_default()));
            }
            titled.sort_by(|a, b| {
                let ord = natural_cmp(&a.1, &b.1).then(a.0.cmp(&b.0));
                if descending { ord.reverse() } else { ord }
            });
            Ok(titled.into_iter().map(|(id, _)| id).collect())
        }
    }
}

/// Videos that could be added to a Drive's sequence (see `addable_rowids`), ordered by `sort`
/// ("published", "added" or "title"; ascending unless `descending`). Returns one page and the count
/// across all pages.
pub fn list_drive_videos_for_sequence(
    db_path: &str,
    drive: &str,
    query: &str,
    sort: &str,
    descending: bool,
    limit: i64,
    offset: i64,
) -> Result<(Vec<DriveVideo>, i64)> {
    let drive = normalize_drive(drive)?;
    let key = SortKey::parse(sort)?;
    let conn = Connection::open(db_path)?;
    let matched = addable_rowids(&conn, &drive, query)?;
    let total = matched.len() as i64;
    let ordered = order_rowids(&conn, &matched, key, descending)?;

    let mut stmt = conn.prepare("SELECT video_id, title, author, published_at FROM Videos WHERE rowid = ?1")?;
    let mut videos = Vec::new();
    for id in ordered.into_iter().skip(offset.max(0) as usize).take(limit.max(0) as usize) {
        videos.push(stmt.query_row(params![id], |row| {
            let video_id: String = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            Ok(DriveVideo { title: title.unwrap_or_else(|| video_id.clone()), video_id, author: row.get(2)?, published_at: row.get(3)? })
        })?);
    }
    Ok((videos, total))
}

/// Adds every video `list_drive_videos_for_sequence` would list for `query` (all pages, not just the
/// ones on screen) to the end of the Drive's sequence, ordered by `sort`, except those in `excluded`.
/// This is "select all, then untick the ones I don't want" without sending thousands of ids back and
/// forth. The listed videos are known to be under the Drive, so they aren't checked again.
///
/// `tail` is for ones unticked and then ticked again: they go after everything else, in the order
/// given (list them in `excluded` too, so the ordered pass leaves them out), like anything ticked last.
/// Those are checked, since they came from the client rather than from the listing.
pub fn add_matching_to_drive_sequence(
    db_path: &str,
    drive: &str,
    query: &str,
    sort: &str,
    descending: bool,
    excluded: &[String],
    tail: &[String],
) -> Result<AddOutcome> {
    let drive = normalize_drive(drive)?;
    let key = SortKey::parse(sort)?;
    let mut conn = Connection::open(db_path)?;
    let matched = addable_rowids(&conn, &drive, query)?;
    let ordered = order_rowids(&conn, &matched, key, descending)?;
    let skip: HashSet<&str> = excluded.iter().map(|s| s.trim()).collect();
    let mut ids: Vec<String> = Vec::with_capacity(ordered.len());
    {
        let mut stmt = conn.prepare("SELECT video_id FROM Videos WHERE rowid = ?1")?;
        for rowid in ordered {
            let id: String = stmt.query_row(params![rowid], |row| row.get(0))?;
            if !skip.contains(id.as_str()) {
                ids.push(id);
            }
        }
    }
    let tx = conn.transaction()?;
    let mut outcome = append_ids(&tx, &drive, &ids, false)?;
    if !tail.is_empty() {
        let more = append_ids(&tx, &drive, tail, true)?;
        outcome.added += more.added;
        outcome.already_in += more.already_in;
        outcome.not_in_drive += more.not_in_drive;
    }
    tx.commit()?;
    Ok(outcome)
}

/// One row of a sequence, for the list that jumps around it and reorders it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SequenceEntry {
    pub video_id: String,
    pub title: String,
    pub position: i64,
}

/// A Drive's sequence in order. A video that has since left the library shows under its id.
pub fn get_drive_sequence(db_path: &str, drive: &str) -> Result<Vec<SequenceEntry>> {
    let drive = normalize_drive(drive)?;
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT s.video_id, v.title, s.position
         FROM DriveSequence s LEFT JOIN Videos v ON v.video_id = s.video_id
         WHERE s.drive = ?1
         ORDER BY s.position, s.video_id",
    )?;
    let rows = stmt.query_map(params![drive], |row| {
        let video_id: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        Ok(SequenceEntry { title: title.unwrap_or_else(|| video_id.clone()), video_id, position: row.get(2)? })
    })?;
    rows.collect()
}

/// Every (drive, video_id) pair across the whole table, each drive's own videos already in
/// sequence order — used by commands::export::export_to_obsidian to work out every video's
/// Prev/Next in one pass instead of a lookup per video.
pub fn get_all_drive_sequences(db_path: &str) -> Result<Vec<(String, String)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT drive, video_id FROM DriveSequence ORDER BY drive, position, video_id")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    rows.collect()
}

/// Where a video stands in one Drive's sequence, for the sidebar bar.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriveSequenceState {
    pub drive: String,
    /// Videos in the sequence (0 = no sequence yet).
    pub total: i64,
    /// The video's place, counted from 1; None when it isn't in this sequence.
    pub position: Option<i64>,
    pub first: Option<String>,
    pub prev: Option<String>,
    pub next: Option<String>,
}

/// The state of `video_id` in each of `drives`. Each is a handful of lookups on the
/// (drive, position) and (drive, video_id) indexes, never a scan of the videos.
pub fn get_video_sequence_states(db_path: &str, video_id: &str, drives: &[String]) -> Result<Vec<DriveSequenceState>> {
    let conn = Connection::open(db_path)?;
    let mut out = Vec::new();
    for raw in drives {
        let Ok(drive) = normalize_drive(raw) else { continue };
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM DriveSequence WHERE drive = ?1", params![drive], |row| row.get(0))?;
        let mut state = DriveSequenceState { drive: drive.clone(), total, position: None, first: None, prev: None, next: None };
        let stored: Option<i64> = conn
            .query_row(
                "SELECT position FROM DriveSequence WHERE drive = ?1 AND video_id = ?2",
                params![drive, video_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(pos) = stored {
            state.position = Some(conn.query_row(
                "SELECT COUNT(*) FROM DriveSequence WHERE drive = ?1 AND position <= ?2",
                params![drive, pos],
                |row| row.get(0),
            )?);
            state.first = conn
                .query_row("SELECT video_id FROM DriveSequence WHERE drive = ?1 ORDER BY position LIMIT 1", params![drive], |row| row.get(0))
                .optional()?;
            state.prev = conn
                .query_row(
                    "SELECT video_id FROM DriveSequence WHERE drive = ?1 AND position < ?2 ORDER BY position DESC LIMIT 1",
                    params![drive, pos],
                    |row| row.get(0),
                )
                .optional()?;
            state.next = conn
                .query_row(
                    "SELECT video_id FROM DriveSequence WHERE drive = ?1 AND position > ?2 ORDER BY position LIMIT 1",
                    params![drive, pos],
                    |row| row.get(0),
                )
                .optional()?;
        }
        out.push(state);
    }
    Ok(out)
}

/// Drops a video from every sequence whose Drive it is no longer filed at or beneath. Called after
/// its home Drive or an "Also in" link changes (db::update_video_wdbs, remove_video_wdbs_link,
/// clear_video_wdbs_links), so a sequence never lists a video that has left its Drive. Best effort:
/// the change that triggered it has already been saved, so a failure here is only logged.
pub fn prune_video_memberships(db_path: &str, video_id: &str) {
    let run = || -> Result<()> {
        let conn = Connection::open(db_path)?;
        let drives = video_drives(&conn, video_id)?;
        let member_of: Vec<String> = {
            let mut stmt = conn.prepare("SELECT drive FROM DriveSequence WHERE video_id = ?1")?;
            let rows = stmt.query_map(params![video_id], |row| row.get(0))?;
            rows.collect::<Result<_>>()?
        };
        for drive in member_of {
            if !drives.iter().any(|d| covers(&drive, d)) {
                conn.execute("DELETE FROM DriveSequence WHERE drive = ?1 AND video_id = ?2", params![drive, video_id])?;
                renumber(&conn, &drive)?;
            }
        }
        Ok(())
    };
    if let Err(e) = run() {
        log::warn!("Couldn't update {video_id}'s sequences after its Drive changed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_db() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!("kinesis_seq_{}_{}.db", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_file(&path);
        let path = path.to_string_lossy().into_owned();
        db::init_db(&path).unwrap();
        path
    }

    /// Saves videos `a`..`e`-style ids, each filed under the given storage-encoded home Drive.
    fn video(path: &str, id: &str, home: &str) {
        db::save_video(path, id, &format!("Title {id}"), "Author", 60, "text", 1, "2026-01-01T00:00:00Z", "@a", None).unwrap();
        db::update_video_wdbs(path, id, home).unwrap();
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn order(path: &str, drive: &str) -> Vec<String> {
        get_drive_sequence(path, drive).unwrap().into_iter().map(|e| e.video_id).collect()
    }

    #[test]
    fn a_drive_path_must_be_well_formed() {
        assert_eq!(normalize_drive(" :cs-dsa ").unwrap(), ":CS-DSA");
        for bad in ["", ":", "CS", ":CS--DSA", ":CS-", ":CS:DSA", ":CS_DSA"] {
            assert!(normalize_drive(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_sequence_takes_videos_in_order_and_never_a_repeat() {
        let db = temp_db();
        for id in ["v1", "v2", "v3"] {
            video(&db, id, "θψCS_DSA");
        }
        let out = add_to_drive_sequence(&db, ":cs-dsa", &ids(&["v2", "v1", "v2"])).unwrap();
        assert_eq!(out, AddOutcome { added: 2, already_in: 0, not_in_drive: 0 });
        assert_eq!(order(&db, ":CS-DSA"), ["v2", "v1"]);

        // Adding again skips what's there and appends the rest.
        let out = add_to_drive_sequence(&db, ":CS-DSA", &ids(&["v1", "v3"])).unwrap();
        assert_eq!(out, AddOutcome { added: 1, already_in: 1, not_in_drive: 0 });
        assert_eq!(order(&db, ":CS-DSA"), ["v2", "v1", "v3"]);
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn only_videos_at_or_beneath_the_drive_can_join() {
        let db = temp_db();
        video(&db, "dsa", "θψCS_DSA");
        video(&db, "os", "θψCS_OS");
        video(&db, "py", "θψPYTHON");
        // A parent Drive takes videos from below it; a sibling or unrelated Drive does not.
        let out = add_to_drive_sequence(&db, ":CS", &ids(&["dsa", "os", "py", "ghost"])).unwrap();
        assert_eq!(out, AddOutcome { added: 2, already_in: 0, not_in_drive: 2 });
        let out = add_to_drive_sequence(&db, ":CS-DSA", &ids(&["os"])).unwrap();
        assert_eq!(out.not_in_drive, 1);
        // ":CS" is not a prefix match on ":CSX".
        video(&db, "other", "θψCSX");
        assert_eq!(add_to_drive_sequence(&db, ":CS", &ids(&["other"])).unwrap().not_in_drive, 1);
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn an_also_in_link_lets_a_video_join_that_drives_sequence() {
        let db = temp_db();
        video(&db, "v1", "θψCS_DSA");
        db::add_video_wdbs_link(&db, "v1", "θψPYTHON").unwrap();
        assert_eq!(add_to_drive_sequence(&db, ":PYTHON", &ids(&["v1"])).unwrap().added, 1);
        assert_eq!(add_to_drive_sequence(&db, ":CS", &ids(&["v1"])).unwrap().added, 1);
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn the_bar_state_gives_position_and_neighbours_per_drive() {
        let db = temp_db();
        for id in ["v1", "v2", "v3"] {
            video(&db, id, "θψCS_DSA");
        }
        db::add_video_wdbs_link(&db, "v2", "θψPYTHON").unwrap();
        add_to_drive_sequence(&db, ":CS-DSA", &ids(&["v1", "v2", "v3"])).unwrap();
        add_to_drive_sequence(&db, ":PYTHON", &ids(&["v2"])).unwrap();

        let states = get_video_sequence_states(&db, "v2", &ids(&[":CS-DSA", ":PYTHON", ":CS", "bad"])).unwrap();
        let dsa = &states[0];
        assert_eq!((dsa.total, dsa.position), (3, Some(2)));
        assert_eq!((dsa.first.as_deref(), dsa.prev.as_deref(), dsa.next.as_deref()), (Some("v1"), Some("v1"), Some("v3")));
        // Same video, different branch: alone in :PYTHON, so nothing before or after it.
        let py = &states[1];
        assert_eq!((py.total, py.position, py.prev.as_deref(), py.next.as_deref()), (1, Some(1), None, None));
        // A Drive with no sequence, and a malformed path that's ignored.
        assert_eq!(states.len(), 3);
        assert_eq!((states[2].drive.as_str(), states[2].total, states[2].position), (":CS", 0, None));
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn reordering_and_removing_keep_the_positions_tidy() {
        let db = temp_db();
        for id in ["v1", "v2", "v3"] {
            video(&db, id, "θψCS");
        }
        add_to_drive_sequence(&db, ":CS", &ids(&["v1", "v2", "v3"])).unwrap();
        set_drive_sequence_order(&db, ":CS", &ids(&["v3", "v1", "v2"])).unwrap();
        assert_eq!(order(&db, ":CS"), ["v3", "v1", "v2"]);
        // A reorder can't drop, add or repeat a video.
        assert!(set_drive_sequence_order(&db, ":CS", &ids(&["v3", "v1"])).is_err());
        assert!(set_drive_sequence_order(&db, ":CS", &ids(&["v3", "v1", "v1"])).is_err());
        assert!(set_drive_sequence_order(&db, ":CS", &ids(&["v3", "v1", "nope"])).is_err());

        remove_from_drive_sequence(&db, ":CS", "v1").unwrap();
        let positions: Vec<i64> = get_drive_sequence(&db, ":CS").unwrap().iter().map(|e| e.position).collect();
        assert_eq!(positions, [1, 2]);
        assert_eq!(order(&db, ":CS"), ["v3", "v2"]);

        // Clearing takes every video out, leaving the Drive with no sequence.
        clear_drive_sequence(&db, ":CS").unwrap();
        assert!(order(&db, ":CS").is_empty());
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn a_video_leaves_a_sequence_when_it_leaves_the_drive() {
        let db = temp_db();
        video(&db, "v1", "θψCS_DSA");
        video(&db, "v2", "θψCS_DSA");
        add_to_drive_sequence(&db, ":CS", &ids(&["v1", "v2"])).unwrap();
        add_to_drive_sequence(&db, ":CS-DSA", &ids(&["v1", "v2"])).unwrap();

        // Moved to a sibling: still under :CS, no longer under :CS-DSA.
        db::update_video_wdbs(&db, "v1", "θψCS_OS").unwrap();
        assert_eq!(order(&db, ":CS"), ["v1", "v2"]);
        assert_eq!(order(&db, ":CS-DSA"), ["v2"]);
        assert_eq!(get_drive_sequence(&db, ":CS-DSA").unwrap()[0].position, 1);

        // Moved out of CS entirely, but an "Also in" link keeps it in.
        db::add_video_wdbs_link(&db, "v2", "θψCS_DSA").unwrap();
        db::update_video_wdbs(&db, "v2", "θψPYTHON").unwrap();
        assert_eq!(order(&db, ":CS-DSA"), ["v2"]);
        assert_eq!(order(&db, ":CS"), ["v1", "v2"]);
        db::remove_video_wdbs_link(&db, "v2", "θψCS_DSA").unwrap();
        assert!(order(&db, ":CS-DSA").is_empty());
        assert_eq!(order(&db, ":CS"), ["v1"]);
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn the_only_video_cannot_be_removed_one_by_one_but_clearing_empties_the_sequence() {
        let db = temp_db();
        video(&db, "v1", "θψCS");
        video(&db, "v2", "θψCS");
        add_to_drive_sequence(&db, ":CS", &ids(&["v1", "v2"])).unwrap();
        remove_from_drive_sequence(&db, ":CS", "v1").unwrap();
        // One left: removing it by itself is refused, but Clear takes it (and so the sequence) away.
        assert!(remove_from_drive_sequence(&db, ":CS", "v2").is_err());
        assert_eq!(order(&db, ":CS"), ["v2"]);
        clear_drive_sequence(&db, ":CS").unwrap();
        assert!(order(&db, ":CS").is_empty());
        // A Drive with no sequence at all is a harmless no-op.
        clear_drive_sequence(&db, ":OTHER").unwrap();
        std::fs::remove_file(&db).ok();
    }

    /// Saves a video with a publish date and channel so the picker's ordering and search can be told apart.
    fn dated(path: &str, id: &str, title: &str, author: &str, published: &str, home: &str) {
        db::save_video(path, id, title, author, 60, "text", 1, published, "@a", None).unwrap();
        db::update_video_wdbs(path, id, home).unwrap();
    }

    #[test]
    fn the_picker_offers_home_link_and_sub_drive_videos_not_already_in_the_sequence() {
        let db = temp_db();
        dated(&db, "home", "Arrays", "Ann", "2026-01-03T00:00:00Z", "θψCS");
        dated(&db, "sub", "Trees", "Bob", "2026-01-01T00:00:00Z", "θψCS_DSA");
        dated(&db, "deep", "Tries", "Bob", "2026-01-02T00:00:00Z", "θψCS_DSA_TREES");
        dated(&db, "linked", "Pandas", "Cy", "2026-01-04T00:00:00Z", "θψPYTHON");
        db::add_video_wdbs_link(&db, "linked", "θψCS").unwrap();
        dated(&db, "other", "Loops", "Dee", "2026-01-05T00:00:00Z", "θψPYTHON");
        dated(&db, "sibling", "Kernels", "Eve", "2026-01-06T00:00:00Z", "θψCSX");
        add_to_drive_sequence(&db, ":CS", &ids(&["home"])).unwrap();

        // Oldest first; the member, the unrelated Drive and the ":CSX" look-alike are left out.
        let (found, total) = list_drive_videos_for_sequence(&db, ":cs", "", "published", false, 50, 0).unwrap();
        assert_eq!(found.iter().map(|v| v.video_id.as_str()).collect::<Vec<_>>(), ["sub", "deep", "linked"]);
        assert_eq!(total, 3);
        assert_eq!(found[0].title, "Trees");

        // A narrower Drive only sees what's beneath it.
        let (found, _) = list_drive_videos_for_sequence(&db, ":CS-DSA", "", "published", false, 50, 0).unwrap();
        assert_eq!(found.iter().map(|v| v.video_id.as_str()).collect::<Vec<_>>(), ["sub", "deep"]);

        // Search matches the title or the channel, ignoring case.
        let (found, total) = list_drive_videos_for_sequence(&db, ":CS", "BOB", "published", false, 50, 0).unwrap();
        assert_eq!((found.len(), total), (2, 2));
        let (found, _) = list_drive_videos_for_sequence(&db, ":CS", "panda", "published", false, 50, 0).unwrap();
        assert_eq!(found[0].video_id, "linked");

        // Paging: the count covers every page.
        let (page, total) = list_drive_videos_for_sequence(&db, ":CS", "", "published", false, 2, 1).unwrap();
        assert_eq!((page.iter().map(|v| v.video_id.as_str()).collect::<Vec<_>>(), total), (vec!["deep", "linked"], 3));
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn titles_sort_naturally_so_lecture_2_comes_before_lecture_10() {
        use std::cmp::Ordering::*;
        assert_eq!(natural_cmp("Lecture 2", "Lecture 10"), Less);
        assert_eq!(natural_cmp("lecture 10", "Lecture 2"), Greater);
        assert_eq!(natural_cmp("Part 007", "part 7"), Equal);
        assert_eq!(natural_cmp("Intro", "Intro 1"), Less);
        assert_eq!(natural_cmp("Alpha", "beta"), Less);
    }

    #[test]
    fn the_picker_orders_by_upload_date_added_or_title_in_either_direction() {
        let db = temp_db();
        dated(&db, "a", "Lecture 10", "X", "2026-01-02T00:00:00Z", "θψCS");
        dated(&db, "b", "Lecture 2", "X", "2026-01-03T00:00:00Z", "θψCS");
        dated(&db, "c", "Lecture 1", "X", "2026-01-01T00:00:00Z", "θψCS");
        let list = |sort: &str, desc: bool| -> Vec<String> {
            list_drive_videos_for_sequence(&db, ":CS", "", sort, desc, 50, 0).unwrap().0.into_iter().map(|v| v.video_id).collect()
        };
        assert_eq!(list("published", false), ["c", "a", "b"]);
        assert_eq!(list("published", true), ["b", "a", "c"]);
        assert_eq!(list("title", false), ["c", "b", "a"]);
        assert_eq!(list("title", true), ["a", "b", "c"]);
        // Saved one after another, so the library's own order matches the order they were saved in.
        assert_eq!(list("added", false).len(), 3);
        assert!(list_drive_videos_for_sequence(&db, ":CS", "", "nonsense", false, 50, 0).is_err());
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn selected_videos_are_appended_in_the_chosen_order_not_the_order_given() {
        let db = temp_db();
        dated(&db, "a", "Third", "X", "2026-01-03T00:00:00Z", "θψCS");
        dated(&db, "b", "First", "X", "2026-01-01T00:00:00Z", "θψCS");
        dated(&db, "c", "Second", "X", "2026-01-02T00:00:00Z", "θψCS");
        add_to_drive_sequence_sorted(&db, ":CS", &ids(&["a", "b", "c"]), "published", false).unwrap();
        assert_eq!(order(&db, ":CS"), ["b", "c", "a"]);
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn select_all_then_untick_adds_every_match_but_the_excluded_in_order() {
        let db = temp_db();
        dated(&db, "old", "Old", "X", "2026-01-01T00:00:00Z", "θψCS");
        dated(&db, "mid", "Mid", "X", "2026-01-02T00:00:00Z", "θψCS_DSA");
        dated(&db, "skip", "Skip me", "X", "2026-01-03T00:00:00Z", "θψCS");
        dated(&db, "new", "New", "X", "2026-01-04T00:00:00Z", "θψCS");
        dated(&db, "elsewhere", "Elsewhere", "X", "2026-01-05T00:00:00Z", "θψPYTHON");
        // One is already in, and stays where it is.
        add_to_drive_sequence(&db, ":CS", &ids(&["new"])).unwrap();

        let out = add_matching_to_drive_sequence(&db, ":CS", "", "published", false, &ids(&["skip"]), &[]).unwrap();
        assert_eq!(out, AddOutcome { added: 2, already_in: 0, not_in_drive: 0 });
        assert_eq!(order(&db, ":CS"), ["new", "old", "mid"]);

        // Newest first, narrowed by the search: only what matches, none of it repeated.
        dated(&db, "later", "Later", "X", "2026-01-06T00:00:00Z", "θψCS");
        dated(&db, "later2", "Later too", "X", "2026-01-07T00:00:00Z", "θψCS");
        let out = add_matching_to_drive_sequence(&db, ":CS", "later", "published", true, &[], &[]).unwrap();
        assert_eq!(out.added, 2);
        assert_eq!(&order(&db, ":CS")[3..], ["later2", "later"]);
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn child_drives_are_the_next_level_down_with_or_without_a_sequence() {
        let db = temp_db();
        video(&db, "pnd1", "θψDUPED_FRW_PND");
        video(&db, "pnd2", "θψDUPED_FRW_PND");
        video(&db, "vvv1", "θψDUPED_FRW_VVV");
        video(&db, "deep", "θψDUPED_FRW_VVV_X");
        video(&db, "other", "θψDUPED_ABC");
        video(&db, "lookalike", "θψDUPED_FRWX");
        // Linked into VVV from elsewhere: it counts there too.
        video(&db, "linked", "θψPYTHON");
        db::add_video_wdbs_link(&db, "linked", "θψDUPED_FRW_VVV").unwrap();
        add_to_drive_sequence(&db, ":DUPED-FRW-PND", &ids(&["pnd1", "pnd2"])).unwrap();

        let listed = |drive: &str| -> Vec<(String, i64, i64)> {
            get_child_drives(&db, drive).unwrap().into_iter().map(|c| (c.drive, c.videos, c.sequence_total)).collect()
        };
        // At FRW: PND and VVV only (not X beneath VVV, not the ":FRWX" look-alike, not ABC).
        assert_eq!(listed(":DUPED-FRW"), [(":DUPED-FRW-PND".to_string(), 2, 2), (":DUPED-FRW-VVV".to_string(), 3, 0)]);
        // At the top: every second-level node, counting what's beneath each.
        assert_eq!(
            listed(":DUPED"),
            [(":DUPED-ABC".to_string(), 1, 0), (":DUPED-FRW".to_string(), 5, 0), (":DUPED-FRWX".to_string(), 1, 0)]
        );
        // A Drive nothing is filed beneath has no children.
        assert!(listed(":DUPED-FRW-PND").is_empty());
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn deleting_a_video_removes_it_from_its_sequences() {
        let db = temp_db();
        for id in ["v1", "v2", "v3"] {
            video(&db, id, "θψCS");
        }
        add_to_drive_sequence(&db, ":CS", &ids(&["v1", "v2", "v3"])).unwrap();
        db::delete_video(&db, "v2").unwrap();
        assert_eq!(order(&db, ":CS"), ["v1", "v3"]);
        // The gap left behind doesn't break the bar.
        let states = get_video_sequence_states(&db, "v3", &ids(&[":CS"])).unwrap();
        assert_eq!((states[0].total, states[0].position, states[0].prev.as_deref(), states[0].next.as_deref()), (2, Some(2), Some("v1"), None));
        std::fs::remove_file(&db).ok();
    }
}
