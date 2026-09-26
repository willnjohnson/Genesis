//! Leaving Drives out of an export (a kinpak or an Obsidian vault).
//!
//! A Drive is a top-level category (":UAP"). Excluding one has to leave the rest of the export
//! consistent, so this decides what happens to everything that touches it:
//!
//! - its categories, and the videos whose home is in it, are left out (with their notes and attachments);
//! - a video whose home (its "warp") is in a left-out Drive is judged by its symbolic links ("wefts"):
//!   one linked into a kept Drive can stay, with that link becoming its new home (`keep_linked_videos`);
//!   one with no such link goes, or stays uncategorized (`keep_unlinked_videos`);
//! - a link from a kept video into a left-out Drive is dropped, since there's nothing to point at;
//! - a glossary row holds one definition and all its Drives, so left-out Drives come off its list
//!   (they'd otherwise bring the Drive back on import) and a row left with none goes; a term left
//!   with no row at all is then left out (`terms` = drop) or survives as one uncategorized row
//!   (keep). Uncategorized rows are never affected;
//! - a creator whose videos were all left out goes too (a bio with no videos is what deleting the
//!   last video removes anyway), along with their custom prompt;
//! - links inside kept text that point at anything left out become plain text (`unlink_text`).
//!
//! Nothing outside a Drive (videos with no category, settings, history, ...) is ever affected.

use std::collections::{HashMap, HashSet};

use kinesis_sync_proto::{glossary_key, split_glossary_key, Kind};
use crate::db::glossary::{decode_drives, encode_drives};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use crate::db::links::{rewrite_links, LinkAction, LinkKind};
use crate::db::wdbs::{is_unassigned_sentinel, storage_to_display_path};

/// What to do with glossary terms filed under a left-out Drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TermsMode {
    /// Keep them: a term's rows in left-out Drives go, but a term whose every row was in a left-out
    /// Drive survives as one uncategorized row (its first Drive's definition).
    #[default]
    Keep,
    /// Leave out a term when every Drive it's filed under is left out.
    Drop,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DriveScope {
    /// Drives to leave out, as Drive paths (":UAP"). Empty means everything is exported.
    pub excluded: Vec<String>,
    pub terms: TermsMode,
    /// Keep a video homed in a left-out Drive when it's also linked into a kept one; that link becomes its home.
    pub keep_linked_videos: bool,
    /// Keep a video homed in a left-out Drive that has no link into a kept one, as uncategorized
    /// (without this it is left out, like the rest of the Drive).
    pub keep_unlinked_videos: bool,
    /// Turn links to left-out items into plain text.
    pub unlink_text: bool,
}

impl Default for DriveScope {
    fn default() -> Self {
        DriveScope { excluded: Vec::new(), terms: TermsMode::Keep, keep_linked_videos: true, keep_unlinked_videos: false, unlink_text: true }
    }
}

/// The Drives a glossary item is filed under: its payload's list, or (an older sender) just the
/// key's own Drive.
fn glossary_drives(key: &str, data: &Value) -> Vec<String> {
    match data.get("drives").and_then(Value::as_array) {
        Some(list) => list.iter().filter_map(|d| d.as_str().map(str::to_string)).collect(),
        None => split_glossary_key(key).map(|(d, _)| d).filter(|d| !d.is_empty()).map(|d| vec![d.to_string()]).unwrap_or_default(),
    }
}

/// A handle as compared everywhere else: no `@`, lowercase.
pub fn normalize_handle(handle: &str) -> String {
    handle.trim().trim_start_matches('@').to_lowercase()
}

/// The Drive a display path (":UAP-GERB") sits in (":UAP"); `None` for the unassigned marker.
pub fn root_of_display(path: &str) -> Option<String> {
    let body = path.strip_prefix(':').unwrap_or(path);
    let segment = body.split('-').next()?;
    (!segment.is_empty()).then(|| format!(":{segment}"))
}

/// The same for a storage-encoded value ("θψUAP_GERB").
pub fn root_of_storage(wdbs: &str) -> Option<String> {
    if wdbs.is_empty() || is_unassigned_sentinel(wdbs) {
        return None;
    }
    root_of_display(&storage_to_display_path(wdbs))
}

/// Everything decided up front from the database, so items can be judged one at a time while streaming.
pub struct ScopePlan {
    excluded: HashSet<String>,
    dropped_videos: HashSet<String>,
    /// Videos kept although their home Drive is left out: id -> the storage WDBS that becomes their home.
    promoted: HashMap<String, String>,
    dropped_handles: HashSet<String>,
    /// Terms with no surviving row (Drop mode), whose links become plain text.
    dropped_terms: HashSet<String>,
    /// Keep mode: term -> the left-out Drive whose row survives, as uncategorized.
    rehomed_terms: HashMap<String, String>,
    unlink_text: bool,
}

