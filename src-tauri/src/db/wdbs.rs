use crate::Video;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
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
/// never overwrites curated WDInfo/WDAlias text.
pub fn ensure_wdbs_path_exists(db_path: &str, display_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    if !table_exists(&conn, "tblWDBS")? {
        return Ok(());
    }

    let body = display_path.strip_prefix(':').unwrap_or(display_path);
    let segments: Vec<&str> = body.split('-').filter(|s| !s.is_empty()).collect();

    if segments.is_empty() {
        // The bare root ("Universe"/unassigned) designator itself.
        conn.execute(
            "INSERT OR IGNORE INTO tblWDBS (Keep, WDBS, Lev, WDID, WDInfo, WDAlias, WDDefault)
             VALUES ('', ':', 0, '', '', '', 0)",
            [],
        )?;
        return Ok(());
    }

    for i in 1..=segments.len() {
        let path = format!(":{}", segments[..i].join("-"));
        let wdid = segments[i - 1];
        conn.execute(
            "INSERT OR IGNORE INTO tblWDBS (Keep, WDBS, Lev, WDID, WDInfo, WDAlias, WDDefault)
             VALUES ('', ?1, ?2, ?3, ?3, '', 0)",
            params![path, i as i64, wdid],
        )?;
    }
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
}

struct TrieNode {
    video_ids: HashSet<String>,
    children: BTreeMap<String, TrieNode>,
}

impl TrieNode {
    fn new() -> Self {
        TrieNode { video_ids: HashSet::new(), children: BTreeMap::new() }
    }
}

fn build_nodes(trie: &TrieNode, prefix: &str) -> Vec<WdbsNode> {
    trie.children
        .iter()
        .map(|(segment, child)| {
            let path = if prefix.is_empty() {
                format!("θψ{}", segment)
            } else {
                format!("{}_{}", prefix, segment)
            };
            WdbsNode {
                segment: segment.clone(),
                count: child.video_ids.len() as i64,
                children: build_nodes(child, &path),
                path,
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

    Ok(build_nodes(&root, ""))
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
