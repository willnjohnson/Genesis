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

pub(crate) fn ensure_wdbs_path_exists_with_conn(conn: &Connection, display_path: &str) -> Result<()> {
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
/// videos.WDBS/VideoWDBSLinks assignment never got registered for. Before Kinesis started
/// creating and owning tblWDBS itself (see schema.rs's tblWDBS block), ensure_wdbs_path_exists
/// was a no-op on a from-scratch database — the table didn't exist yet — so a designator could
/// get set on a video without ever gaining a matching tblWDBS row. get_wdbs_tree still shows such
/// a node fine (it's built straight from videos.WDBS/VideoWDBSLinks, independent of tblWDBS),
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
            "SELECT WDBS FROM Videos WHERE WDBS IS NOT NULL AND WDBS != ''
             UNION
             SELECT wdbs FROM VideoWDBSLinks",
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
pub(crate) fn storage_to_display_path(storage_path: &str) -> String {
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
/// VideoWDBSLinks — is still only counted once), so it always matches what selecting the node
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
    "health", "privacy", "repair", "coding", "art", "reading", "project", "ai",
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
pub(crate) fn is_unassigned_sentinel(wdbs: &str) -> bool {
    wdbs == ":" || wdbs == "θψ"
}

/// Builds the full Warp Drive taxonomy tree from every (video, WDBS) assignment actually in use
/// — both each video's canonical `videos.WDBS` and any symlinks in `VideoWDBSLinks`. The
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
        "SELECT video_id, WDBS FROM Videos WHERE WDBS IS NOT NULL AND WDBS != ''
         UNION
         SELECT video_id, wdbs FROM VideoWDBSLinks",
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
/// symlink (VideoWDBSLinks), is exactly `wdbs_prefix` or nested beneath it, optionally narrowed
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
        SELECT video_id FROM Videos WHERE WDBS = ?1 OR WDBS GLOB ?1 || '_*'
        UNION
        SELECT video_id FROM VideoWDBSLinks WHERE wdbs = ?1 OR wdbs GLOB ?1 || '_*'
    ";

    let mut videos = Vec::new();
    let total: i64;

    if fts_query.is_empty() {
        // No search text (or nothing left after stripping a bare ':') — just the category
        // membership + filter_kind.
        let where_sql = format!("v.video_id IN ({matching_ids_sql}) AND {filter_where}");
        total = conn.query_row(
            &format!("SELECT COUNT(*) FROM Videos AS v WHERE {where_sql}"),
            params![wdbs_prefix],
            |row| row.get(0),
        )?;

        let sql = format!(
            "SELECT {columns} FROM Videos AS v WHERE {where_sql} ORDER BY {order} LIMIT ?2 OFFSET ?3"
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
            "SELECT COUNT(*) FROM Videos AS v JOIN ftsVideos ON v.rowid = ftsVideos.rowid WHERE {where_sql}"
        );
        total = conn.query_row(&count_sql, params![wdbs_prefix, fts_query], |row| row.get(0))?;

        let sql = format!(
            "SELECT {columns} FROM Videos AS v JOIN ftsVideos ON v.rowid = ftsVideos.rowid WHERE {where_sql} ORDER BY {order} LIMIT ?3 OFFSET ?4"
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
        "SELECT WDBS FROM Videos WHERE WDBS IS NOT NULL AND WDBS != ''
         UNION
         SELECT wdbs FROM VideoWDBSLinks
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
        "SELECT WDBS FROM Videos WHERE video_id = ?1",
        params![video_id],
        |row| row.get::<_, Option<String>>(0),
    )
}

/// A video's symlinked (non-canonical) Warp Drives, in storage encoding.
pub fn get_video_wdbs_links(db_path: &str, video_id: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT wdbs FROM VideoWDBSLinks WHERE video_id = ?1 ORDER BY wdbs")?;
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
        "INSERT OR IGNORE INTO VideoWDBSLinks (video_id, wdbs) VALUES (?1, ?2)",
        params![video_id, encoded_wdbs],
    )?;
    Ok(())
}

pub fn remove_video_wdbs_link(db_path: &str, video_id: &str, encoded_wdbs: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "DELETE FROM VideoWDBSLinks WHERE video_id = ?1 AND wdbs = ?2",
        params![video_id, encoded_wdbs],
    )?;
    // A sequence only holds videos filed at or beneath its Drive.
    super::sequences::prune_video_memberships(db_path, video_id);
    Ok(())
}

/// Removes every symlink for a video — used when its canonical WDBS is cleared back to
/// unassigned (see commands::wdbs::update_wdbs), since a symlink only makes sense as something
/// additional alongside a canonical Warp Drive, not on its own.
pub fn clear_video_wdbs_links(db_path: &str, video_id: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM VideoWDBSLinks WHERE video_id = ?1", params![video_id])?;
    super::sequences::prune_video_memberships(db_path, video_id);
    Ok(())
}

