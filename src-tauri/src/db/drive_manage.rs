//! Managing the Drive itself: the Manage Drive window's tree (every node, empty ones included), what's
//! filed where, and changing its shape: adding a Drive, renaming, moving or merging one (one operation,
//! `relocate_drive`), and deleting an empty one.
//!
//! A Drive path is referenced from six places, and a change of shape keeps all of them in step:
//!   - tblWDBS, the registered nodes (display form, ":CS-DSA"), with their alias/icon/color/marker;
//!   - Videos.WDBS, each video's home (storage form, "θψCS_DSA");
//!   - VideoWDBSLinks, the "Also in" links (storage form);
//!   - DriveSequence.drive, the sequences (display form);
//!   - Glossary.drives, the roots a term is filed under (display form, top level only);
//!   - `kinesis://drive/<storage form>` links in text (see db/links.rs).
//!
//! The hand-maintained production schema shapes how this is written: a video's WDBS must already exist
//! in tblWDBS (a trigger checks every insert and update), and updating tblWDBS.WDBS itself fires a merge
//! trigger that cancels the update. So a node is never renamed in place: the new rows are registered
//! first, everything is pointed at them, and the old rows are deleted last, deepest first (the delete
//! trigger refuses a node that something still depends on). All of it happens in one transaction.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

use super::glossary::{decode_drives, encode_drives, is_root_path, sorted_unique};
use super::links::{apply_link_edits, count_texts_linking, LinkEdit, LinkKind};
use super::schema::table_exists;
use super::sequences::{covers, normalize_drive, renumber, video_drives};
use super::wdbs::{ensure_wdbs_path_exists_with_conn, is_unassigned_sentinel, storage_to_display_path, WDBS_COLORS, WDBS_ICONS, WDBS_SHAPES};

fn invalid(msg: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::InvalidInput, msg.into())))
}

/// Longest name a new Drive (one segment) may have.
const MAX_SEGMENT_CHARS: usize = 64;

/// ":CS-DSA" -> "θψCS_DSA", the form Videos.WDBS and VideoWDBSLinks store.
pub(crate) fn display_to_storage(display: &str) -> String {
    format!("θψ{}", display.trim_start_matches(':').replace('-', "_"))
}

fn level(display: &str) -> usize {
    display.trim_start_matches(':').split('-').count()
}

fn root_of(display: &str) -> String {
    format!(":{}", display.trim_start_matches(':').split('-').next().unwrap_or(""))
}

fn last_segment(display: &str) -> &str {
    display.rsplit(['-', ':']).next().unwrap_or("")
}

/// Where `path` (at or beneath `from`) ends up when `from` becomes `to`.
fn map_path(from: &str, to: &str, path: &str) -> String {
    format!("{to}{}", &path[from.len()..])
}

/// A new Drive name (one segment): trimmed and uppercased. Refused when empty, too long, or holding
/// anything but A-Z and 0-9: the same rule the app's Drive inputs apply as you type (src/lib/wdbs-input.ts).
pub fn normalize_segment(raw: &str) -> Result<String> {
    let s = raw.trim().to_uppercase();
    if s.is_empty() {
        return Err(invalid("A Drive needs a name."));
    }
    if !s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
        return Err(invalid(format!("'{s}' can't be a Drive name: only letters A-Z and digits 0-9.")));
    }
    if s.chars().count() > MAX_SEGMENT_CHARS {
        return Err(invalid(format!("A Drive name can be at most {MAX_SEGMENT_CHARS} characters.")));
    }
    Ok(s)
}

/// SQL matching a storage-form column that is `?1` or beneath it. Not GLOB/LIKE: '_' is the separator
/// and must match only itself.
fn storage_under(column: &str) -> String {
    format!("({column} = ?1 OR substr({column}, 1, length(?1) + 1) = ?1 || '_')")
}

/// Every Drive path the database knows about, in display form: registered nodes, videos' homes and
/// links, sequences and glossary roots, plus every level above each of them.
fn known_paths(conn: &Connection) -> Result<BTreeSet<String>> {
    let mut raw: Vec<String> = Vec::new();
    if table_exists(conn, "tblWDBS")? {
        let mut stmt = conn.prepare("SELECT WDBS FROM tblWDBS")?;
        raw.extend(stmt.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()));
    }
    let mut storage: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT DISTINCT WDBS FROM Videos WHERE WDBS IS NOT NULL UNION SELECT WDBS FROM VideoWDBSLinks")?;
        storage.extend(stmt.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()));
    }
    raw.extend(storage.iter().filter(|s| !s.is_empty() && !is_unassigned_sentinel(s)).map(|s| storage_to_display_path(s)));
    {
        let mut stmt = conn.prepare("SELECT DISTINCT drive FROM DriveSequence")?;
        raw.extend(stmt.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()));
    }
    {
        let mut stmt = conn.prepare("SELECT DISTINCT drives FROM Glossary WHERE drives != ''")?;
        let lists: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect();
        raw.extend(lists.iter().flat_map(|l| decode_drives(l)));
    }
    let mut out = BTreeSet::new();
    for p in raw {
        // Skips the ":" root node and anything malformed (hand-edited rows).
        let Ok(p) = normalize_drive(&p) else { continue };
        let segments: Vec<&str> = p.trim_start_matches(':').split('-').collect();
        for i in 1..=segments.len() {
            out.insert(format!(":{}", segments[..i].join("-")));
        }
    }
    Ok(out)
}

