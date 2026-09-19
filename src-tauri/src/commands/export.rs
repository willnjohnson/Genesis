use crate::{db, get_db_path};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{command, AppHandle, Emitter, Manager};

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportSummary {
    pub videos_exported: i64,
    pub glossary_terms: i64,
    pub biographies: i64,
    pub folder_path: String,
}

fn emit_progress(app: &AppHandle, msg: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("export_progress", msg);
    }
}

// Strips characters invalid in a Windows/macOS/Linux path component, collapses whitespace, trims
// trailing dots/spaces (Windows rejects those at the end of a path segment), and caps length so a
// deeply nested Warp Drive taxonomy or a long video title doesn't blow past Windows' historical
// MAX_PATH once every folder level is joined together.
fn sanitize_path_component(raw: &str, max_len: usize) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = collapsed.chars().take(max_len).collect();
    let result = truncated.trim().trim_end_matches(['.', ' ']).to_string();
    if result.is_empty() { "Untitled".to_string() } else { result }
}

// Obsidian tags can't contain spaces (and are cleaner without most punctuation); glossary term
// text itself is kept intact for the `[[Term]]` wiki-link and the Glossary note's own filename —
// this is only for the `tags:` frontmatter list.
fn slugify_tag(raw: &str) -> String {
    let mut out = String::new();
    let mut last_was_dash = false;
    for c in raw.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
            last_was_dash = false;
        } else if !last_was_dash && !out.is_empty() {
            out.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = out.trim_end_matches('-').to_string();
    if trimmed.is_empty() { "tag".to_string() } else { trimmed }
}

fn yaml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn display_handle(handle: &str) -> String {
    let h = handle.trim();
    if h.is_empty() || h.starts_with('@') { h.to_string() } else { format!("@{}", h) }
}

fn video_note_basename(title: &str, video_id: &str) -> String {
    format!("{} ({})", sanitize_path_component(title, 80), video_id)
}

fn glossary_note_basename(term: &str) -> String {
    sanitize_path_component(term, 80)
}

fn biography_note_basename(handle: &str) -> String {
    sanitize_path_component(&display_handle(handle), 80)
}

// The unassigned-Warp-Drive placeholders — see db::wdbs's own is_unassigned_sentinel. Neither
// represents a real taxonomy node, so a video carrying either goes to _Unsorted instead.
fn is_unassigned_wdbs(wdbs: &str) -> bool {
    matches!(wdbs, ":" | "θψ" | "")
}

fn flatten_wdbs_tree<'a>(nodes: &'a [db::WdbsNode], map: &mut HashMap<String, &'a db::WdbsNode>) {
    for n in nodes {
        map.insert(n.path.clone(), n);
        flatten_wdbs_tree(&n.children, map);
    }
}

// Storage-encoded WDBS ("θψUAP_GERB_PND") -> the folder path under Videos/ it belongs in, one
// sanitized component per taxonomy level, preferring each node's curated alias (tblWDBS.WDInfo)
// over its raw segment name — same preference get_wdbs_tree itself applies when the tree is shown
// in the Drive panel.
fn folder_segments_for_wdbs(wdbs: &str, node_map: &HashMap<String, &db::WdbsNode>) -> Vec<String> {
    let body = wdbs.strip_prefix("θψ").unwrap_or(wdbs);
    let segments: Vec<&str> = body.split('_').filter(|s| !s.is_empty()).collect();
    let mut path_acc = String::new();
    let mut names = Vec::new();
    for (i, seg) in segments.iter().enumerate() {
        path_acc = if i == 0 { format!("θψ{}", seg) } else { format!("{}_{}", path_acc, seg) };
        let label = node_map.get(&path_acc).and_then(|n| n.alias.clone()).unwrap_or_else(|| seg.to_string());
        names.push(sanitize_path_component(&label, 60));
    }
    names
}

// A Drive root (":CRYPTO") -> the name the vault shows for it: its curated alias when it has one
// (the same preference the video folders use), otherwise the bare segment.
fn drive_root_label(root: &str, node_map: &HashMap<String, &db::WdbsNode>) -> String {
    let segment = root.trim_start_matches(':');
    node_map
        .get(&format!("θψ{}", segment))
        .and_then(|n| n.alias.clone())
        .unwrap_or_else(|| segment.to_string())
}