impl ScopePlan {
    /// `None` when nothing is left out (the caller then exports everything untouched).
    pub fn build(conn: &Connection, scope: &DriveScope) -> Result<Option<ScopePlan>, String> {
        let excluded: HashSet<String> = scope.excluded.iter().map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).collect();
        if excluded.is_empty() {
            return Ok(None);
        }
        let e = |err: rusqlite::Error| err.to_string();
        let out_of_scope = |wdbs: &str| root_of_storage(wdbs).is_some_and(|r| excluded.contains(&r));
        let in_scope_drive = |wdbs: &str| root_of_storage(wdbs).is_some_and(|r| !excluded.contains(&r));

        // Every video's links, in a fixed order so the same one is always picked as the new home.
        let mut links: HashMap<String, Vec<String>> = HashMap::new();
        if crate::db::schema::table_exists(conn, "VideoWDBSLinks").map_err(e)? {
            let mut stmt = conn.prepare("SELECT video_id, wdbs FROM VideoWDBSLinks ORDER BY wdbs").map_err(e)?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
            for (video_id, wdbs) in rows.filter_map(|r| r.ok()) {
                links.entry(video_id).or_default().push(wdbs);
            }
        }

        let mut dropped_videos = HashSet::new();
        let mut promoted = HashMap::new();
        // handle -> (videos, videos kept)
        let mut handles: HashMap<String, (u32, u32)> = HashMap::new();
        let mut stmt = conn
            .prepare("SELECT video_id, IFNULL(WDBS, ''), IFNULL(handle, '') FROM Videos")
            .map_err(e)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .map_err(e)?;
        for (video_id, wdbs, handle) in rows.filter_map(|r| r.ok()) {
            let mut kept = true;
            if out_of_scope(&wdbs) {
                // The first kept link (in a fixed order) becomes the new home; the video's other links stay
                // links. With none, it is uncategorized (":") or left out, as chosen.
                let new_home = scope
                    .keep_linked_videos
                    .then(|| links.get(&video_id).and_then(|l| l.iter().find(|w| in_scope_drive(w))).cloned())
                    .flatten()
                    .or_else(|| scope.keep_unlinked_videos.then(|| ":".to_string()));
                match new_home {
                    Some(home) => {
                        promoted.insert(video_id.clone(), home);
                    }
                    None => {
                        dropped_videos.insert(video_id.clone());
                        kept = false;
                    }
                }
            }
            let counts = handles.entry(normalize_handle(&handle)).or_default();
            counts.0 += 1;
            counts.1 += u32::from(kept);
        }
        drop(stmt);
        // A creator disappears only when they had videos and none of them are left.
        let dropped_handles: HashSet<String> =
            handles.into_iter().filter(|(h, (total, kept))| !h.is_empty() && *total > 0 && *kept == 0).map(|(h, _)| h).collect();

        // Glossary is Kinesis-owned and always exists, so no table_exists guard is needed here
        // (unlike the tblWDBS/handles work above). A row holds one definition and all its Drives:
        // left-out Drives come off its list, and a row with none left goes — so what's decided here
        // is what happens to a term with no row surviving at all: dropped (Drop), or kept as its
        // first such row, uncategorized (Keep).
        let mut dropped_terms = HashSet::new();
        let mut rehomed_terms = HashMap::new();
        {
            let mut rows_by_term: HashMap<String, (bool, Vec<String>)> = HashMap::new(); // term -> (has a surviving row, all-left-out rows' keys)
            let mut stmt = conn.prepare("SELECT term, drives FROM Glossary ORDER BY term, drives").map_err(e)?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
            for (term, key) in rows.filter_map(|r| r.ok()) {
                let drives = decode_drives(&key);
                let entry = rows_by_term.entry(term).or_default();
                if drives.is_empty() || drives.iter().any(|d| !excluded.contains(d.trim())) {
                    entry.0 = true;
                } else {
                    entry.1.push(key);
                }
            }
            for (term, (survives, left_out)) in rows_by_term {
                if survives || left_out.is_empty() {
                    continue;
                }
                if scope.terms == TermsMode::Drop {
                    // Kept lowercase: links to a term ignore its capitalization (see LinkKind::Glossary in db/links.rs).
                    dropped_terms.insert(term.to_ascii_lowercase());
                } else {
                    rehomed_terms.insert(term, left_out[0].clone());
                }
            }
        }