/// `from` and every known path beneath it, shallowest first.
fn subtree(known: &BTreeSet<String>, from: &str) -> Vec<String> {
    let mut paths: Vec<String> = known.iter().filter(|p| covers(from, p)).cloned().collect();
    paths.sort_by_key(|p| (level(p), p.clone()));
    paths
}

// ─── The tree ────────────────────────────────────────────────────────────────

/// One node of the Manage Drive tree. Unlike the Library's Drive tree (db::get_wdbs_tree), which only
/// has the nodes videos are filed under, this has every node, empty ones too, since it's where they're
/// made and tidied.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManageNode {
    pub segment: String,
    /// Display form, ":CS-DSA".
    pub display: String,
    /// Storage form, "θψCS_DSA" (what the Library's Drive filter and the tree popovers use).
    pub path: String,
    /// The curated alias, when it says more than the segment's own name.
    pub alias: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub shape: Option<String>,
    /// Videos whose home is exactly this Drive.
    pub filed: i64,
    /// "Also in" links to exactly this Drive.
    pub linked: i64,
    /// Distinct videos here or beneath, either way.
    pub total: i64,
    /// Videos in this Drive's own sequence.
    pub sequence: i64,
    /// Glossary entries filed under it (top-level Drives only; always 0 below that).
    pub terms: i64,
    pub children: Vec<ManageNode>,
}

#[derive(Default)]
struct Acc {
    filed: i64,
    linked: i64,
    videos: HashSet<String>,
    children: BTreeMap<String, Acc>,
}

/// Calls `f` on every node from the top level down to `display` (creating them as needed).
fn walk(root: &mut Acc, display: &str, mut f: impl FnMut(&mut Acc, bool)) {
    let segments: Vec<&str> = display.trim_start_matches(':').split('-').collect();
    let mut node = root;
    for (i, seg) in segments.iter().enumerate() {
        node = node.children.entry(seg.to_string()).or_default();
        f(node, i + 1 == segments.len());
    }
}

struct Curated {
    info: String,
    icon: String,
    color: String,
    shape: String,
}

pub fn get_drive_manage_tree(db_path: &str) -> Result<Vec<ManageNode>> {
    let conn = Connection::open(db_path)?;
    let mut root = Acc::default();
    for p in known_paths(&conn)? {
        walk(&mut root, &p, |_, _| {});
    }

    let rows = |sql: &str| -> Result<Vec<(String, String)>> {
        let mut stmt = conn.prepare(sql)?;
        let out = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.filter_map(|r| r.ok()).collect();
        Ok(out)
    };
    for (video, storage) in rows("SELECT video_id, WDBS FROM Videos WHERE WDBS IS NOT NULL AND WDBS != ''")? {
        if is_unassigned_sentinel(&storage) {
            continue;
        }
        let Ok(display) = normalize_drive(&storage_to_display_path(&storage)) else { continue };
        walk(&mut root, &display, |n, last| {
            n.videos.insert(video.clone());
            if last {
                n.filed += 1;
            }
        });
    }
    for (video, storage) in rows("SELECT video_id, WDBS FROM VideoWDBSLinks")? {
        if is_unassigned_sentinel(&storage) {
            continue;
        }
        let Ok(display) = normalize_drive(&storage_to_display_path(&storage)) else { continue };
        walk(&mut root, &display, |n, last| {
            n.videos.insert(video.clone());
            if last {
                n.linked += 1;
            }
        });
    }

    let mut sequences: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT drive, COUNT(*) FROM DriveSequence GROUP BY drive")?;
        for (d, n) in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.filter_map(|r| r.ok()) {
            sequences.insert(d, n);
        }
    }
    let mut terms: HashMap<String, i64> = HashMap::new();
    for (_, drives) in rows("SELECT term, drives FROM Glossary WHERE drives != ''")? {
        for d in decode_drives(&drives) {
            *terms.entry(d).or_default() += 1;
        }
    }
    let mut curated: HashMap<String, Curated> = HashMap::new();
    if table_exists(&conn, "tblWDBS")? {
        let mut stmt = conn.prepare("SELECT WDBS, WDInfo, WDIcon, WDColor, WDShape FROM tblWDBS")?;
        let found = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, Curated { info: r.get(1)?, icon: r.get(2)?, color: r.get(3)?, shape: r.get(4)? }))
        })?;
        for (path, c) in found.filter_map(|r| r.ok()) {
            curated.insert(path, c);
        }
    }

    fn build(acc: &Acc, prefix: &str, seq: &HashMap<String, i64>, terms: &HashMap<String, i64>, curated: &HashMap<String, Curated>) -> Vec<ManageNode> {
        acc.children
            .iter()
            .map(|(segment, child)| {
                let display = if prefix.is_empty() { format!(":{segment}") } else { format!("{prefix}-{segment}") };
                let c = curated.get(&display);
                let pick = |v: Option<&String>, allowed: &[&str]| v.filter(|s| allowed.contains(&s.as_str())).cloned();
                ManageNode {
                    segment: segment.clone(),
                    path: display_to_storage(&display),
                    alias: c.map(|c| c.info.trim().to_string()).filter(|a| !a.is_empty() && a != segment),
                    icon: pick(c.map(|c| &c.icon), WDBS_ICONS),
                    color: pick(c.map(|c| &c.color), WDBS_COLORS),
                    shape: pick(c.map(|c| &c.shape), WDBS_SHAPES),
                    filed: child.filed,
                    linked: child.linked,
                    total: child.videos.len() as i64,
                    sequence: seq.get(&display).copied().unwrap_or(0),
                    terms: if prefix.is_empty() { terms.get(&display).copied().unwrap_or(0) } else { 0 },
                    children: build(child, &display, seq, terms, curated),
                    display,
                }
            })
            .collect()
    }
    Ok(build(&root, "", &sequences, &terms, &curated))
}