fn parse_tags(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("").split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
}

/// Where links inside exported text can point: the notes this export writes. In-app links
/// (`[text](kinesis://...)`, see db/links.rs) become Obsidian wiki links to those notes. A link to
/// something that isn't in the export keeps just its text, and so does one to a Drive, since the
/// vault shows Drives as folders and a folder can't be linked to.
struct LinkResolver {
    glossary: HashMap<String, String>,
    /// Keyed by the handle without "@", lowercased.
    biographies: HashMap<String, String>,
    videos: HashMap<String, String>,
}

impl LinkResolver {
    fn note_for(&self, kind: db::links::LinkKind, key: &str) -> Option<String> {
        use db::links::LinkKind;
        match kind {
            LinkKind::Glossary => self.glossary.get(key).cloned(),
            LinkKind::Bio => self.biographies.get(&key.trim_start_matches('@').to_lowercase()).cloned(),
            LinkKind::Video => self.videos.get(key).cloned(),
            LinkKind::Drive => None,
        }
    }

    fn wikilinks(&self, text: &str) -> String {
        db::links::to_wikilinks(text, |kind, key| self.note_for(kind, key))
    }
}

/// The video player, embedded the way YouTube's own "Embed" snippet does it. Obsidian shows it in
/// reading view and live preview. `None` for an id that doesn't look like a YouTube id, so nothing
/// odd ever lands in the note's HTML.
fn youtube_embed(video_id: &str) -> Option<String> {
    let ok = (6..=20).contains(&video_id.len()) && video_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    ok.then(|| {
        format!(
            "<iframe width=\"560\" height=\"315\" src=\"https://www.youtube.com/embed/{video_id}\" title=\"YouTube video player\" frameborder=\"0\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" referrerpolicy=\"strict-origin-when-cross-origin\" allowfullscreen></iframe>"
        )
    })
}

fn build_video_note(video: &crate::Video, links: &LinkResolver) -> String {
    let tag_list = parse_tags(video.tags.as_deref());

    let mut fm = String::from("---\n");
    fm.push_str(&format!("title: {}\n", yaml_str(&video.title)));
    fm.push_str(&format!("video_id: {}\n", video.id));
    fm.push_str(&format!("url: {}\n", yaml_str(&format!("https://www.youtube.com/watch?v={}", video.id))));
    if let Some(author) = video.author.as_deref().filter(|a| !a.is_empty()) {
        fm.push_str(&format!("author: {}\n", yaml_str(author)));
    }
    if let Some(handle) = video.handle.as_deref().filter(|h| !h.is_empty()) {
        fm.push_str(&format!("handle: {}\n", yaml_str(&display_handle(handle))));
    }
    fm.push_str(&format!("view_count: {}\n", yaml_str(&video.view_count)));
    if !video.published_at.is_empty() {
        fm.push_str(&format!("published_at: {}\n", yaml_str(&video.published_at)));
    }
    if let Some(added) = video.date_added.as_deref().filter(|d| !d.is_empty()) {
        fm.push_str(&format!("date_added: {}\n", yaml_str(added)));
    }
    if let Some(len) = video.length_seconds {
        fm.push_str(&format!("length_seconds: {}\n", len));
    }
    if let Some(w) = video.wdbs.as_deref().filter(|w| !is_unassigned_wdbs(w)) {
        fm.push_str(&format!("wdbs: {}\n", yaml_str(&db::storage_to_display_path(w))));
    }
    if !tag_list.is_empty() {
        let slugs: Vec<String> = tag_list.iter().map(|t| slugify_tag(t)).collect();
        fm.push_str(&format!("tags: [{}]\n", slugs.join(", ")));
    }
    fm.push_str("---\n");

    let mut body = String::new();
    if let Some(embed) = youtube_embed(&video.id) {
        body.push_str(&embed);
        body.push_str("\n\n");
    }
    body.push_str(&format!("[Watch on YouTube](https://www.youtube.com/watch?v={})\n\n", video.id));
    if let Some(handle) = video.handle.as_deref().filter(|h| !h.is_empty()) {
        body.push_str(&format!("Channel: [[{}]]\n\n", biography_note_basename(handle)));
    } else if let Some(author) = video.author.as_deref().filter(|a| !a.is_empty()) {
        body.push_str(&format!("Channel: {}\n\n", author));
    }
    if !tag_list.is_empty() {
        let links: Vec<String> = tag_list.iter().map(|t| format!("[[{}]]", glossary_note_basename(t))).collect();
        body.push_str(&format!("Tags: {}\n\n", links.join(" ")));
    }

    let has_summary = video.has_summary.unwrap_or(false);
    let has_transcript = video.has_transcript.unwrap_or(false);
    if has_summary {
        body.push_str("## Summary\n\n");
        body.push_str(&links.wikilinks(video.summary.as_deref().unwrap_or("")));
        body.push_str("\n\n");
    }
    if has_transcript {
        body.push_str("## Transcript\n\n");
        body.push_str(&links.wikilinks(video.transcript.as_deref().unwrap_or("")));
        body.push('\n');
    }
    if !has_summary && !has_transcript {
        body.push_str("_No transcript or AI summary saved for this video._\n");
    }

    format!("{fm}{body}")
}