        Ok(Some(ScopePlan { excluded, dropped_videos, promoted, dropped_handles, dropped_terms, rehomed_terms, unlink_text: scope.unlink_text }))
    }

    pub fn root_kept(&self, root: &str) -> bool {
        !self.excluded.contains(root.trim())
    }

    /// A category by display path (":UAP-GERB").
    pub fn category_kept(&self, display_path: &str) -> bool {
        root_of_display(display_path).map_or(true, |r| self.root_kept(&r))
    }

    pub fn video_kept(&self, video_id: &str) -> bool {
        !self.dropped_videos.contains(video_id)
    }

    /// The storage WDBS that replaces a kept video's left-out home, if it has one.
    pub fn new_home(&self, video_id: &str) -> Option<&str> {
        self.promoted.get(video_id).map(String::as_str)
    }

    /// A link (video, storage WDBS) survives when its video does, it doesn't point into a left-out
    /// Drive, and it isn't the place the video just moved its home to (that would list it twice).
    pub fn link_kept(&self, video_id: &str, wdbs: &str) -> bool {
        self.video_kept(video_id)
            && self.new_home(video_id) != Some(wdbs)
            && root_of_storage(wdbs).map_or(true, |r| self.root_kept(&r))
    }

    pub fn handle_kept(&self, handle: &str) -> bool {
        !self.dropped_handles.contains(&normalize_handle(handle))
    }

    /// The Drives a glossary row ends up filed under — `None` when the row is left out. Left-out
    /// Drives come off its list; a row left with none is left out, except the single row that keeps
    /// a Keep-mode term alive, which becomes uncategorized (an empty list).
    pub fn glossary_row(&self, term: &str, drives: &[String]) -> Option<Vec<String>> {
        if drives.is_empty() {
            return Some(Vec::new());
        }
        let kept: Vec<String> = drives.iter().filter(|d| self.root_kept(d)).cloned().collect();
        if !kept.is_empty() {
            return Some(kept);
        }
        (self.rehomed_terms.get(term).map(String::as_str) == Some(encode_drives(drives).as_str())).then(Vec::new)
    }

    /// The item key a kept item is written under, given its (already adjusted) payload — the same as
    /// `key` except for a glossary row whose first Drive changed or that was re-homed.
    pub fn item_key(&self, kind: Kind, key: &str, data: &Value) -> String {
        if kind == Kind::Glossary {
            if let Some((_, term)) = split_glossary_key(key) {
                let first = glossary_drives(key, data).into_iter().next().unwrap_or_default();
                return glossary_key(&first, term);
            }
        }
        key.to_string()
    }

    /// Whether a sync item is part of the export. Judged on the item as read, before `adjust`.
    pub fn keep_item(&self, kind: Kind, key: &str, data: &Value) -> bool {
        match kind {
            Kind::Wdbs => self.category_kept(key),
            Kind::Video => self.video_kept(key),
            Kind::VideoLink => {
                let field = |name: &str| data.get(name).and_then(Value::as_str).unwrap_or("");
                self.link_kept(field("video_id"), field("wdbs"))
            }
            Kind::DriveSequence => {
                let field = |name: &str| data.get(name).and_then(Value::as_str).unwrap_or("");
                self.video_kept(field("video_id")) && self.category_kept(field("drive"))
            }
            Kind::Glossary => split_glossary_key(key).is_some_and(|(_, term)| self.glossary_row(term, &glossary_drives(key, data)).is_some()),
            Kind::Biography | Kind::CustomPrompt => self.handle_kept(key),
        }
    }

    /// Text with links to anything left out turned into plain text; `None` when nothing changed.
    pub fn clean_text(&self, text: &str) -> Option<String> {
        if !self.unlink_text {
            return None;
        }
        rewrite_links(text, |link| {
            let gone = match link.kind {
                LinkKind::Video => self.dropped_videos.contains(&link.key),
                LinkKind::Glossary => self.dropped_terms.contains(&link.key.to_ascii_lowercase()),
                LinkKind::Bio => self.dropped_handles.contains(&normalize_handle(&link.key)),
                // A Drive link carries either a display path or a storage one.
                LinkKind::Drive => root_of_display(&link.key)
                    .filter(|_| link.key.starts_with(':'))
                    .or_else(|| root_of_storage(&link.key))
                    .is_some_and(|r| !self.root_kept(&r)),
            };
            if gone {
                LinkAction::Unlink
            } else {
                LinkAction::Keep
            }
        })
    }

    fn clean_field(&self, data: &mut Value, field: &str) {
        let cleaned = data.get(field).and_then(Value::as_str).and_then(|t| self.clean_text(t));
        if let (Some(text), Some(obj)) = (cleaned, data.as_object_mut()) {
            obj.insert(field.to_string(), Value::String(text));
        }
    }

    /// Rewrites a kept item: a promoted video's home, a term's Drives, links in its text.
    pub fn adjust(&self, kind: Kind, key: &str, data: &mut Value) {
        match kind {
            Kind::Video => {
                if let (Some(home), Some(obj)) = (self.new_home(key), data.as_object_mut()) {
                    obj.insert("wdbs".into(), Value::String(home.to_string()));
                }
                self.clean_field(data, "summary");
                self.clean_field(data, "transcript");
            }
            Kind::Glossary => {
                if let Some((_, term)) = split_glossary_key(key) {
                    if let Some(new_drives) = self.glossary_row(term, &glossary_drives(key, data)) {
                        if let Some(obj) = data.as_object_mut() {
                            obj.insert("drives".into(), Value::Array(new_drives.into_iter().map(Value::String).collect()));
                        }
                    }
                }
                self.clean_field(data, "definition");
            }
            Kind::Biography => self.clean_field(data, "bio"),
            _ => {}
        }
    }

    /// Text of a kept video's note, cleaned the same way.
    pub fn clean_note(&self, note: &str) -> String {
        self.clean_text(note).unwrap_or_else(|| note.to_string())
    }
}