// ─── Sequences and members ───────────────────────────────────────────────────

/// One Drive's sequence: for the Manage Drive window's list of them all, the Link to picker's Sequence tab, and the
/// "playlist" card a sequence link previews (the first video's thumbnail comes from its id).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SequenceSummary {
    /// Display form.
    pub drive: String,
    pub count: i64,
    /// Entries whose video has since left the Drive (or the library). Sequences are tidied as videos
    /// move, so this is normally 0; a hand-edited or synced database can still have some.
    pub stale: i64,
    /// The video first in the sequence right now (what a sequence link opens), and its title.
    pub first_video_id: Option<String>,
    pub first_title: Option<String>,
}

/// Every Drive that has a sequence, by name; or just `only` (a display path), when given.
fn sequence_summaries(conn: &Connection, only: Option<&str>) -> Result<Vec<SequenceSummary>> {
    let rows: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT s.drive, s.video_id, v.title FROM DriveSequence s LEFT JOIN Videos v ON v.video_id = s.video_id
             WHERE ?1 IS NULL OR s.drive = ?1
             ORDER BY s.drive, s.position, s.video_id",
        )?;
        let found = stmt.query_map(params![only], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        found.collect::<Result<_>>()?
    };
    let mut out: Vec<SequenceSummary> = Vec::new();
    for (drive, video, title) in rows {
        let fine = video_drives(conn, &video)?.iter().any(|d| covers(&drive, d));
        match out.last_mut() {
            Some(s) if s.drive == drive => {
                s.count += 1;
                s.stale += i64::from(!fine);
            }
            // Rows come in position order, so the first one of a Drive is its first video.
            _ => out.push(SequenceSummary {
                drive,
                count: 1,
                stale: i64::from(!fine),
                first_title: Some(title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| video.clone())),
                first_video_id: Some(video),
            }),
        }
    }
    Ok(out)
}

/// Every Drive that has a sequence, by name.
pub fn list_drive_sequences(db_path: &str) -> Result<Vec<SequenceSummary>> {
    let conn = Connection::open(db_path)?;
    sequence_summaries(&conn, None)
}

/// One Drive's sequence (display path), or None when it has none.
pub fn get_sequence_summary(db_path: &str, drive: &str) -> Result<Option<SequenceSummary>> {
    let drive = normalize_drive(drive)?;
    let conn = Connection::open(db_path)?;
    Ok(sequence_summaries(&conn, Some(&drive))?.into_iter().next())
}

/// A video filed at a Drive, as the Manage Drive window lists them.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriveMember {
    pub video_id: String,
    pub title: String,
    pub author: Option<String>,
    pub handle: Option<String>,
    /// Where this row files it (display form): the Drive itself or one beneath it.
    pub at: String,
    /// Through an "Also in" link rather than as its home.
    pub via_link: bool,
    /// The video's home (display form), for a linked row.
    pub home: Option<String>,
}

/// The videos filed at `display` (and, with `include_sub`, beneath it): one row per home and one per
/// "Also in" link, so a video filed both ways shows twice.
pub fn list_drive_members(db_path: &str, display: &str, include_sub: bool) -> Result<Vec<DriveMember>> {
    let display = normalize_drive(display)?;
    let storage = display_to_storage(&display);
    let home_match = if include_sub { storage_under("v.WDBS") } else { "v.WDBS = ?1".to_string() };
    let link_match = if include_sub { storage_under("l.WDBS") } else { "l.WDBS = ?1".to_string() };
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT v.video_id, v.title, v.author, v.handle, v.WDBS, v.WDBS, 0 FROM Videos v WHERE {home_match}
         UNION ALL
         SELECT v.video_id, v.title, v.author, v.handle, l.WDBS, v.WDBS, 1 FROM VideoWDBSLinks l JOIN Videos v ON v.video_id = l.video_id WHERE {link_match}
         ORDER BY 2 COLLATE NOCASE, 1"
    ))?;
    let rows = stmt.query_map(params![storage], |r| {
        let video_id: String = r.get(0)?;
        let title: Option<String> = r.get(1)?;
        let at: String = r.get(4)?;
        let home: Option<String> = r.get(5)?;
        let via_link = r.get::<_, i64>(6)? == 1;
        Ok(DriveMember {
            title: title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| video_id.clone()),
            video_id,
            author: r.get(2)?,
            handle: r.get(3)?,
            at: storage_to_display_path(&at),
            via_link,
            home: if via_link { home.filter(|h| !h.is_empty() && !is_unassigned_sentinel(h)).map(|h| storage_to_display_path(&h)) } else { None },
        })
    })?;
    rows.collect()
}

// ─── Adding ──────────────────────────────────────────────────────────────────

/// Registers a new Drive named `segment` under `parent` (a display path), or at the top level. Returns
/// its display path. Refused when that Drive already exists.
pub fn create_drive(db_path: &str, parent: Option<&str>, segment: &str) -> Result<String> {
    let segment = normalize_segment(segment)?;
    let display = match parent.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => format!("{}-{segment}", normalize_drive(p)?),
        None => format!(":{segment}"),
    };
    let conn = Connection::open(db_path)?;
    if known_paths(&conn)?.contains(&display) {
        return Err(invalid(format!("{display} already exists.")));
    }
    ensure_wdbs_path_exists_with_conn(&conn, &display)?;
    Ok(display)
}

