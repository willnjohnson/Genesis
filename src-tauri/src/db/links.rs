//! Links from markdown text to other parts of the app.
//!
//! A link is an ordinary markdown link with an in-app address: `[Halving](kinesis://glossary/Halving)`.
//! The address carries the same natural key the target already has (glossary term, channel handle,
//! video id, Drive path), percent-encoded, so links keep meaning the same thing in a shared or synced
//! database. The Ctrl+Shift+K picker writes them and the app opens them (src/lib/internal-links.ts).
//! This module keeps them tidy: it removes or renames links when their target goes away or is renamed,
//! and turns them into Obsidian wiki links on export.

use regex::{Captures, Regex};
use rusqlite::{params, Connection, Result};
use std::sync::OnceLock;

use super::schema::table_exists;

pub const SCHEME: &str = "kinesis://";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Glossary,
    Bio,
    Video,
    Drive,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Glossary => "glossary",
            LinkKind::Bio => "bio",
            LinkKind::Video => "video",
            LinkKind::Drive => "drive",
        }
    }

    fn parse(s: &str) -> Option<LinkKind> {
        match s {
            "glossary" => Some(LinkKind::Glossary),
            "bio" => Some(LinkKind::Bio),
            "video" => Some(LinkKind::Video),
            "drive" => Some(LinkKind::Drive),
            _ => None,
        }
    }
}

/// One link found in some text.
#[derive(Debug, Clone, PartialEq)]
pub struct InternalLink {
    pub text: String,
    pub kind: LinkKind,
    /// The decoded key (the term, handle, video id or Drive path).
    pub key: String,
}

/// Percent-encodes a key for use in a link address. Everything but letters, digits and `-_.~` is
/// encoded, including parentheses, so a key like "Bitcoin (BTC)" can't break the markdown link.
pub fn encode_key(key: &str) -> String {
    urlencoding::encode(key).into_owned()
}

pub fn build_link(text: &str, kind: LinkKind, key: &str) -> String {
    format!("[{}]({}{}/{})", text, SCHEME, kind.as_str(), encode_key(key))
}

fn link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[([^\[\]]*)\]\(kinesis://(glossary|bio|video|drive)/([A-Za-z0-9\-._~%]+)\)").unwrap()
    })
}

fn parse_captures(caps: &Captures) -> Option<InternalLink> {
    let kind = LinkKind::parse(&caps[2])?;
    let key = urlencoding::decode(&caps[3]).ok()?.into_owned();
    Some(InternalLink { text: caps[1].to_string(), kind, key })
}

/// What to do with one link found while rewriting text.
pub enum LinkAction {
    Keep,
    /// Drop the link, keeping its visible text.
    Unlink,
    /// Point it at a different key of the same kind.
    Retarget(String),
    /// Replace the whole link with this text.
    ReplaceWith(String),
}

/// Rewrites every internal link in `text` according to `decide`. `None` when nothing changed.
pub fn rewrite_links(text: &str, mut decide: impl FnMut(&InternalLink) -> LinkAction) -> Option<String> {
    if !text.contains(SCHEME) {
        return None;
    }
    let mut changed = false;
    let out = link_re().replace_all(text, |caps: &Captures| {
        let Some(link) = parse_captures(caps) else { return caps[0].to_string() };
        match decide(&link) {
            LinkAction::Keep => caps[0].to_string(),
            LinkAction::Unlink => {
                changed = true;
                link.text
            }
            LinkAction::Retarget(new_key) => {
                changed = true;
                build_link(&link.text, link.kind, &new_key)
            }
            LinkAction::ReplaceWith(replacement) => {
                changed = true;
                replacement
            }
        }
    });
    changed.then(|| out.into_owned())
}

/// Every internal link in `text`, in order.
pub fn find_links(text: &str) -> Vec<InternalLink> {
    if !text.contains(SCHEME) {
        return Vec::new();
    }
    link_re().captures_iter(text).filter_map(|c| parse_captures(&c)).collect()
}