/// One top-level Drive (level 1), as the Glossary's drive dropdown and assignment picker list them.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WdbsRoot {
    /// Display path, e.g. ":CRYPTO" — what Glossary.drives stores (one root per line).
    pub path: String,
    /// The bare name shown in the UI ("CRYPTO").
    pub segment: String,
    /// The curated alias, when it differs from `segment`.
    pub alias: Option<String>,
}

/// Every Drive root: the top level of the tree built from assigned videos, plus level-1 rows in
/// tblWDBS (a root can exist there with no videos yet), plus any root a glossary term is already
/// filed under (so an assignment can never be invisible in the dropdown). Sorted by name.
pub fn get_wdbs_roots(db_path: &str) -> Result<Vec<WdbsRoot>> {
    let mut roots: BTreeMap<String, WdbsRoot> = BTreeMap::new();
    for node in get_wdbs_tree(db_path)? {
        let path = storage_to_display_path(&node.path);
        if super::glossary::is_root_path(&path) {
            roots.insert(path.clone(), WdbsRoot { path, segment: node.segment, alias: node.alias });
        }
    }

    let conn = Connection::open(db_path)?;
    if table_exists(&conn, "tblWDBS")? {
        let mut stmt = conn.prepare("SELECT WDBS, WDInfo FROM tblWDBS WHERE lev = 1")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        for (path, info) in rows.filter_map(|r| r.ok()) {
            if !super::glossary::is_root_path(&path) {
                continue;
            }
            let segment = path.trim_start_matches(':').to_string();
            let alias = Some(info.trim().to_string()).filter(|a| !a.is_empty() && *a != segment);
            roots.entry(path.clone()).or_insert(WdbsRoot { path, segment, alias });
        }
    }
    // Glossary is Kinesis-owned and always exists (see db/schema.rs), unlike tblWDBS above.
    {
        let mut stmt = conn.prepare("SELECT drives FROM Glossary WHERE drives != ''")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for raw in rows.filter_map(|r| r.ok()) {
            for path in raw.split('\n').filter(|r| !r.is_empty()) {
                let path = path.to_string();
                let segment = path.trim_start_matches(':').to_string();
                roots.entry(path.clone()).or_insert(WdbsRoot { path, segment, alias: None });
            }
        }
    }

    let mut out: Vec<WdbsRoot> = roots.into_values().collect();
    out.sort_by_key(|r| r.segment.to_lowercase());
    Ok(out)
}

/// Every (video_id, wdbs) symlink pair across the whole library, storage-encoded — used by
/// commands::export::export_to_obsidian to write a stub "See: [[...]]" note in each secondary
/// category a video is linked into, alongside its canonical one.
pub fn get_all_video_wdbs_links(db_path: &str) -> Result<Vec<(String, String)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT video_id, wdbs FROM VideoWDBSLinks")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// One Drive (a full path, at any depth) that a channel's videos are filed under.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct HandleDrive {
    /// Storage form, as videos.WDBS keeps it ("θψCRYPTO_DOAC").
    pub path: String,
    /// Display form, as the app shows it (":CRYPTO-DOAC").
    pub display: String,
    /// The Drive's curated alias (tblWDBS.WDInfo), when it has one that differs from its last segment.
    pub alias: Option<String>,
    /// How many of the channel's library videos are in it (as their category or an "Also in" link).
    pub count: i64,
}

/// The curated alias (tblWDBS.WDInfo) of each given Drive path (storage form), keyed by that path.
/// A Drive is left out when it has no alias, or its alias is just its own last segment (which is
/// what a freshly registered row holds). Empty when tblWDBS isn't present.
pub fn get_wdbs_aliases(db_path: &str, storage_paths: &[String]) -> Result<HashMap<String, String>> {
    let conn = Connection::open(db_path)?;
    wdbs_aliases_with_conn(&conn, storage_paths)
}

fn wdbs_aliases_with_conn(conn: &Connection, storage_paths: &[String]) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    if storage_paths.is_empty() || !table_exists(conn, "tblWDBS")? {
        return Ok(out);
    }
    let mut lookup = conn.prepare("SELECT WDInfo FROM tblWDBS WHERE WDBS = ?1")?;
    for path in storage_paths {
        let display = storage_to_display_path(path);
        let info: Option<String> = lookup.query_row(params![display], |row| row.get(0)).ok().flatten();
        let segment = display.rsplit('-').next().unwrap_or("").trim_start_matches(':');
        if let Some(alias) = info.map(|a| a.trim().to_string()).filter(|a| !a.is_empty() && a != segment) {
            out.insert(path.clone(), alias);
        }
    }
    Ok(out)
}