fn build_biography_note(bio: &db::BiographyExportRow, links_to: &LinkResolver) -> String {
    let handle = display_handle(&bio.handle);
    let title = if bio.display_name.trim().is_empty() { handle.clone() } else { bio.display_name.trim().to_string() };

    let mut fm = String::from("---\n");
    fm.push_str(&format!("handle: {}\n", yaml_str(&handle)));
    if !bio.display_name.trim().is_empty() {
        fm.push_str(&format!("display_name: {}\n", yaml_str(bio.display_name.trim())));
    }
    if bio.subscriber_count >= 0 {
        fm.push_str(&format!("subscriber_count: {}\n", bio.subscriber_count));
    }
    fm.push_str("---\n");

    let mut body = format!("# {}\n\n", title);
    if !bio.bio.trim().is_empty() {
        body.push_str(&links_to.wikilinks(bio.bio.trim()));
        body.push_str("\n\n");
    }

    let socials: [(&str, &str); 11] = [
        ("Wikipedia", &bio.wikipedia),
        ("Website", &bio.website),
        ("Twitter/X", &bio.twitter),
        ("Instagram", &bio.instagram),
        ("Facebook", &bio.facebook),
        ("Threads", &bio.threads),
        ("YouTube", &bio.youtube),
        ("TikTok", &bio.tiktok),
        ("Twitch", &bio.twitch),
        ("Reddit", &bio.reddit),
        ("Discord", &bio.discord),
    ];
    let links: Vec<String> = socials
        .iter()
        .filter(|(_, url)| !url.trim().is_empty())
        .map(|(label, url)| format!("- {}: {}", label, url.trim()))
        .collect();
    if !links.is_empty() {
        body.push_str("## Links\n\n");
        body.push_str(&links.join("\n"));
        body.push('\n');
    }

    format!("{fm}{body}")
}

