use crate::Video;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use super::search::{video_columns_sql, video_row, library_order_by, filter_kind_where, build_fts_query};
use super::schema::table_exists;

/// Ensures `display_path` (":UAP-GERB-VVV", display format — colon + hyphens) and every
/// intermediate level above it exist as rows in tblWDBS, creating whichever are missing. A no-op
/// when tblWDBS isn't present at all — our own from-scratch schema has no referential-integrity
/// trigger to satisfy in the first place (see schema.rs's tblWDBS-gated trigger block).
///
/// The schema handoff doc originally scoped tblWDBS population to a separate tool, keeping
/// Kinesis out of it entirely. Letting users create new Warp Drive categories from within Kinesis
/// means this app now needs to write here too — otherwise the production database's
/// trgVideosBeforeUPD_Videos_ValidateWDBS trigger rejects any designator that doesn't already
/// exist as "referential integrity violation", including one nobody has ever gotten the chance
/// to create yet. Existing rows are left untouched (INSERT OR IGNORE): this only fills gaps, it
/// never overwrites curated WDInfo text (the per-node display alias — see set_wdbs_alias).
pub fn ensure_wdbs_path_exists(db_path: &str, display_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    ensure_wdbs_path_exists_with_conn(&conn, display_path)
}

fn ensure_wdbs_path_exists_with_conn(conn: &Connection, display_path: &str) -> Result<()> {
    if !table_exists(conn, "tblWDBS")? {
        return Ok(());
    }

    let body = display_path.strip_prefix(':').unwrap_or(display_path);
    let segments: Vec<&str> = body.split('-').filter(|s| !s.is_empty()).collect();

    if segments.is_empty() {
        // The bare root ("Universe"/unassigned) designator itself.
        conn.execute(
            "INSERT OR IGNORE INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDDefault)
             VALUES (':', 0, '', '', 0)",
            [],
        )?;
        return Ok(());
    }

    for i in 1..=segments.len() {
        let path = format!(":{}", segments[..i].join("-"));
        let wdid = segments[i - 1];
        conn.execute(
            "INSERT OR IGNORE INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDDefault)
             VALUES (?1, ?2, ?3, ?3, 0)",
            params![path, i as i64, wdid],
        )?;
    }
    Ok(())
}

/// One-time backfill (see schema.rs's migratedWdbsTaxonomyBackfill) for tblWDBS rows that a
/// videos.WDBS/video_wdbs_links assignment never got registered for. Before Kinesis started
/// creating and owning tblWDBS itself (see schema.rs's tblWDBS block), ensure_wdbs_path_exists
/// was a no-op on a from-scratch database — the table didn't exist yet — so a designator could
/// get set on a video without ever gaining a matching tblWDBS row. get_wdbs_tree still shows such
/// a node fine (it's built straight from videos.WDBS/video_wdbs_links, independent of tblWDBS),
/// which is what makes this easy to miss: set_wdbs_alias/set_wdbs_icon are UPDATE-only against
/// tblWDBS (see their own docs), so curating an alias/icon on one of these unregistered nodes
/// silently no-ops — the UPDATE matches zero rows, no error, nothing ever persists.
pub(crate) fn backfill_missing_wdbs_paths(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "tblWDBS")? {
        return Ok(());
    }

    let mut storage_paths: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT WDBS FROM videos WHERE WDBS IS NOT NULL AND WDBS != ''
             UNION
             SELECT wdbs FROM video_wdbs_links",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows.filter_map(|r| r.ok()) {
            storage_paths.insert(row);
        }
    }

    for storage_path in &storage_paths {
        if is_unassigned_sentinel(storage_path) {
            continue;
        }
        let display_path = storage_to_display_path(storage_path);
        ensure_wdbs_path_exists_with_conn(conn, &display_path)?;
    }
    Ok(())
}