/// Turns internal links into Obsidian wiki links. `resolve` gives the note name for a target that
/// exists in the export, or `None` for one that doesn't (those keep just their text).
pub fn to_wikilinks(text: &str, resolve: impl Fn(LinkKind, &str) -> Option<String>) -> String {
    rewrite_links(text, |link| {
        let visible: String = link.text.chars().filter(|c| !matches!(c, '|' | '[' | ']')).collect();
        let visible = visible.trim().to_string();
        match resolve(link.kind, &link.key) {
            Some(note) if visible.is_empty() || visible == note => LinkAction::ReplaceWith(format!("[[{note}]]")),
            Some(note) => LinkAction::ReplaceWith(format!("[[{note}|{visible}]]")),
            None => LinkAction::ReplaceWith(if visible.is_empty() { link.key.clone() } else { visible }),
        }
    })
    .unwrap_or_else(|| text.to_string())
}

/// A change to make to links pointing at one target.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkEdit {
    /// The target is gone: drop the links, keep their text.
    Unlink(LinkKind, String),
    /// The target was renamed: point the links at the new key.
    Retarget(LinkKind, String, String),
}

fn same_key(kind: LinkKind, a: &str, b: &str) -> bool {
    match kind {
        // Handles are matched the way the rest of the app does: ignoring case and a leading "@".
        LinkKind::Bio => a.trim_start_matches('@').eq_ignore_ascii_case(b.trim_start_matches('@')),
        _ => a == b,
    }
}

fn apply_edits(text: &str, edits: &[LinkEdit]) -> Option<String> {
    rewrite_links(text, |link| {
        for edit in edits {
            match edit {
                LinkEdit::Unlink(kind, key) if *kind == link.kind && same_key(*kind, key, &link.key) => return LinkAction::Unlink,
                LinkEdit::Retarget(kind, key, new_key) if *kind == link.kind && same_key(*kind, key, &link.key) => {
                    return LinkAction::Retarget(new_key.clone())
                }
                _ => {}
            }
        }
        LinkAction::Keep
    })
}

/// The places link text can live: (table, column). Notes on videos count too.
const TEXT_COLUMNS: &[(&str, &str)] = &[
    ("Videos", "summary"),
    ("Videos", "transcript"),
    ("Biographies", "bio"),
    ("Glossary", "definition"),
    ("VideoNotes", "note"),
];