/// Does the actual export work — pulled out of the `#[command]` wrapper below so it can be unit
/// tested directly against a throwaway SQLite file, without needing a running Tauri `AppHandle`.
/// See `export_to_obsidian` for the full behavior description.
/// Where the vault will actually be written for the name the user gave in the Save As dialog.
/// Never an existing folder (or file): if `chosen` is taken, the first free "name (2)", "name (3)",
/// ... beside it is used, so an export can't merge into or overwrite anything already there.
pub(crate) fn unique_vault_path(chosen: &Path) -> PathBuf {
    if !chosen.exists() {
        return chosen.to_path_buf();
    }
    let parent = chosen.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = chosen.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Vault".into());
    for n in 2..10_000 {
        let candidate = parent.join(format!("{name} ({n})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    chosen.to_path_buf()
}

/// Writes the vault into `root` (the folder is created; callers pass a path that doesn't exist yet,
/// see `unique_vault_path`).
fn run_export(
    db_path: &str,
    root: &Path,
    mut on_progress: impl FnMut(&str),
) -> Result<ExportSummary, String> {
    // The folder names follow the workspace's aliases (e.g. "Portal", "Thesaurus", "Creators"); they're
    // letters, digits and spaces only, so they're safe as folder names.
    let names = db::get_workspace_labels(db_path).map_err(|e| e.to_string())?;
    let (library_name, glossary_name, biography_name, drive_name) = (
        names["aliasLibrary"].clone(),
        names["aliasGlossary"].clone(),
        names["aliasBiography"].clone(),
        names["aliasDriveName"].clone(),
    );
    on_progress("Reading library...");
    let (videos, _total) = db::list_videos(db_path, None, None, None, i64::MAX, 0, true).map_err(|e| e.to_string())?;
    let wdbs_tree = db::get_wdbs_tree(db_path).map_err(|e| e.to_string())?;
    let links = db::get_all_video_wdbs_links(db_path).map_err(|e| e.to_string())?;
    let glossary_terms = db::get_glossary_terms(db_path).map_err(|e| e.to_string())?;
    let biographies = db::get_all_biographies_for_export(db_path).map_err(|e| e.to_string())?;

    let mut node_map: HashMap<String, &db::WdbsNode> = HashMap::new();
    flatten_wdbs_tree(&wdbs_tree, &mut node_map);

    let root = root.to_path_buf();
    let videos_root = root.join(sanitize_path_component(&library_name, 60));
    let unsorted_root = videos_root.join("_Unsorted");
    let glossary_root = root.join(sanitize_path_component(&glossary_name, 60));
    let biography_root = root.join(sanitize_path_component(&biography_name, 60));

    for dir in [&videos_root, &unsorted_root, &glossary_root, &biography_root] {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    }

    // Every note name is known before any note is written, so a link can point at one written later.
    let basename_by_id: HashMap<String, String> =
        videos.iter().map(|v| (v.id.clone(), video_note_basename(&v.title, &v.id))).collect();
    let resolver = LinkResolver {
        glossary: glossary_terms.iter().map(|(t, _)| (t.clone(), glossary_note_basename(t))).collect(),
        biographies: biographies
            .iter()
            .filter(|b| !b.handle.trim().is_empty())
            .map(|b| (b.handle.trim().trim_start_matches('@').to_lowercase(), biography_note_basename(&b.handle)))
            .collect(),
        videos: basename_by_id.clone(),
    };

    let total = videos.len();
    on_progress(&format!("Exporting {} videos...", total));
    for (i, video) in videos.iter().enumerate() {
        let basename = basename_by_id[&video.id].clone();

        let dir = match video.wdbs.as_deref().filter(|w| !is_unassigned_wdbs(w)) {
            Some(w) => {
                let mut d = videos_root.clone();
                for seg in folder_segments_for_wdbs(w, &node_map) {
                    d = d.join(seg);
                }
                d
            }
            None => unsorted_root.clone(),
        };
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
        let file_path = dir.join(format!("{}.md", basename));
        fs::write(&file_path, build_video_note(video, &resolver)).map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;

        if i % 10 == 0 || i + 1 == total {
            on_progress(&format!("Exporting videos ({}/{})...", i + 1, total));
        }
    }

    if !links.is_empty() {
        on_progress("Linking secondary categories...");
        for (video_id, link_wdbs) in &links {
            if is_unassigned_wdbs(link_wdbs) {
                continue;
            }
            let Some(basename) = basename_by_id.get(video_id) else { continue };
            let mut dir = videos_root.clone();
            for seg in folder_segments_for_wdbs(link_wdbs, &node_map) {
                dir = dir.join(seg);
            }
            fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
            let file_path = dir.join(format!("{}.md", basename));
            let stub = format!("---\ntype: alias\nvideo_id: {}\n---\nSee: [[{}]]\n", video_id, basename);
            fs::write(&file_path, stub).map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;
        }
    }

    on_progress(&format!("Writing {glossary_name}..."));
    // Standard Glossary Tags can be filed under top-level Drives. Each term keeps a single note at
    // <Glossary>/<term>.md (so every [[Term]] link still resolves to exactly one file) and lists its
    // drives in frontmatter; "By <Drive>" index notes then group the same terms per drive.
    let mut drives_by_term: HashMap<String, Vec<String>> = HashMap::new();
    let mut terms_by_drive: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (term, root) in db::get_glossary_drive_links(db_path).map_err(|e| e.to_string())? {
        let label = drive_root_label(&root, &node_map);
        drives_by_term.entry(term.clone()).or_default().push(label.clone());
        terms_by_drive.entry(label).or_default().push(term);
    }

    for (term, definition) in &glossary_terms {
        let file_path = glossary_root.join(format!("{}.md", glossary_note_basename(term)));
        let mut fm = format!("---\ntype: glossary-term\nterm: {}\n", yaml_str(term));
        if let Some(labels) = drives_by_term.get(term).filter(|l| !l.is_empty()) {
            let quoted: Vec<String> = labels.iter().map(|l| yaml_str(l)).collect();
            fm.push_str(&format!("drives: [{}]\n", quoted.join(", ")));
        }
        fm.push_str("---\n");
        let content = format!("{}{}\n", fm, resolver.wikilinks(definition));
        fs::write(&file_path, content).map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;
    }

    if !terms_by_drive.is_empty() {
        let index_root = glossary_root.join(sanitize_path_component(&format!("By {drive_name}"), 60));
        fs::create_dir_all(&index_root).map_err(|e| format!("Failed to create {}: {}", index_root.display(), e))?;
        for (label, terms) in &terms_by_drive {
            let links: Vec<String> = terms.iter().map(|t| format!("- [[{}]]", glossary_note_basename(t))).collect();
            let content = format!(
                "---\ntype: glossary-drive\ndrive: {}\n---\n# {}\n\n{}\n",
                yaml_str(label),
                label,
                links.join("\n")
            );
            let file_path = index_root.join(format!("{}.md", sanitize_path_component(label, 60)));
            fs::write(&file_path, content).map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;
        }
    }

    on_progress(&format!("Writing {biography_name}..."));
    for bio in &biographies {
        if bio.handle.trim().is_empty() {
            continue;
        }
        let file_path = biography_root.join(format!("{}.md", biography_note_basename(&bio.handle)));
        fs::write(&file_path, build_biography_note(bio, &resolver)).map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;
    }

    on_progress("Done.");
    Ok(ExportSummary {
        videos_exported: videos.len() as i64,
        glossary_terms: glossary_terms.len() as i64,
        biographies: biographies.len() as i64,
        folder_path: root.to_string_lossy().to_string(),
    })
}

/// Exports the entire library — videos (with transcript/AI summary), the Warp Drive/Drive
/// taxonomy as nested folders, the Glossary, and Biography entries — as a folder of Markdown notes
/// usable directly as an Obsidian vault. `vault_path` is the folder the user named in the Save As
/// dialog; it is always a NEW folder (see `unique_vault_path`), so nothing already on disk is ever
/// merged into, overwritten or deleted. Folder names inside the vault follow the workspace's aliases
/// (db/workspace.rs): the Library, Glossary and Biography folders and the glossary's "By <Drive>"
/// index. The returned summary carries the folder actually written.
#[command]
pub async fn export_to_obsidian(
    app: AppHandle,
    vault_path: String,
) -> Result<ExportSummary, String> {
    let db_path = get_db_path(&app);
    let root = unique_vault_path(Path::new(&vault_path));
    run_export(&db_path, &root, |msg| emit_progress(&app, msg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kinesis_export_test_{}_{}", label, n));
        // Start clean: a previous failed run leaves its output behind (the counter restarts at 0).
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn in_app_links_become_wiki_links_and_the_thumbnail_becomes_an_embedded_player() {
        use db::links::{build_link, LinkKind};
        let work_dir = temp_dir("wl");
        let db_path = work_dir.join("test.db").to_string_lossy().to_string();
        db::init_db(&db_path).unwrap();
        db::save_video(&db_path, "vid1abcdefg", "First Talk", "Ann", 60, "words", 1, "2026-01-02T00:00:00Z", "@ann", None).unwrap();
        db::save_video(&db_path, "vid2abcdefg", "Second Talk", "Bob", 60, "words", 1, "2026-01-03T00:00:00Z", "@bob", None).unwrap();
        db::save_glossary_term(&db_path, None, "Halving", "Cuts rewards. See also [the talk](kinesis://video/vid1abcdefg).", &[]).unwrap();

        let summary = format!(
            "{} and {} and {} and {} and {} and {}",
            build_link("Halving", LinkKind::Glossary, "Halving"),
            build_link("what it means", LinkKind::Glossary, "Halving"),
            build_link("the second talk", LinkKind::Video, "vid2abcdefg"),
            build_link("Ann", LinkKind::Bio, "ann"),
            build_link("UAP", LinkKind::Drive, "θψUAP"),
            build_link("gone", LinkKind::Glossary, "Missing"),
        );
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute("UPDATE videos SET summary = ?1 WHERE video_id = 'vid1abcdefg'", [&summary]).unwrap();
        conn.execute("INSERT INTO biographies (handle, display_name, bio) VALUES ('@ann', 'Ann', 'Friend of [First Talk](kinesis://video/vid1abcdefg).')", []).unwrap();
        drop(conn);

        let out_dir = temp_dir("wlout");
        run_export(&db_path, &out_dir.join("TestApp"), |_| {}).unwrap();
        let root = out_dir.join("TestApp");

        let note = fs::read_to_string(root.join("Library/_Unsorted/First Talk (vid1abcdefg).md")).unwrap();
        assert!(
            note.contains("[[Halving]] and [[Halving|what it means]] and [[Second Talk (vid2abcdefg)|the second talk]] and [[@ann|Ann]] and UAP and gone"),
            "{note}"
        );
        assert!(!note.contains("kinesis://"), "{note}");

        // The player is embedded instead of the thumbnail image.
        assert!(note.contains("<iframe ") && note.contains("src=\"https://www.youtube.com/embed/vid1abcdefg\""), "{note}");
        assert!(!note.contains("![Thumbnail]"), "{note}");
        assert!(note.contains("[Watch on YouTube](https://www.youtube.com/watch?v=vid1abcdefg)"));

        // Glossary definitions and biographies get the same treatment.
        let term = fs::read_to_string(root.join("Glossary/Halving.md")).unwrap();
        assert!(term.contains("See also [[First Talk (vid1abcdefg)|the talk]]."), "{term}");
        let bio = fs::read_to_string(root.join("Biography/@ann.md")).unwrap();
        assert!(bio.contains("Friend of [[First Talk (vid1abcdefg)|First Talk]]."), "{bio}");

        fs::remove_dir_all(&work_dir).ok();
        fs::remove_dir_all(&out_dir).ok();
    }

    #[test]
    fn only_youtube_looking_ids_get_an_embedded_player() {
        assert!(youtube_embed("dQw4w9WgXcQ").is_some());
        assert!(youtube_embed("").is_none());
        assert!(youtube_embed("abc").is_none());
        assert!(youtube_embed("x\"><script>alert(1)</script>").is_none());
    }

    #[test]
    fn glossary_drives_are_exported_as_frontmatter_and_per_drive_index_notes() {
        let work_dir = temp_dir("gdb");
        let db_path = work_dir.join("test.db").to_string_lossy().to_string();
        db::init_db(&db_path).unwrap();
        db::save_video(&db_path, "vid1", "A Video", "Author", 60, "words", 1, "2026-01-02T00:00:00Z", "@a", None).unwrap();
        db::update_video_wdbs(&db_path, "vid1", "θψUAP_GERB").unwrap();
        // The command layer registers a category's taxonomy rows (an alias needs its row to exist).
        db::ensure_wdbs_path_exists(&db_path, ":UAP-GERB").unwrap();
        db::set_wdbs_alias(&db_path, "θψUAP", "Unidentified").unwrap();

        // A term in two drives (one aliased), one in a single drive, an uncategorized one, a Quick Tag.
        let both = [":UAP".to_string(), ":FIN".to_string()];
        db::save_glossary_term(&db_path, None, "Halving", "Supply cut", &both).unwrap();
        db::save_glossary_term(&db_path, None, "Orb", "A sphere", &[":UAP".to_string()]).unwrap();
        db::save_glossary_term(&db_path, None, "Loose", "No drive", &[]).unwrap();
        db::save_glossary_term(&db_path, None, "qt", "", &[]).unwrap();

        let out_dir = temp_dir("gout");
        let summary = run_export(&db_path, &out_dir.join("TestApp"), |_| {}).unwrap();
        assert_eq!(summary.glossary_terms, 4);
        let glossary = out_dir.join("TestApp/Glossary");

        // One note per term, so [[Term]] links stay unambiguous; drives listed by their display names.
        let halving = fs::read_to_string(glossary.join("Halving.md")).unwrap();
        assert!(halving.contains("drives: [\"FIN\", \"Unidentified\"]\n"), "{halving}");
        assert!(halving.ends_with("---\nSupply cut\n"), "the body still starts right after the frontmatter: {halving}");
        assert!(!fs::read_to_string(glossary.join("Loose.md")).unwrap().contains("drives:"));
        assert!(!fs::read_to_string(glossary.join("qt.md")).unwrap().contains("drives:"));
        assert_eq!(fs::read_dir(&glossary).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy() == "Halving.md").count(), 1);

        // One index note per drive listing its terms.
        let unidentified = fs::read_to_string(glossary.join("By Drive/Unidentified.md")).unwrap();
        assert!(unidentified.contains("type: glossary-drive") && unidentified.contains("drive: \"Unidentified\""), "{unidentified}");
        assert!(unidentified.contains("- [[Halving]]") && unidentified.contains("- [[Orb]]"), "{unidentified}");
        let fin = fs::read_to_string(glossary.join("By Drive/FIN.md")).unwrap();
        assert!(fin.contains("- [[Halving]]") && !fin.contains("Orb"), "{fin}");
        assert!(!glossary.join("By Drive/UAP.md").exists(), "the aliased drive is named by its alias");

        fs::remove_dir_all(&work_dir).ok();
        fs::remove_dir_all(&out_dir).ok();
    }

    #[test]
    fn a_chosen_vault_name_never_collides_with_an_existing_folder_or_file() {
        let base = temp_dir("uniq");
        let vault = base.join("Kinesis_Vault");

        // Free name: used as given.
        assert_eq!(unique_vault_path(&vault), vault);

        // Taken by a folder (say, a previous export): the next free numbered name, then the next.
        fs::create_dir_all(&vault).unwrap();
        fs::write(vault.join("keep.md"), "existing note").unwrap();
        assert_eq!(unique_vault_path(&vault), base.join("Kinesis_Vault (2)"));
        fs::create_dir_all(base.join("Kinesis_Vault (2)")).unwrap();
        assert_eq!(unique_vault_path(&vault), base.join("Kinesis_Vault (3)"));

        // Taken by a plain file counts too.
        fs::write(base.join("Notes"), "a file").unwrap();
        assert_eq!(unique_vault_path(&base.join("Notes")), base.join("Notes (2)"));

        // Exporting to the taken name leaves the existing folder untouched and writes beside it.
        let db_dir = temp_dir("uniqdb");
        let db_path = db_dir.join("t.db").to_string_lossy().to_string();
        db::init_db(&db_path).unwrap();
        db::add_glossary_term(&db_path, "T", "d").unwrap();
        let target = unique_vault_path(&vault);
        let summary = run_export(&db_path, &target, |_| {}).unwrap();
        assert_eq!(summary.folder_path, target.to_string_lossy());
        assert!(target.join("Glossary/T.md").exists());
        assert_eq!(fs::read_to_string(vault.join("keep.md")).unwrap(), "existing note");
        assert!(!vault.join("Glossary").exists(), "nothing was written into the existing folder");

        fs::remove_dir_all(&base).ok();
        fs::remove_dir_all(&db_dir).ok();
    }

    #[test]
    fn a_vault_without_any_drive_assignments_has_no_by_drive_folder() {
        let work_dir = temp_dir("nodrv");
        let db_path = work_dir.join("test.db").to_string_lossy().to_string();
        db::init_db(&db_path).unwrap();
        db::add_glossary_term(&db_path, "Plain", "Just a term").unwrap();
        let out_dir = temp_dir("nodrvout");
        run_export(&db_path, &out_dir.join("TestApp"), |_| {}).unwrap();
        assert!(out_dir.join("TestApp/Glossary/Plain.md").exists());
        assert!(!out_dir.join("TestApp/Glossary/By Drive").exists());
        fs::remove_dir_all(&work_dir).ok();
        fs::remove_dir_all(&out_dir).ok();
    }

    #[test]
    fn folders_and_notes_follow_the_workspace_aliases() {
        let work_dir = temp_dir("alias");
        let db_path = work_dir.join("test.db").to_string_lossy().to_string();
        db::init_db(&db_path).unwrap();
        db::save_video(&db_path, "vid1", "A Talk", "Author", 60, "text", 1, "2026-01-02T00:00:00Z", "@ann", None).unwrap();
        db::add_glossary_term(&db_path, "Halving", "Cuts the reward").unwrap();
        for (key, value) in [
            ("aliasLibrary", "Portal"),
            ("aliasGlossary", "Thesaurus"),
            ("aliasBiography", "Creators"),
            ("aliasDriveName", "Warp Drive"),
        ] {
            db::set_workspace_label(&db_path, key, value).unwrap();
        }
        let out_dir = temp_dir("aliasout");
        let root = out_dir.join("TestApp");
        run_export(&db_path, &root, |_| {}).unwrap();
        assert!(root.join("Portal/_Unsorted/A Talk (vid1).md").exists());
        assert!(root.join("Thesaurus/Halving.md").exists());
        assert!(root.join("Creators").is_dir());
        for default_name in ["Library", "Glossary", "Biography"] {
            assert!(!root.join(default_name).exists(), "{default_name} should not be used once aliased");
        }
        fs::remove_dir_all(&work_dir).ok();
        fs::remove_dir_all(&out_dir).ok();
    }

    #[test]
    fn exports_videos_glossary_and_biography_with_working_links() {
        let work_dir = temp_dir("db");
        let db_path = work_dir.join("test.db").to_string_lossy().to_string();
        db::init_db(&db_path).unwrap();

        // A video with a canonical Warp Drive category, a tag, and a channel handle — exercises
        // taxonomy folders, the [[Term]] tag link, and the [[@handle]] channel link.
        db::save_video(&db_path, "vid1", "My First Video", "Test Author", 754, "Hello world transcript.", 12345, "2026-01-02T00:00:00Z", "@testcreator", Some("A short AI summary.")).unwrap();
        db::update_video_wdbs(&db_path, "vid1", "θψUAP_GERB").unwrap();
        db::save_tags(&db_path, "vid1", "MyTerm").unwrap();

        // A second video left unassigned — exercises the _Unsorted fallback — plus a symlink into
        // another category, exercising the stub "See: [[...]]" note.
        db::save_video(&db_path, "vid2", "Unsorted Video", "Other Author", 100, "", 0, "2026-01-03T00:00:00Z", "", None).unwrap();
        db::add_video_wdbs_link(&db_path, "vid1", "θψOTHERCAT").unwrap();

        db::add_glossary_term(&db_path, "MyTerm", "A test definition.").unwrap();
        db::upsert_biography_from_video(&db_path, "@testcreator", "Test Creator", None, -1).unwrap();

        let out_dir = temp_dir("out");
        let summary = run_export(&db_path, &out_dir.join("TestApp"), |_| {}).unwrap();

        assert_eq!(summary.videos_exported, 2);
        assert_eq!(summary.glossary_terms, 1);
        assert_eq!(summary.biographies, 1);

        let root = out_dir.join("TestApp");
        assert!(root.join("Library/UAP/GERB/My First Video (vid1).md").exists(), "video note should land in its taxonomy folder");
        assert!(root.join("Library/_Unsorted/Unsorted Video (vid2).md").exists(), "unassigned video should fall back to _Unsorted");
        assert!(root.join("Library/OTHERCAT/My First Video (vid1).md").exists(), "symlinked category should get a stub note");
        assert!(root.join("Glossary/MyTerm.md").exists());
        assert!(root.join("Biography/@testcreator.md").exists());

        let video_note = fs::read_to_string(root.join("Library/UAP/GERB/My First Video (vid1).md")).unwrap();
        assert!(video_note.contains("[[MyTerm]]"), "tag should render as a wiki-link to the Glossary note");
        assert!(video_note.contains("[[@testcreator]]"), "channel should render as a wiki-link to the Biography note");
        assert!(video_note.contains("## Summary"));
        assert!(video_note.contains("A short AI summary."));
        assert!(video_note.starts_with("---\n"), "no blank line should separate the opening --- from the first frontmatter key");
        assert!(!video_note.contains("---\n\n"), "no blank line should separate the closing --- from the note body");

        let glossary_note = fs::read_to_string(root.join("Glossary/MyTerm.md")).unwrap();
        assert!(glossary_note.ends_with("---\nA test definition.\n"), "definition should start right after the closing ---, no blank line");

        let bio_note = fs::read_to_string(root.join("Biography/@testcreator.md")).unwrap();
        assert!(!bio_note.contains("---\n\n"), "no blank line should separate the closing --- from the note body");

        let stub_note = fs::read_to_string(root.join("Library/OTHERCAT/My First Video (vid1).md")).unwrap();
        assert!(stub_note.contains("See: [[My First Video (vid1)]]"));

        fs::remove_dir_all(&work_dir).ok();
        fs::remove_dir_all(&out_dir).ok();
    }
}