/// Inverse of the "θψ"/"_" storage encoding build_nodes below (and commands::wdbs::
/// encode_wdbs_display) apply — turns a WdbsNode.path (e.g. "θψCRYPTO_JOHN") back into the ":"/
/// "-" display form tblWDBS.WDBS stores (":CRYPTO-JOHN"), so a tree node's alias can be looked up
/// or updated by joining/matching against it.
fn storage_to_display_path(storage_path: &str) -> String {
    let body = storage_path.strip_prefix("θψ").unwrap_or(storage_path);
    format!(":{}", body.replace('_', "-"))
}

/// Sets (or clears, given a blank `alias`) the curated display alias — tblWDBS.WDInfo — for one
/// Warp Drive taxonomy node, so components/WdbsTreePanel.tsx can show it as a tooltip/detail
/// alongside the node's raw segment name (e.g. "JOHN" aliased to "YOUTUBER"). `storage_path` is a
/// WdbsNode.path value. A no-op when tblWDBS isn't present (from-scratch/compatibility database —
/// see ensure_wdbs_path_exists) since there's nowhere to persist it; the row is expected to
/// already exist there (every level of every assigned WDBS value is registered via
/// ensure_wdbs_path_exists as soon as it's first used), so this only ever updates, never inserts.
pub fn set_wdbs_alias(db_path: &str, storage_path: &str, alias: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    if !table_exists(&conn, "tblWDBS")? {
        return Ok(());
    }
    let display_path = storage_to_display_path(storage_path);
    conn.execute(
        "UPDATE tblWDBS SET WDInfo = ?1 WHERE WDBS = ?2",
        params![alias.trim(), display_path],
    )?;
    Ok(())
}

/// Sets (or clears, given '') the curated icon — tblWDBS.WDIcon — for one Warp Drive taxonomy
/// node, shown to the left of its segment name in the tree (see components/WdbsTreePanel.tsx's
/// "Edit Icon" context menu). `storage_path` is a WdbsNode.path value. Validating `icon` against
/// the fixed picker choices is commands::wdbs::set_wdbs_icon's job (it owns the user-facing error
/// message); this just persists whatever it's given, same trust boundary as set_wdbs_alias above.
/// A no-op when tblWDBS isn't present, for the same reason set_wdbs_alias is.
pub fn set_wdbs_icon(db_path: &str, storage_path: &str, icon: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    if !table_exists(&conn, "tblWDBS")? {
        return Ok(());
    }
    let display_path = storage_to_display_path(storage_path);
    conn.execute(
        "UPDATE tblWDBS SET WDIcon = ?1 WHERE WDBS = ?2",
        params![icon.trim(), display_path],
    )?;
    Ok(())
}

/// One node of the Warp Drive (WDBS) taxonomy tree — see components/DriveView.tsx. `path` is the
/// storage-encoded prefix (e.g. "θψUAP_GERB") that `list_videos_by_wdbs` matches against; `count`
/// is the number of *distinct* videos at this node and everywhere beneath it (a video reachable
/// via two different paths under the same node — e.g. its canonical WDBS plus a symlink, see
/// video_wdbs_links — is still only counted once), so it always matches what selecting the node
/// in the tree will show. There is deliberately no "Universe"/unassigned node here — that's what
/// the Library/Portal grid is already for.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WdbsNode {
    pub segment: String,
    pub path: String,
    pub count: i64,
    pub children: Vec<WdbsNode>,
    // The node's curated display alias (tblWDBS.WDInfo — see set_wdbs_alias), when it differs
    // from `segment`. `None` both when nothing's been curated yet and when the running database
    // doesn't have the production tblWDBS schema at all.
    pub alias: Option<String>,
    // The node's curated icon (tblWDBS.WDIcon — see set_wdbs_icon), one of WDBS_ICONS. `None`
    // when unset, when the running database doesn't have tblWDBS, or when the stored value
    // doesn't match any current icon (e.g. hand-edited, or a value from a since-removed choice).
    pub icon: Option<String>,
}

