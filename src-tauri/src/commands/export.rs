use crate::{db, get_db_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
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

fn parse_tags(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("").split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
}

fn build_video_note(video: &crate::Video) -> String {
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
    body.push_str(&format!("![Thumbnail]({})\n\n", video.thumbnail));
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
        body.push_str(video.summary.as_deref().unwrap_or(""));
        body.push_str("\n\n");
    }
    if has_transcript {
        body.push_str("## Transcript\n\n");
        body.push_str(video.transcript.as_deref().unwrap_or(""));
        body.push('\n');
    }
    if !has_summary && !has_transcript {
        body.push_str("_No transcript or AI summary saved for this video._\n");
    }

    format!("{fm}{body}")
}

fn build_biography_note(bio: &db::BiographyExportRow) -> String {
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
        body.push_str(bio.bio.trim());
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
fn run_export(
    db_path: &str,
    folder_path: &str,
    container_name: &str,
    videos_label: &str,
    mut on_progress: impl FnMut(&str),
) -> Result<ExportSummary, String> {
    on_progress("Reading library...");
    let (videos, _total) = db::list_videos(db_path, None, None, None, i64::MAX, 0, true).map_err(|e| e.to_string())?;
    let wdbs_tree = db::get_wdbs_tree(db_path).map_err(|e| e.to_string())?;
    let links = db::get_all_video_wdbs_links(db_path).map_err(|e| e.to_string())?;
    let glossary_terms = db::get_glossary_terms(db_path).map_err(|e| e.to_string())?;
    let biographies = db::get_all_biographies_for_export(db_path).map_err(|e| e.to_string())?;

    let mut node_map: HashMap<String, &db::WdbsNode> = HashMap::new();
    flatten_wdbs_tree(&wdbs_tree, &mut node_map);

    let root = PathBuf::from(folder_path).join(sanitize_path_component(container_name, 60));
    let videos_root = root.join(sanitize_path_component(videos_label, 60));
    let unsorted_root = videos_root.join("_Unsorted");
    let glossary_root = root.join("Glossary");
    let biography_root = root.join("Biography");

    for dir in [&videos_root, &unsorted_root, &glossary_root, &biography_root] {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    }

    let total = videos.len();
    on_progress(&format!("Exporting {} videos...", total));
    let mut basename_by_id: HashMap<String, String> = HashMap::new();
    for (i, video) in videos.iter().enumerate() {
        let basename = video_note_basename(&video.title, &video.id);
        basename_by_id.insert(video.id.clone(), basename.clone());

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
        fs::write(&file_path, build_video_note(video)).map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;

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

    on_progress("Writing Glossary...");
    for (term, definition) in &glossary_terms {
        let file_path = glossary_root.join(format!("{}.md", glossary_note_basename(term)));
        let content = format!("---\ntype: glossary-term\nterm: {}\n---\n{}\n", yaml_str(term), definition);
        fs::write(&file_path, content).map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;
    }

    on_progress("Writing Biography...");
    for bio in &biographies {
        if bio.handle.trim().is_empty() {
            continue;
        }
        let file_path = biography_root.join(format!("{}.md", biography_note_basename(&bio.handle)));
        fs::write(&file_path, build_biography_note(bio)).map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;
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
/// usable directly as an Obsidian vault. Everything is written under
/// `<folder_path>/<container_name>/`, never at `folder_path`'s own root and never deleting
/// anything, so pointing this at an existing Obsidian vault only ever adds/overwrites files inside
/// that one named subfolder. `container_name`/`videos_label` come from the frontend's BRAND config
/// (see src/branding.ts) so folder naming stays on-brand without this module needing to know about
/// Kinesis vs. Genesis itself.
#[command]
pub async fn export_to_obsidian(
    app: AppHandle,
    folder_path: String,
    container_name: String,
    videos_label: String,
) -> Result<ExportSummary, String> {
    let db_path = get_db_path(&app);
    run_export(&db_path, &folder_path, &container_name, &videos_label, |msg| emit_progress(&app, msg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kinesis_export_test_{}_{}", label, n));
        fs::create_dir_all(&dir).unwrap();
        dir
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
        let summary = run_export(&db_path, &out_dir.to_string_lossy(), "TestApp", "Library", |_| {}).unwrap();

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