/// Applies `edits` to every stored text that contains an internal link, and returns how many texts
/// changed. One pass covers any number of edits: the database is scanned once per column for text
/// containing `kinesis://` at all (about a tenth of a second for the summaries of 5,000 videos and
/// a bit over a second including their transcripts), and only those texts are looked at further.
pub fn apply_link_edits(db_path: &str, edits: &[LinkEdit]) -> Result<usize> {
    if edits.is_empty() {
        return Ok(0);
    }
    let mut conn = Connection::open(db_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    let mut changed = 0;
    for (table, column) in TEXT_COLUMNS {
        if !table_exists(&conn, table)? {
            continue;
        }
        let rows: Vec<(i64, String)> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT rowid, {column} FROM {table} WHERE {column} IS NOT NULL AND INSTR({column}, ?1) > 0"
            ))?;
            let mapped = stmt.query_map(params![SCHEME], |r| Ok((r.get(0)?, r.get(1)?)))?;
            mapped.filter_map(|r| r.ok()).collect()
        };
        if rows.is_empty() {
            continue;
        }
        let tx = conn.transaction()?;
        for (rowid, text) in rows {
            if let Some(new_text) = apply_edits(&text, edits) {
                tx.execute(&format!("UPDATE {table} SET {column} = ?1 WHERE rowid = ?2"), params![new_text, rowid])?;
                changed += 1;
            }
        }
        tx.commit()?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{delete_glossary_term, delete_video, init_db, save_glossary_term, save_video};

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_links_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    #[test]
    fn links_are_built_found_and_decoded() {
        let link = build_link("the halving", LinkKind::Glossary, "Bitcoin (BTC) Halving");
        assert_eq!(link, "[the halving](kinesis://glossary/Bitcoin%20%28BTC%29%20Halving)");
        let found = find_links(&format!("see {link} and {}", build_link("Ann", LinkKind::Bio, "ann_b")));
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], InternalLink { text: "the halving".into(), kind: LinkKind::Glossary, key: "Bitcoin (BTC) Halving".into() });
        assert_eq!(found[1].kind, LinkKind::Bio);
        // Non-ASCII keys (Drive paths start with θψ) survive the round trip.
        let drive = build_link("UAP", LinkKind::Drive, "θψUAP_GERB");
        assert_eq!(find_links(&drive)[0].key, "θψUAP_GERB");
        // Ordinary and unknown links are not internal links.
        assert!(find_links("[x](https://example.com) [y](kinesis://nothing/here)").is_empty());
    }

    #[test]
    fn unlinking_keeps_the_text_and_only_touches_the_named_target() {
        let text = format!(
            "{} then {} and [web](https://example.com)",
            build_link("Halving", LinkKind::Glossary, "Halving"),
            build_link("Orb", LinkKind::Glossary, "Orb")
        );
        let out = apply_edits(&text, &[LinkEdit::Unlink(LinkKind::Glossary, "Halving".into())]).unwrap();
        assert_eq!(out, format!("Halving then {} and [web](https://example.com)", build_link("Orb", LinkKind::Glossary, "Orb")));
        assert!(apply_edits(&text, &[LinkEdit::Unlink(LinkKind::Video, "Halving".into())]).is_none(), "another kind is left alone");
        assert!(apply_edits("no links here", &[LinkEdit::Unlink(LinkKind::Video, "x".into())]).is_none());
        // Handles match ignoring case and "@".
        let bio = build_link("Ann", LinkKind::Bio, "AnnB");
        assert_eq!(apply_edits(&bio, &[LinkEdit::Unlink(LinkKind::Bio, "@annb".into())]).unwrap(), "Ann");
    }

    #[test]
    fn retargeting_points_links_at_the_new_key() {
        let text = build_link("Halving", LinkKind::Glossary, "Halving");
        let out = apply_edits(&text, &[LinkEdit::Retarget(LinkKind::Glossary, "Halving".into(), "Bitcoin Halving".into())]).unwrap();
        assert_eq!(out, "[Halving](kinesis://glossary/Bitcoin%20Halving)");
    }

    #[test]
    fn wikilinks_use_the_note_when_it_exists_and_plain_text_when_it_does_not() {
        let resolve = |kind: LinkKind, key: &str| match (kind, key) {
            (LinkKind::Glossary, "Halving") => Some("Halving".to_string()),
            (LinkKind::Video, "abc") => Some("Some Video (abc)".to_string()),
            _ => None,
        };
        let text = format!(
            "{} / {} / {} / {}",
            build_link("Halving", LinkKind::Glossary, "Halving"),
            build_link("the halving", LinkKind::Glossary, "Halving"),
            build_link("that video", LinkKind::Video, "abc"),
            build_link("Somebody", LinkKind::Bio, "nobody")
        );
        assert_eq!(to_wikilinks(&text, resolve), "[[Halving]] / [[Halving|the halving]] / [[Some Video (abc)|that video]] / Somebody");
        assert_eq!(to_wikilinks("nothing to change [x](https://e.com)", resolve), "nothing to change [x](https://e.com)");
    }

    #[test]
    fn deleting_a_term_or_video_removes_links_to_it_everywhere() {
        let db = temp_db("cleanup");
        save_video(&db, "v1", "One", "A", 60, "see [Halving](kinesis://glossary/Halving) in the talk", 1, "2026-01-01T00:00:00Z", "@a", None).unwrap();
        save_video(&db, "v2", "Two", "B", 60, "words", 1, "2026-01-01T00:00:00Z", "@b", None).unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute("UPDATE Videos SET summary = ?1 WHERE video_id = 'v2'", params!["Refers to [One](kinesis://video/v1) and [Orb](kinesis://glossary/Orb)."]).unwrap();
        conn.execute("INSERT INTO Biographies (handle, display_name, bio) VALUES ('@b', 'B', 'Friend of [One](kinesis://video/v1).')", []).unwrap();
        drop(conn);
        save_glossary_term(&db, None, "Halving", "Cuts [One](kinesis://video/v1) rewards", &[]).unwrap();
        save_glossary_term(&db, None, "Orb", "A sphere", &[]).unwrap();

        delete_video(&db, "v1").unwrap();

        let conn = Connection::open(&db).unwrap();
        let text = |sql: &str| -> String { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(text("SELECT summary FROM Videos WHERE video_id='v2'"), "Refers to One and [Orb](kinesis://glossary/Orb).");
        assert_eq!(text("SELECT bio FROM Biographies WHERE handle='@b'"), "Friend of One.");
        assert_eq!(text("SELECT definition FROM Glossary WHERE term='Halving'"), "Cuts One rewards");
        drop(conn);

        delete_glossary_term(&db, "Orb").unwrap();
        let conn = Connection::open(&db).unwrap();
        assert_eq!(
            conn.query_row::<String, _, _>("SELECT summary FROM Videos WHERE video_id='v2'", [], |r| r.get(0)).unwrap(),
            "Refers to One and Orb."
        );
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn deleting_the_last_video_of_a_channel_also_unlinks_its_biography() {
        let db = temp_db("biolink");
        save_video(&db, "v1", "One", "A", 60, "words", 1, "2026-01-01T00:00:00Z", "@ann", None).unwrap();
        save_video(&db, "v2", "Two", "B", 60, "see [Ann](kinesis://bio/ann) here", 1, "2026-01-01T00:00:00Z", "@bob", None).unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO Biographies (handle, display_name, bio) VALUES ('@ann', 'Ann', 'bio')", []).unwrap();
        drop(conn);
        delete_video(&db, "v1").unwrap();
        let conn = Connection::open(&db).unwrap();
        let transcript: String = conn.query_row("SELECT transcript FROM Videos WHERE video_id='v2'", [], |r| r.get(0)).unwrap();
        assert_eq!(transcript, "see Ann here", "the biography went with its last video, so links to it are dropped");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_biography_is_found_with_or_without_the_at_sign() {
        let db = temp_db("biolookup");
        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO Biographies (handle, display_name, bio) VALUES ('@2KrazyKetos', 'Krazy', 'bio')", []).unwrap();
        drop(conn);
        for handle in ["@2KrazyKetos", "2KrazyKetos", "2krazyketos", " @2KRAZYKETOS "] {
            assert!(crate::db::get_biography_by_handle(&db, handle).unwrap().is_some(), "{handle:?}");
        }
        assert!(crate::db::get_biography_by_handle(&db, "nobody").unwrap().is_none());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn renaming_a_term_moves_the_links_to_the_new_name() {
        let db = temp_db("rename");
        save_glossary_term(&db, None, "Halving", "Cuts rewards", &[]).unwrap();
        save_glossary_term(&db, None, "Other", "See [Halving](kinesis://glossary/Halving)", &[]).unwrap();
        save_glossary_term(&db, Some("Halving"), "Bitcoin Halving", "Cuts rewards", &[]).unwrap();
        let conn = Connection::open(&db).unwrap();
        let def: String = conn.query_row("SELECT definition FROM Glossary WHERE term='Other'", [], |r| r.get(0)).unwrap();
        assert_eq!(def, "See [Halving](kinesis://glossary/Bitcoin%20Halving)");
        let _ = std::fs::remove_file(&db);
    }
}