/// The fixed set of icons a Warp Drive taxonomy node's WDIcon can hold — see
/// components/WdbsIconMenu.tsx for the matching picker UI and lucide icon per key.
/// commands::wdbs::set_wdbs_icon rejects anything outside this list; get_wdbs_tree (below) treats
/// a stored value outside it the same as unset, rather than surfacing a value the tree can't
/// actually render an icon for.
pub const WDBS_ICONS: &[&str] = &[
    "star", "company", "person", "music", "sports", "gaming", "podcast", "fitness", "food",
    "news", "education", "comedy", "tech", "finance", "guides",
];

struct TrieNode {
    video_ids: HashSet<String>,
    children: BTreeMap<String, TrieNode>,
}

impl TrieNode {
    fn new() -> Self {
        TrieNode { video_ids: HashSet::new(), children: BTreeMap::new() }
    }
}

fn build_nodes(
    trie: &TrieNode,
    prefix: &str,
    aliases: &HashMap<String, String>,
    icons: &HashMap<String, String>,
) -> Vec<WdbsNode> {
    trie.children
        .iter()
        .map(|(segment, child)| {
            let path = if prefix.is_empty() {
                format!("θψ{}", segment)
            } else {
                format!("{}_{}", prefix, segment)
            };
            let display_path = storage_to_display_path(&path);
            // Suppressed when it's just the uncurated default (WDInfo seeded to the segment's own
            // name by ensure_wdbs_path_exists) or blank (explicitly cleared) — either way there's
            // nothing more informative to show than the segment name already visible in the tree.
            let alias = aliases
                .get(&display_path)
                .filter(|a| !a.is_empty() && *a != segment)
                .cloned();
            // Unlike alias, a stored value with no matching current icon is treated as unset
            // rather than passed through — the tree has nothing to render for it either way.
            let icon = icons
                .get(&display_path)
                .filter(|i| WDBS_ICONS.contains(&i.as_str()))
                .cloned();
            WdbsNode {
                segment: segment.clone(),
                count: child.video_ids.len() as i64,
                children: build_nodes(child, &path, aliases, icons),
                path,
                alias,
                icon,
            }
        })
        // BTreeMap already yields keys in sorted order, so children come out alphabetized.
        .collect()
}

// The "unassigned Warp Drive" placeholder — ":" going forward, plus "θψ" defensively for any
// row that predates the schema.rs/save_video normalization (see those for why "θψ" was replaced
// as the sentinel: it's alphabetic and also the universal prefix every real WDBS value starts
// with, so FTS5 indexes it as a term that matches every video regardless of assignment). Neither
// represents a real category, so both are excluded everywhere a category listing is built.
fn is_unassigned_sentinel(wdbs: &str) -> bool {
    wdbs == ":" || wdbs == "θψ"
}