// ─── Renaming, moving and merging ────────────────────────────────────────────

/// What a rename/move/merge did (or, for a dry run, would do).
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelocateReport {
    pub from: String,
    pub to: String,
    /// `to` already existed, so the two are merged.
    pub merged: bool,
    /// Drives moved (the one given and everything beneath it).
    pub drives: i64,
    /// Videos whose home changed.
    pub videos: i64,
    /// "Also in" links that changed.
    pub links: i64,
    /// Sequences that moved (or were appended to the target's, when merging).
    pub sequences: i64,
    /// Glossary entries refiled.
    pub terms: i64,
    /// When a top-level Drive moves under another, its glossary entries go to the new top level: this one.
    pub terms_moved_to: Option<String>,
    /// Texts (summaries, notes, definitions, ...) whose links to the moved Drives are updated.
    pub texts: i64,
}

/// Moves `from` and everything beneath it to `to` (display paths). Renaming is a move to a sibling
/// name, moving is a move under another parent, and moving onto a Drive that already exists merges the
/// two (videos, links and sequences come together; the target keeps its own alias and looks where it
/// has them). `dry_run` works it all out and reports it without keeping any of it.
pub fn relocate_drive(db_path: &str, from: &str, to: &str, dry_run: bool) -> Result<RelocateReport> {
    let from = normalize_drive(from)?;
    let to = normalize_drive(to)?;
    if from == to {
        return Err(invalid("That's where it already is."));
    }
    if covers(&from, &to) {
        return Err(invalid(format!("{from} can't go inside itself.")));
    }

    let mut conn = Connection::open(db_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    let known = known_paths(&conn)?;
    let moving = subtree(&known, &from);
    if moving.is_empty() {
        return Err(invalid(format!("There's no {from}.")));
    }
    let merged = known.iter().any(|p| covers(&to, p));
    if !merged {
        // A brand-new name: it has to be a valid one. (An existing target is taken as it is.)
        normalize_segment(last_segment(&to))?;
    }
    let old_storage: Vec<String> = moving.iter().map(|p| display_to_storage(p)).collect();
    // Counted before any write, on this connection, so it reads the database as it stands. Links to the Drives
    // (storage form) and to their sequences (display form) both follow the move.
    let texts = count_texts_linking(db_path, &[(LinkKind::Drive, &old_storage), (LinkKind::Playlist, &moving)])? as i64;

    let mut report = RelocateReport { from: from.clone(), to: to.clone(), merged, texts, ..Default::default() };
    let tx = conn.transaction()?;
    let has_tbl = table_exists(&tx, "tblWDBS")?;
    let mut touched: HashSet<String> = HashSet::new();

    for path in &moving {
        let new_path = map_path(&from, &to, path);
        let (s, ns) = (display_to_storage(path), display_to_storage(&new_path));
        report.drives += 1;

        // 1. The new node, with the old one's looks where the new one has none of its own.
        if has_tbl {
            ensure_wdbs_path_exists_with_conn(&tx, &new_path)?;
            let read = |p: &str| -> Result<Option<(String, String, String, String, String)>> {
                tx.query_row(
                    "SELECT WDID, WDInfo, WDIcon, WDColor, WDShape FROM tblWDBS WHERE WDBS = ?1",
                    params![p],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .optional()
            };
            if let (Some(old), Some(new)) = (read(path)?, read(&new_path)?) {
                let old_alias = Some(old.1.trim()).filter(|a| !a.is_empty() && *a != old.0);
                let new_alias_curated = !new.1.trim().is_empty() && new.1.trim() != new.0;
                let info = match old_alias {
                    Some(a) if !new_alias_curated => a.to_string(),
                    _ => new.1,
                };
                let keep = |old: String, new: String| if new.is_empty() { old } else { new };
                tx.execute(
                    "UPDATE tblWDBS SET WDInfo = ?1, WDIcon = ?2, WDColor = ?3, WDShape = ?4 WHERE WDBS = ?5",
                    params![info, keep(old.2, new.2), keep(old.3, new.3), keep(old.4, new.4), new_path],
                )?;
            }
        }

        // 2. Homes.
        {
            let mut stmt = tx.prepare("SELECT video_id FROM Videos WHERE WDBS = ?1")?;
            touched.extend(stmt.query_map(params![s], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()));
        }
        report.videos += tx.execute("UPDATE Videos SET WDBS = ?2 WHERE WDBS = ?1", params![s, ns])? as i64;

        // 3. Links. One the target already has is kept once; one that now equals the video's home goes.
        let linked: Vec<String> = {
            let mut stmt = tx.prepare("SELECT video_id FROM VideoWDBSLinks WHERE WDBS = ?1")?;
            let rows = stmt.query_map(params![s], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect();
            rows
        };
        for video in &linked {
            tx.execute("INSERT OR IGNORE INTO VideoWDBSLinks (video_id, WDBS) VALUES (?1, ?2)", params![video, ns])?;
        }
        tx.execute("DELETE FROM VideoWDBSLinks WHERE WDBS = ?1", params![s])?;
        tx.execute(
            "DELETE FROM VideoWDBSLinks WHERE WDBS = ?1 AND EXISTS (SELECT 1 FROM Videos v WHERE v.video_id = VideoWDBSLinks.video_id AND v.WDBS = ?1)",
            params![ns],
        )?;
        report.links += linked.len() as i64;
        touched.extend(linked);

        // 4. The sequence: renamed, or appended to the target's (skipping videos already in it).
        let entries: Vec<String> = {
            let mut stmt = tx.prepare("SELECT video_id FROM DriveSequence WHERE drive = ?1 ORDER BY position, video_id")?;
            let rows = stmt.query_map(params![path], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect();
            rows
        };
        if !entries.is_empty() {
            report.sequences += 1;
            let mut next: i64 = tx.query_row("SELECT COALESCE(MAX(position), 0) FROM DriveSequence WHERE drive = ?1", params![new_path], |r| r.get(0))?;
            for video in &entries {
                next += 1;
                tx.execute("INSERT OR IGNORE INTO DriveSequence (drive, video_id, position) VALUES (?1, ?2, ?3)", params![new_path, video, next])?;
            }
            tx.execute("DELETE FROM DriveSequence WHERE drive = ?1", params![path])?;
            renumber(&tx, &new_path)?;
        }
    }

    // 5. Sequences above the moved Drives may have held videos that are no longer beneath them.
    for video in &touched {
        let drives = video_drives(&tx, video)?;
        let member_of: Vec<String> = {
            let mut stmt = tx.prepare("SELECT drive FROM DriveSequence WHERE video_id = ?1")?;
            let rows = stmt.query_map(params![video], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect();
            rows
        };
        for drive in member_of {
            if !drives.iter().any(|d| covers(&drive, d)) {
                tx.execute("DELETE FROM DriveSequence WHERE drive = ?1 AND video_id = ?2", params![drive, video])?;
                renumber(&tx, &drive)?;
            }
        }
    }

    // 6. Glossary entries, which are only ever filed at the top level.
    if level(&from) == 1 {
        let target_root = root_of(&to);
        if target_root != from {
            report.terms = refile_glossary_root(&tx, &from, &target_root)?;
            if level(&to) > 1 && report.terms > 0 {
                report.terms_moved_to = Some(target_root);
            }
        }
    }

    // 7. The old nodes, deepest first, now that nothing points at them.
    if has_tbl {
        for path in moving.iter().rev() {
            tx.execute("DELETE FROM tblWDBS WHERE WDBS = ?1", params![path])?;
        }
    }

    if dry_run {
        return Ok(report); // dropping `tx` rolls it all back
    }
    tx.commit()?;

    // 8. Links in text, after the commit (they're rewritten through their own connection).
    let edits: Vec<LinkEdit> = moving
        .iter()
        .flat_map(|p| {
            let np = map_path(&from, &to, p);
            [
                LinkEdit::Retarget(LinkKind::Drive, display_to_storage(p), display_to_storage(&np)),
                LinkEdit::Retarget(LinkKind::Playlist, p.clone(), np),
            ]
        })
        .collect();
    if let Err(e) = apply_link_edits(db_path, &edits) {
        log::warn!("Couldn't update links to {from} after moving it to {to}: {e}");
    }
    Ok(report)
}

/// Replaces `from_root` with `to_root` in every glossary entry filed under it. Entries of one term that
/// end up with the same definition become one; a Drive that would hold two different definitions of a
/// term refuses the whole change (nothing is written). Returns how many entries were refiled.
fn refile_glossary_root(tx: &Connection, from_root: &str, to_root: &str) -> Result<i64> {
    let affected: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT term FROM Glossary WHERE instr(char(10) || drives || char(10), char(10) || ?1 || char(10)) > 0",
        )?;
        let rows = stmt.query_map(params![from_root], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect();
        rows
    };
    let mut refiled = 0;
    let mut conflicts: Vec<String> = Vec::new();
    let mut plans: Vec<(String, Vec<(String, Vec<String>)>)> = Vec::new();
    for term in affected {
        let rows: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare("SELECT term, definition, drives FROM Glossary WHERE term = ?1 ORDER BY drives")?;
            let found = stmt.query_map(params![term], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.filter_map(|r| r.ok()).collect();
            found
        };
        let spelling = rows.first().map(|r| r.0.clone()).unwrap_or(term);
        let mut by_definition: Vec<(String, Vec<String>)> = Vec::new();
        for (_, definition, raw) in rows {
            let mut drives = decode_drives(&raw);
            if drives.iter().any(|d| d == from_root) {
                refiled += 1;
                for d in drives.iter_mut().filter(|d| *d == from_root) {
                    *d = to_root.to_string();
                }
            }
            match by_definition.iter_mut().find(|(def, _)| *def == definition) {
                Some((_, all)) => all.extend(drives),
                None => by_definition.push((definition, drives)),
            }
        }
        for (_, drives) in by_definition.iter_mut() {
            *drives = sorted_unique(std::mem::take(drives));
        }
        let mut owner: HashMap<&str, usize> = HashMap::new();
        let clash = by_definition.iter().enumerate().any(|(i, (_, drives))| drives.iter().any(|d| *owner.entry(d.as_str()).or_insert(i) != i));
        if clash {
            conflicts.push(spelling.clone());
        }
        plans.push((spelling, by_definition));
    }
    if !conflicts.is_empty() {
        return Err(invalid(format!(
            "The Glossary has different definitions for {} in {from_root} and {to_root}. Give one a qualifier (like 'Term (chem)') or remove one first.",
            conflicts.iter().map(|t| format!("'{t}'")).collect::<Vec<_>>().join(", ")
        )));
    }
    for (term, entries) in plans {
        tx.execute("DELETE FROM Glossary WHERE term = ?1", params![term])?;
        for (definition, drives) in entries {
            debug_assert!(drives.iter().all(|d| is_root_path(d)));
            tx.execute("INSERT INTO Glossary (term, definition, drives) VALUES (?1, ?2, ?3)", params![term, definition, encode_drives(&drives)])?;
        }
    }
    Ok(refiled)
}

// ─── Deleting ────────────────────────────────────────────────────────────────

/// What deleting a Drive did (or would do).
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub drive: String,
    /// Drives removed (the one given and everything beneath it).
    pub drives: i64,
    /// Texts whose links to them are turned back into plain text.
    pub texts: i64,
}

/// Deletes `display` and everything beneath it, but only when nothing is filed there: no video's home,
/// no "Also in" link, no glossary entry. (A sequence can only hold videos filed there, so whatever
/// sequence rows are left are stale and go too.) Refused otherwise, saying what's still there.
pub fn delete_drive(db_path: &str, display: &str, dry_run: bool) -> Result<DeleteReport> {
    let display = normalize_drive(display)?;
    let mut conn = Connection::open(db_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    let known = known_paths(&conn)?;
    let removing = subtree(&known, &display);
    if removing.is_empty() {
        return Err(invalid(format!("There's no {display}.")));
    }
    let storage = display_to_storage(&display);
    let homes: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM Videos WHERE {}", storage_under("WDBS")), params![storage], |r| r.get(0))?;
    let links: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM VideoWDBSLinks WHERE {}", storage_under("WDBS")), params![storage], |r| r.get(0))?;
    let terms: i64 = if level(&display) == 1 {
        conn.query_row(
            "SELECT COUNT(*) FROM Glossary WHERE instr(char(10) || drives || char(10), char(10) || ?1 || char(10)) > 0",
            params![display],
            |r| r.get(0),
        )?
    } else {
        0
    };
    let mut still: Vec<String> = Vec::new();
    if homes > 0 {
        still.push(format!("{homes} video{} filed there", if homes == 1 { "" } else { "s" }));
    }
    if links > 0 {
        still.push(format!("{links} \"Also in\" link{}", if links == 1 { "" } else { "s" }));
    }
    if terms > 0 {
        still.push(format!("{terms} glossary entr{}", if terms == 1 { "y" } else { "ies" }));
    }
    if !still.is_empty() {
        return Err(invalid(format!("{display} still has {}. Move or merge them first.", still.join(", "))));
    }

    let old_storage: Vec<String> = removing.iter().map(|p| display_to_storage(p)).collect();
    let texts = count_texts_linking(db_path, &[(LinkKind::Drive, &old_storage), (LinkKind::Playlist, &removing)])? as i64;
    let report = DeleteReport { drive: display.clone(), drives: removing.len() as i64, texts };
    if dry_run {
        return Ok(report);
    }
    let tx = conn.transaction()?;
    for path in &removing {
        tx.execute("DELETE FROM DriveSequence WHERE drive = ?1", params![path])?;
    }
    if table_exists(&tx, "tblWDBS")? {
        for path in removing.iter().rev() {
            tx.execute("DELETE FROM tblWDBS WHERE WDBS = ?1", params![path])?;
        }
    }
    tx.commit()?;
    let edits: Vec<LinkEdit> = old_storage
        .into_iter()
        .map(|s| LinkEdit::Unlink(LinkKind::Drive, s))
        .chain(removing.iter().map(|p| LinkEdit::Unlink(LinkKind::Playlist, p.clone())))
        .collect();
    if let Err(e) = apply_link_edits(db_path, &edits) {
        log::warn!("Couldn't remove links to deleted {display}: {e}");
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        add_to_drive_sequence, add_video_wdbs_link, get_drive_sequence, get_glossary_terms, get_video_wdbs_links, get_video_wdbs_primary,
        init_db, save_glossary_term, save_video, set_wdbs_alias, set_wdbs_icon, update_video_wdbs,
    };
    use crate::db::attachments::{get_note, set_note};
    use crate::db::links::build_link;

    fn temp_db(name: &str) -> String {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("kinesis_drivemanage_{name}_{nanos}.db"));
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn video(db: &str, id: &str, drive: &str) {
        save_video(db, id, &format!("Video {id}"), "Author", 60, "words", 1, "2026-01-01T00:00:00Z", "@creator", None).unwrap();
        crate::db::ensure_wdbs_path_exists(db, drive).unwrap();
        update_video_wdbs(db, id, &display_to_storage(drive)).unwrap();
    }

    fn find<'a>(nodes: &'a [ManageNode], display: &str) -> Option<&'a ManageNode> {
        for n in nodes {
            if n.display == display {
                return Some(n);
            }
            if let Some(found) = find(&n.children, display) {
                return Some(found);
            }
        }
        None
    }

    fn registered(db: &str, display: &str) -> bool {
        let conn = Connection::open(db).unwrap();
        conn.query_row("SELECT COUNT(*) FROM tblWDBS WHERE WDBS = ?1", params![display], |r| r.get::<_, i64>(0)).unwrap() > 0
    }

    #[test]
    fn segment_names_are_uppercased_and_checked() {
        assert_eq!(normalize_segment("  dsa ").unwrap(), "DSA");
        assert_eq!(normalize_segment("x2").unwrap(), "X2");
        for bad in ["", "  ", "A-B", "A_B", "A:B", "A B", "A.B", "CAFÉ", "A/B"] {
            assert!(normalize_segment(bad).is_err(), "{bad:?}");
        }
        assert!(normalize_segment(&"X".repeat(MAX_SEGMENT_CHARS + 1)).is_err());
    }

    #[test]
    fn the_tree_has_empty_drives_and_counts_each_way() {
        let db = temp_db("tree");
        video(&db, "a", ":CS-DSA");
        video(&db, "b", ":CS");
        add_video_wdbs_link(&db, "b", "θψCS_DSA").unwrap();
        create_drive(&db, Some(":CS"), "os").unwrap();
        create_drive(&db, None, "empty").unwrap();
        add_to_drive_sequence(&db, ":CS", &["a".to_string(), "b".to_string()]).unwrap();

        let tree = get_drive_manage_tree(&db).unwrap();
        let cs = find(&tree, ":CS").unwrap();
        assert_eq!((cs.filed, cs.linked, cs.total, cs.sequence), (1, 0, 2, 2));
        let dsa = find(&tree, ":CS-DSA").unwrap();
        assert_eq!((dsa.filed, dsa.linked, dsa.total), (1, 1, 2));
        assert_eq!(dsa.path, "θψCS_DSA");
        let os = find(&tree, ":CS-OS").expect("an empty Drive is in the manage tree");
        assert_eq!(os.total, 0);
        assert!(find(&tree, ":EMPTY").is_some());
        assert!(create_drive(&db, Some(":CS"), "OS").is_err(), "no duplicates");
    }

    #[test]
    fn renaming_moves_videos_links_sequences_looks_and_text_links() {
        let db = temp_db("rename");
        video(&db, "a", ":CS-DSA");
        video(&db, "b", ":CS-DSA-TREES");
        video(&db, "c", ":OTHER");
        add_video_wdbs_link(&db, "c", "θψCS_DSA").unwrap();
        set_wdbs_alias(&db, "θψCS_DSA", "Data Structures").unwrap();
        set_wdbs_icon(&db, "θψCS_DSA", "coding").unwrap();
        add_to_drive_sequence(&db, ":CS-DSA", &["b".to_string(), "a".to_string()]).unwrap();
        add_to_drive_sequence(&db, ":CS", &["a".to_string()]).unwrap();
        set_note(&db, "c", &format!("See {}", build_link("DSA", LinkKind::Drive, "θψCS_DSA_TREES"))).unwrap();

        let preview = relocate_drive(&db, ":CS-DSA", ":CS-ALGO", true).unwrap();
        assert_eq!((preview.merged, preview.drives, preview.videos, preview.links, preview.sequences, preview.texts), (false, 2, 2, 1, 1, 1));
        assert_eq!(get_video_wdbs_primary(&db, "a").unwrap().as_deref(), Some("θψCS_DSA"), "a dry run keeps nothing");

        relocate_drive(&db, ":CS-DSA", ":CS-ALGO", false).unwrap();
        assert_eq!(get_video_wdbs_primary(&db, "a").unwrap().as_deref(), Some("θψCS_ALGO"));
        assert_eq!(get_video_wdbs_primary(&db, "b").unwrap().as_deref(), Some("θψCS_ALGO_TREES"));
        assert_eq!(get_video_wdbs_links(&db, "c").unwrap(), vec!["θψCS_ALGO".to_string()]);
        let seq: Vec<String> = get_drive_sequence(&db, ":CS-ALGO").unwrap().into_iter().map(|e| e.video_id).collect();
        assert_eq!(seq, vec!["b", "a"], "the sequence keeps its order");
        assert_eq!(get_drive_sequence(&db, ":CS").unwrap().len(), 1, "a is still under :CS");
        assert!(!registered(&db, ":CS-DSA") && !registered(&db, ":CS-DSA-TREES"));
        let tree = get_drive_manage_tree(&db).unwrap();
        let algo = find(&tree, ":CS-ALGO").unwrap();
        assert_eq!((algo.alias.as_deref(), algo.icon.as_deref()), (Some("Data Structures"), Some("coding")));
        assert!(get_note(&db, "c").unwrap().contains("kinesis://drive/%CE%B8%CF%88CS_ALGO_TREES"));
    }

    #[test]
    fn a_sequence_link_follows_its_drive_and_its_summary_names_the_first_video() {
        let db = temp_db("seqlink");
        video(&db, "a", ":CS-DSA");
        video(&db, "b", ":CS-DSA");
        add_to_drive_sequence(&db, ":CS-DSA", &["b".to_string(), "a".to_string()]).unwrap();
        let s = get_sequence_summary(&db, ":CS-DSA").unwrap().unwrap();
        assert_eq!((s.count, s.first_video_id.as_deref(), s.first_title.as_deref()), (2, Some("b"), Some("Video b")));
        assert!(get_sequence_summary(&db, ":CS").unwrap().is_none(), "no sequence of its own");

        set_note(&db, "a", &format!("Watch {}", build_link("DSA playlist", LinkKind::Playlist, ":CS-DSA"))).unwrap();
        let preview = relocate_drive(&db, ":CS-DSA", ":CS-ALGO", true).unwrap();
        assert_eq!(preview.texts, 1, "the sequence link is counted");
        relocate_drive(&db, ":CS-DSA", ":CS-ALGO", false).unwrap();
        assert!(get_note(&db, "a").unwrap().contains("kinesis://playlist/%3ACS-ALGO"), "{}", get_note(&db, "a").unwrap());
    }

    #[test]
    fn moving_out_of_a_drive_drops_it_from_that_drives_sequence() {
        let db = temp_db("move");
        video(&db, "a", ":CS-DSA");
        add_to_drive_sequence(&db, ":CS", &["a".to_string()]).unwrap();
        relocate_drive(&db, ":CS-DSA", ":MATH-DSA", false).unwrap();
        assert_eq!(get_video_wdbs_primary(&db, "a").unwrap().as_deref(), Some("θψMATH_DSA"));
        assert!(get_drive_sequence(&db, ":CS").unwrap().is_empty());
        assert!(registered(&db, ":MATH"), "the new parent is registered");
    }

    #[test]
    fn merging_combines_everything_and_keeps_the_targets_looks() {
        let db = temp_db("merge");
        video(&db, "a", ":OLD");
        video(&db, "b", ":NEW");
        video(&db, "c", ":NEW");
        add_video_wdbs_link(&db, "c", "θψOLD").unwrap(); // becomes its own home: dropped
        set_wdbs_alias(&db, "θψOLD", "Old name").unwrap();
        set_wdbs_alias(&db, "θψNEW", "New name").unwrap();
        add_to_drive_sequence(&db, ":NEW", &["b".to_string()]).unwrap();
        add_to_drive_sequence(&db, ":OLD", &["a".to_string()]).unwrap();

        let report = relocate_drive(&db, ":OLD", ":NEW", false).unwrap();
        assert!(report.merged);
        assert_eq!(get_video_wdbs_primary(&db, "a").unwrap().as_deref(), Some("θψNEW"));
        assert!(get_video_wdbs_links(&db, "c").unwrap().is_empty(), "a link to its own home goes");
        let seq: Vec<String> = get_drive_sequence(&db, ":NEW").unwrap().into_iter().map(|e| e.video_id).collect();
        assert_eq!(seq, vec!["b", "a"], "the merged sequence goes on the end");
        let tree = get_drive_manage_tree(&db).unwrap();
        assert_eq!(find(&tree, ":NEW").unwrap().alias.as_deref(), Some("New name"));
        assert!(find(&tree, ":OLD").is_none());
    }

    #[test]
    fn glossary_entries_follow_a_top_level_drive() {
        let db = temp_db("glossary");
        video(&db, "a", ":FIN");
        crate::db::ensure_wdbs_path_exists(&db, ":MONEY").unwrap();
        save_glossary_term(&db, None, "Halving", "Supply cut", ":FIN").unwrap();
        save_glossary_term(&db, None, "Yield", "Return", ":FIN").unwrap();
        save_glossary_term(&db, None, "Yield", "Return", ":MONEY").unwrap();

        relocate_drive(&db, ":FIN", ":FINANCE", false).unwrap();
        let entries = get_glossary_terms(&db).unwrap();
        let halving = entries.iter().find(|e| e.term == "Halving").unwrap();
        assert_eq!(halving.drives, vec![":FINANCE".to_string()]);

        // Moving it under :MONEY files its entries at :MONEY, joining same-text ones.
        let report = relocate_drive(&db, ":FINANCE", ":MONEY-FINANCE", false).unwrap();
        assert_eq!(report.terms_moved_to.as_deref(), Some(":MONEY"));
        let entries = get_glossary_terms(&db).unwrap();
        let yields: Vec<_> = entries.iter().filter(|e| e.term == "Yield").collect();
        assert_eq!(yields.len(), 1, "same definition, one entry");
        assert_eq!(yields[0].drives, vec![":MONEY".to_string()]);
    }

    #[test]
    fn a_glossary_clash_refuses_the_merge_and_changes_nothing() {
        let db = temp_db("clash");
        video(&db, "a", ":A");
        video(&db, "b", ":B");
        save_glossary_term(&db, None, "Mole", "Animal", ":A").unwrap();
        save_glossary_term(&db, None, "Mole", "Unit", ":B").unwrap();
        let err = relocate_drive(&db, ":A", ":B", false).unwrap_err().to_string();
        assert!(err.contains("Mole"), "{err}");
        assert_eq!(get_video_wdbs_primary(&db, "a").unwrap().as_deref(), Some("θψA"), "rolled back");
    }

    #[test]
    fn a_drive_cant_go_inside_itself() {
        let db = temp_db("inside");
        video(&db, "a", ":A-B");
        assert!(relocate_drive(&db, ":A", ":A-B-A", false).is_err());
        assert!(relocate_drive(&db, ":A", ":A", false).is_err());
        assert!(relocate_drive(&db, ":NOPE", ":X", false).is_err());
        // Merging a child up into its parent is fine.
        relocate_drive(&db, ":A-B", ":A", false).unwrap();
        assert_eq!(get_video_wdbs_primary(&db, "a").unwrap().as_deref(), Some("θψA"));
    }

    #[test]
    fn only_an_empty_drive_can_be_deleted() {
        let db = temp_db("delete");
        video(&db, "a", ":CS-DSA");
        create_drive(&db, Some(":CS-DSA"), "empty").unwrap();
        let err = delete_drive(&db, ":CS", false).unwrap_err().to_string();
        assert!(err.contains("1 video"), "{err}");
        let report = delete_drive(&db, ":CS-DSA-EMPTY", false).unwrap();
        assert_eq!(report.drives, 1);
        assert!(!registered(&db, ":CS-DSA-EMPTY"));
        assert!(registered(&db, ":CS-DSA"));
    }

    #[test]
    fn members_list_homes_and_links() {
        let db = temp_db("members");
        video(&db, "a", ":CS");
        video(&db, "b", ":CS-DSA");
        video(&db, "c", ":OTHER");
        add_video_wdbs_link(&db, "c", "θψCS").unwrap();
        let here = list_drive_members(&db, ":CS", false).unwrap();
        assert_eq!(here.len(), 2);
        let linked = here.iter().find(|m| m.via_link).unwrap();
        assert_eq!((linked.video_id.as_str(), linked.home.as_deref()), ("c", Some(":OTHER")));
        assert_eq!(list_drive_members(&db, ":CS", true).unwrap().len(), 3);
    }
}