/// Every Drive a channel's saved videos appear in: each video's own category plus every category it
/// is linked into, with the number of that channel's videos in each. The handle matches
/// case-insensitively and with or without the leading "@". Unassigned videos don't count.
pub fn get_handle_drives(db_path: &str, handle: &str) -> Result<Vec<HandleDrive>> {
    let wanted = handle.trim().trim_start_matches('@').to_lowercase();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT wdbs, COUNT(DISTINCT video_id) FROM (
             SELECT v.WDBS AS wdbs, v.video_id AS video_id FROM Videos v
              WHERE LOWER(LTRIM(v.handle, '@')) = ?1 AND v.WDBS IS NOT NULL AND v.WDBS != ''
             UNION
             SELECT l.wdbs, l.video_id FROM VideoWDBSLinks l
               JOIN Videos v ON v.video_id = l.video_id
              WHERE LOWER(LTRIM(v.handle, '@')) = ?1
         )
         WHERE wdbs != '' GROUP BY wdbs",
    )?;
    let rows = stmt.query_map(params![wanted], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    let mut out: Vec<HandleDrive> = rows
        .filter_map(|r| r.ok())
        .filter(|(wdbs, _)| !is_unassigned_sentinel(wdbs))
        .map(|(wdbs, count)| HandleDrive { display: storage_to_display_path(&wdbs), path: wdbs, alias: None, count })
        .collect();
    let paths: Vec<String> = out.iter().map(|d| d.path.clone()).collect();
    let aliases = wdbs_aliases_with_conn(&conn, &paths)?;
    for drive in &mut out {
        drive.alias = aliases.get(&drive.path).cloned();
    }
    out.sort_by_key(|d| d.display.to_lowercase());
    Ok(out)
}

#[cfg(test)]
mod handle_drive_tests {
    use super::*;
    use crate::db::{add_video_wdbs_link, init_db, save_video, update_video_wdbs};

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_handledrives_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn video(db: &str, id: &str, handle: &str) {
        save_video(db, id, id, "Author", 60, "words", 1, "2026-01-01T00:00:00Z", handle, None).unwrap();
    }

    #[test]
    fn lists_every_drive_a_channels_videos_are_in_with_counts() {
        let db = temp_db("list");
        video(&db, "a1", "@Creator");
        video(&db, "a2", "@creator");
        video(&db, "a3", "@creator");
        video(&db, "b1", "@someone_else");
        video(&db, "a4", "@creator"); // never assigned anywhere
        update_video_wdbs(&db, "a1", "θψCRYPTO_DOAC").unwrap();
        update_video_wdbs(&db, "a2", "θψCRYPTO_DOAC").unwrap();
        update_video_wdbs(&db, "a3", "θψFIN").unwrap();
        add_video_wdbs_link(&db, "a1", "θψNEWS").unwrap(); // an "Also in" link counts too
        add_video_wdbs_link(&db, "a3", "θψFIN").unwrap(); // same drive as its category: still one video
        update_video_wdbs(&db, "b1", "θψOTHERCHANNEL").unwrap(); // someone else's video
        update_video_wdbs(&db, "a4", ":").unwrap(); // the unassigned placeholder

        let got = get_handle_drives(&db, "creator").unwrap();
        let summary: Vec<(String, i64)> = got.iter().map(|d| (d.display.clone(), d.count)).collect();
        assert_eq!(summary, vec![(":CRYPTO-DOAC".to_string(), 2), (":FIN".to_string(), 1), (":NEWS".to_string(), 1)]);
        assert_eq!(got[0].path, "θψCRYPTO_DOAC");
        assert!(!summary.iter().any(|(d, _)| d.contains("OTHERCHANNEL")), "other channels' drives stay out");

        // Uncurated drives (alias = their own name) report none; a curated alias comes through.
        assert!(got.iter().all(|d| d.alias.is_none()));
        // The app registers a Drive's tblWDBS rows when it's first assigned (see the wdbs commands).
        ensure_wdbs_path_exists(&db, ":CRYPTO-DOAC").unwrap();
        set_wdbs_alias(&db, "θψCRYPTO_DOAC", "Doac Crypto Talks").unwrap();
        let got = get_handle_drives(&db, "creator").unwrap();
        assert_eq!(got[0].alias.as_deref(), Some("Doac Crypto Talks"));
        assert!(got[1].alias.is_none());

        // The same lookup backs the tooltips on a video's own Drive and "Also in" tags.
        let paths = vec!["θψCRYPTO_DOAC".to_string(), "θψFIN".to_string(), "θψNOSUCH".to_string()];
        let aliases = get_wdbs_aliases(&db, &paths).unwrap();
        assert_eq!(aliases.len(), 1);
        assert_eq!(aliases["θψCRYPTO_DOAC"], "Doac Crypto Talks");
        assert!(get_wdbs_aliases(&db, &[]).unwrap().is_empty());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn the_handle_matches_with_or_without_the_at_sign_and_in_any_case() {
        let db = temp_db("handle");
        video(&db, "a1", "@Some_Creator");
        update_video_wdbs(&db, "a1", "θψUAP").unwrap();
        for h in ["@Some_Creator", "some_creator", " @SOME_CREATOR ", "@some_creator"] {
            assert_eq!(get_handle_drives(&db, h).unwrap().len(), 1, "{h:?}");
        }
        assert!(get_handle_drives(&db, "").unwrap().is_empty());
        assert!(get_handle_drives(&db, "@").unwrap().is_empty());
        assert!(get_handle_drives(&db, "nobody").unwrap().is_empty());
        let _ = std::fs::remove_file(&db);
    }
}