/// Builds the full Warp Drive taxonomy tree from every (video, WDBS) assignment actually in use
/// — both each video's canonical `videos.WDBS` and any symlinks in `video_wdbs_links`. The
/// distinct-assignment list is taxonomy-sized, not video-count-sized, so it's cheap to pull in
/// one shot and build the whole tree in memory rather than doing per-level round trips.
pub fn get_wdbs_tree(db_path: &str) -> Result<Vec<WdbsNode>> {
    let conn = Connection::open(db_path)?;

    // Curated aliases/icons (tblWDBS.WDInfo/WDIcon), each keyed by display path — both absent
    // entirely on a database without tblWDBS, in which case every node's `alias`/`icon` just come
    // back `None` (see build_nodes).
    let mut aliases: HashMap<String, String> = HashMap::new();
    let mut icons: HashMap<String, String> = HashMap::new();
    if table_exists(&conn, "tblWDBS")? {
        let mut stmt = conn.prepare("SELECT WDBS, WDInfo, WDIcon FROM tblWDBS")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows.filter_map(|r| r.ok()) {
            let (path, info, icon) = row;
            aliases.insert(path.clone(), info);
            icons.insert(path, icon);
        }
    }

    let mut stmt = conn.prepare(
        "SELECT video_id, WDBS FROM videos WHERE WDBS IS NOT NULL AND WDBS != ''
         UNION
         SELECT video_id, wdbs FROM video_wdbs_links",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;

    let mut root = TrieNode::new();
    for row in rows {
        let (video_id, wdbs) = row?;
        if is_unassigned_sentinel(&wdbs) {
            continue;
        }
        // Storage encoding is "θψSEG1_SEG2_..." (see commands::wdbs::encode_wdbs_display). A
        // value that doesn't start with the θψ marker is unexpected (hand-edited DB, etc.) —
        // fall back to treating it as a single opaque top-level segment rather than dropping it.
        let body = wdbs.strip_prefix("θψ").unwrap_or(&wdbs);
        let segments: Vec<&str> = body.split('_').filter(|s| !s.is_empty()).collect();
        if segments.is_empty() {
            continue;
        }
        let mut node = &mut root;
        for segment in &segments {
            node.video_ids.insert(video_id.clone());
            node = node.children.entry(segment.to_string()).or_insert_with(TrieNode::new);
        }
        // The loop above credits every node from the root down to (but not including) the final
        // segment; this credits the leaf itself.
        node.video_ids.insert(video_id);
    }

    Ok(build_nodes(&root, "", &aliases, &icons))
}

/// Pages videos belonging to one Warp Drive category: everything whose canonical WDBS, or any
/// symlink (video_wdbs_links), is exactly `wdbs_prefix` or nested beneath it, optionally narrowed
/// further by a free-text `query` (searched via the same FTS5 index — and the same tokenizer,
/// see build_fts_query — as the Library/Portal grid's own search, just scoped to this category
/// instead of the whole library — see App.tsx's Drive panel toggle) and by `filter_kind`
/// ("transcript"/"summary"/None-or-"all" — same semantics as the Library/Portal grid's filter
/// buttons, see db/search.rs's filter_kind_where). A video reachable both ways (or via two
/// qualifying symlinks) is deduped to a single row via UNION. Mirrors db::videos::list_videos's
/// shape (page + total count) so the frontend can reuse the same VideoList pagination UI as the
/// Library/Portal grid.
pub fn list_videos_by_wdbs(
    db_path: &str,
    wdbs_prefix: &str,
    query: &str,
    filter_kind: Option<&str>,
    sort_field: Option<&str>,
    sort_order: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<(Vec<Video>, i64)> {
    let conn = Connection::open(db_path)?;
    let columns = video_columns_sql("v.");
    let order = library_order_by("v.", sort_field, sort_order);
    let filter_where = filter_kind_where("v.", filter_kind);
    let fts_query = build_fts_query(query.trim());

    // GLOB (not LIKE) is required here: LIKE's '_' wildcard matches any single character, which
    // would treat the literal underscore segment-separator as a wildcard too. GLOB's '_' is
    // literal and '*' is the wildcard. The ids subquery only has enough columns to resolve WDBS
    // membership, not transcript/summary state or FTS content, so filter_kind and the text
    // search below are both applied against the outer `videos` row instead, once IN (...) has
    // narrowed it down to this category's members.
    let matching_ids_sql = "
        SELECT video_id FROM videos WHERE WDBS = ?1 OR WDBS GLOB ?1 || '_*'
        UNION
        SELECT video_id FROM video_wdbs_links WHERE wdbs = ?1 OR wdbs GLOB ?1 || '_*'
    ";

    let mut videos = Vec::new();
    let total: i64;

    if fts_query.is_empty() {
        // No search text (or nothing left after stripping a bare ':') — just the category
        // membership + filter_kind.
        let where_sql = format!("v.video_id IN ({matching_ids_sql}) AND {filter_where}");
        total = conn.query_row(
            &format!("SELECT COUNT(*) FROM videos AS v WHERE {where_sql}"),
            params![wdbs_prefix],
            |row| row.get(0),
        )?;

        let sql = format!(
            "SELECT {columns} FROM videos AS v WHERE {where_sql} ORDER BY {order} LIMIT ?2 OFFSET ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let iter = stmt.query_map(params![wdbs_prefix, limit, offset], |row| video_row(row, false))?;
        for v in iter {
            videos.push(v?);
        }
    } else {
        let where_sql = format!(
            "v.video_id IN ({matching_ids_sql}) AND ftsVideos MATCH ?2 AND {filter_where}"
        );
        let count_sql = format!(
            "SELECT COUNT(*) FROM videos AS v JOIN ftsVideos ON v.rowid = ftsVideos.rowid WHERE {where_sql}"
        );
        total = conn.query_row(&count_sql, params![wdbs_prefix, fts_query], |row| row.get(0))?;

        let sql = format!(
            "SELECT {columns} FROM videos AS v JOIN ftsVideos ON v.rowid = ftsVideos.rowid WHERE {where_sql} ORDER BY {order} LIMIT ?3 OFFSET ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let iter = stmt.query_map(params![wdbs_prefix, fts_query, limit, offset], |row| video_row(row, false))?;
        for v in iter {
            videos.push(v?);
        }
    }

    Ok((videos, total))
}

/// Every distinct Warp Drive path currently assigned to at least one video (canonical or
/// symlinked), for autocomplete when assigning a video to an existing category — see
/// components/Sidebar.tsx's Warp Drive editor.
pub fn list_all_wdbs_paths(db_path: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT WDBS FROM videos WHERE WDBS IS NOT NULL AND WDBS != ''
         UNION
         SELECT wdbs FROM video_wdbs_links
         ORDER BY 1",
    )?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .filter(|wdbs| !is_unassigned_sentinel(wdbs))
        .collect();
    Ok(paths)
}

/// A video's current canonical Warp Drive, if any (i.e. `videos.WDBS`) — used before adding a
/// symlink, to reject one that would just duplicate the canonical assignment.
pub fn get_video_wdbs_primary(db_path: &str, video_id: &str) -> Result<Option<String>> {
    let conn = Connection::open(db_path)?;
    conn.query_row(
        "SELECT WDBS FROM videos WHERE video_id = ?1",
        params![video_id],
        |row| row.get::<_, Option<String>>(0),
    )
}

/// A video's symlinked (non-canonical) Warp Drives, in storage encoding.
pub fn get_video_wdbs_links(db_path: &str, video_id: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT wdbs FROM video_wdbs_links WHERE video_id = ?1 ORDER BY wdbs")?;
    let links = stmt
        .query_map(params![video_id], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(links)
}

/// Adds a symlink from `video_id` to `encoded_wdbs` (already storage-encoded — see
/// commands::wdbs::encode_wdbs_display). A no-op if the link already exists.
pub fn add_video_wdbs_link(db_path: &str, video_id: &str, encoded_wdbs: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT OR IGNORE INTO video_wdbs_links (video_id, wdbs) VALUES (?1, ?2)",
        params![video_id, encoded_wdbs],
    )?;
    Ok(())
}

pub fn remove_video_wdbs_link(db_path: &str, video_id: &str, encoded_wdbs: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "DELETE FROM video_wdbs_links WHERE video_id = ?1 AND wdbs = ?2",
        params![video_id, encoded_wdbs],
    )?;
    Ok(())
}

/// Removes every symlink for a video — used when its canonical WDBS is cleared back to
/// unassigned (see commands::wdbs::update_wdbs), since a symlink only makes sense as something
/// additional alongside a canonical Warp Drive, not on its own.
pub fn clear_video_wdbs_links(db_path: &str, video_id: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM video_wdbs_links WHERE video_id = ?1", params![video_id])?;
    Ok(())
}
