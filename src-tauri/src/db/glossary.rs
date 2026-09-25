use rusqlite::{params, Connection, Result};
use serde::Serialize;

fn invalid(msg: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::InvalidInput, msg.into())))
}

/// A Drive *root*: ":" followed by exactly one level (":CRYPTO"). Deeper paths (":CRYPTO-DOAC") and
/// the bare ":" placeholder are not roots. Glossary terms can only be filed at this level.
pub fn is_root_path(path: &str) -> bool {
    let Some(segment) = path.strip_prefix(':') else { return false };
    !segment.is_empty()
        && segment.chars().count() <= 128
        && !segment.contains(['-', ':', '_'])
        && !segment.chars().any(|c| c.is_control())
        && segment.trim() == segment
}

/// One Glossary row: one definition of a term and every Drive it's filed under. `drives` is empty
/// for an uncategorized definition (stored as ''). The same term can carry a different definition in
/// each Drive, but a Drive belongs to at most one of a term's definitions.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GlossaryEntry {
    pub term: String,
    pub definition: String,
    pub drives: Vec<String>,
}

/// Sorted (case-insensitively) and de-duplicated, empties dropped: the one order a Drive list is
/// ever stored in, since the list is part of the row's key ("a\nb" and "b\na" must be the same row).
pub(crate) fn sorted_unique(mut drives: Vec<String>) -> Vec<String> {
    drives.retain(|d| !d.is_empty());
    drives.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
    drives.dedup();
    drives
}

/// `Glossary.drives`' on-disk encoding: the roots newline-joined, '' meaning uncategorized. A root
/// can't contain a newline (or any control character — see `is_root_path`), so '\n' is an
/// unambiguous separator.
pub(crate) fn encode_drives(drives: &[String]) -> String {
    sorted_unique(drives.to_vec()).join("\n")
}

pub(crate) fn decode_drives(raw: &str) -> Vec<String> {
    sorted_unique(raw.split('\n').map(str::to_string).collect())
}

/// Drives coming from the UI or from outside (sync, packs): each must be a root. Errors on anything
/// else, so a deeper level can never be stored. Returns them sorted and de-duplicated.
pub(crate) fn validated_drives(drives: &[String]) -> Result<Vec<String>> {
    for d in drives.iter().filter(|d| !d.is_empty()) {
        if !is_root_path(d) {
            return Err(invalid(format!("'{d}' is not a Drive root; terms can only be assigned to top-level drives")));
        }
    }
    Ok(sorted_unique(drives.to_vec()))
}

/// Adds or updates a term in the uncategorized ('' drives) slot. Keyed by (term, drives), so a
/// same-named term filed under Drives is a separate row and is left alone.
pub fn add_glossary_term(db_path: &str, term: &str, definition: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT INTO Glossary (term, definition, drives) VALUES (?1, ?2, '') ON CONFLICT(term, drives) DO UPDATE SET definition = excluded.definition",
        params![term, definition],
    )?;
    Ok(())
}

pub fn get_glossary_terms(db_path: &str) -> Result<Vec<GlossaryEntry>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT term, definition, drives FROM Glossary ORDER BY term COLLATE NOCASE, term, drives COLLATE NOCASE",
    )?;
    let mut rows = stmt.query([])?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        let raw: String = row.get(2)?;
        entries.push(GlossaryEntry { term: row.get(0)?, definition: row.get(1)?, drives: decode_drives(&raw) });
    }
    Ok(entries)
}

/// Deletes one entry: the row of `term` filed under exactly `drives` (empty = the uncategorized
/// row). Links to the term are only dropped once no row for it is left (links are by name, so
/// another definition still satisfies them).
pub fn delete_glossary_group(db_path: &str, term: &str, drives: &[String]) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM Glossary WHERE term = ?1 AND drives = ?2", params![term, encode_drives(drives)])?;
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM Glossary WHERE term = ?", params![term], |r| r.get(0))?;
    if left == 0 {
        // Links to a term that no longer exists are dropped, leaving their text.
        if let Err(e) = super::links::apply_link_edits(db_path, &[super::links::LinkEdit::Unlink(super::links::LinkKind::Glossary, term.to_string())]) {
            log::warn!("Couldn't remove links to deleted term {term}: {e}");
        }
    }
    Ok(())
}

/// Adds or edits one definition and every Drive it's filed under, atomically. `original` is the
/// entry being edited — its term and Drives — and its row is replaced. Filing under a Drive where
/// the term already has a *different* definition is refused rather than overwriting it; the same
/// text under other Drives is absorbed, so a term never has two rows with one definition. A Quick
/// Tag (empty definition) is always uncategorized, and so is an empty selection.
pub fn save_glossary_group(
    db_path: &str,
    original: Option<(&str, &[String])>,
    term: &str,
    definition: &str,
    drives: &[String],
) -> Result<()> {
    let term = term.trim();
    if term.is_empty() {
        return Err(invalid("A term needs a name."));
    }
    let mut targets = if definition.trim().is_empty() { Vec::new() } else { validated_drives(drives)? };
    let orig: Option<(String, String)> = original.map(|(t, d)| (t.to_string(), encode_drives(d)));
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;

    let others: Vec<(String, String)> = {
        let mut stmt = tx.prepare("SELECT definition, drives FROM Glossary WHERE term = ?")?;
        let rows = stmt.query_map(params![term], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<_>>()?
    };
    let mut absorbed: Vec<String> = Vec::new();
    for (other_def, other_key) in others {
        if orig.as_ref().is_some_and(|(t, k)| t == term && *k == other_key) {
            continue; // the row being edited: replaced below
        }
        let other = decode_drives(&other_key);
        if other_def == definition {
            targets.extend(other); // same text: that row's Drives join this entry
            absorbed.push(other_key);
        } else if (targets.is_empty() && other.is_empty()) || other.iter().any(|d| targets.contains(d)) {
            let place = other.iter().find(|d| targets.contains(d)).cloned().unwrap_or_else(|| "Uncategorized".to_string());
            return Err(invalid(format!("'{term}' already has a different definition in {place}.")));
        }
    }
    let targets = sorted_unique(targets);
    let key = encode_drives(&targets);

    if let Some((orig_term, orig_key)) = &orig {
        tx.execute("DELETE FROM Glossary WHERE term = ?1 AND drives = ?2", params![orig_term, orig_key])?;
    }
    for k in &absorbed {
        tx.execute("DELETE FROM Glossary WHERE term = ?1 AND drives = ?2", params![term, k])?;
    }
    tx.execute(
        "INSERT INTO Glossary (term, definition, drives) VALUES (?1, ?2, ?3) ON CONFLICT(term, drives) DO UPDATE SET definition = excluded.definition",
        params![term, definition, key],
    )?;
    // A renamed term keeps the links that pointed at it, unless another row still holds the old name.
    let renamed_from = orig
        .as_ref()
        .map(|(t, _)| t.as_str())
        .filter(|t| *t != term)
        .filter(|t| {
            tx.query_row("SELECT COUNT(*) FROM Glossary WHERE term = ?", params![t], |r| r.get::<_, i64>(0))
                .map(|n| n == 0)
                .unwrap_or(false)
        })
        .map(str::to_string);
    tx.commit()?;
    if let Some(original) = renamed_from {
        use super::links::{apply_link_edits, LinkEdit, LinkKind};
        if let Err(e) = apply_link_edits(db_path, &[LinkEdit::Retarget(LinkKind::Glossary, original.clone(), term.to_string())]) {
            log::warn!("Couldn't move links from renamed term {original}: {e}");
        }
    }
    Ok(())
}

/// Single-Drive conveniences for tests ("" = uncategorized), so they don't spell out slices.
#[cfg(test)]
fn one(drive: &str) -> Vec<String> {
    if drive.is_empty() { Vec::new() } else { vec![drive.to_string()] }
}

#[cfg(test)]
pub fn save_glossary_term(db_path: &str, original: Option<(&str, &str)>, term: &str, definition: &str, drive: &str) -> Result<()> {
    let orig = original.map(|(t, d)| (t, one(d)));
    save_glossary_group(db_path, orig.as_ref().map(|(t, d)| (*t, d.as_slice())), term, definition, &one(drive))
}

#[cfg(test)]
pub fn delete_glossary_term(db_path: &str, term: &str, drive: &str) -> Result<()> {
    delete_glossary_group(db_path, term, &one(drive))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_glossary_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    /// The stored `drives` value of each of `term`'s rows.
    fn rows_of(db: &str, term: &str) -> Vec<String> {
        let conn = Connection::open(db).unwrap();
        let mut stmt = conn.prepare("SELECT drives FROM Glossary WHERE term = ? ORDER BY drives").unwrap();
        stmt.query_map([term], |r| r.get::<_, String>(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_top_level_roots_are_accepted() {
        assert!(is_root_path(":CRYPTO"));
        assert!(is_root_path(":Fin Tech"));
        for bad in [":", "", "CRYPTO", ":CRYPTO-DOAC", ":CRYPTO-DOAC-VVV", ":A:B", ":A_B", ": ", ":X\n", "θψCRYPTO"] {
            assert!(!is_root_path(bad), "{bad:?} must not be a root");
        }
        let db = temp_db("roots");
        let err = save_glossary_group(&db, None, "T", "def", &v(&[":CRYPTO-DOAC"])).unwrap_err().to_string();
        assert!(err.contains("top-level"), "{err}");
        assert!(get_glossary_terms(&db).unwrap().is_empty(), "a rejected save must not leave a half-saved term");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn one_definition_is_one_row_holding_all_its_drives() {
        let db = temp_db("multi");
        save_glossary_group(&db, None, "Magnesium", "Health.", &v(&[":THYROID", ":HEALTH", ":SLEEP", ":HEALTH"])).unwrap();
        assert_eq!(rows_of(&db, "Magnesium"), vec![":HEALTH\n:SLEEP\n:THYROID"], "one row, sorted and de-duplicated");
        assert_eq!(get_glossary_terms(&db).unwrap()[0].drives, v(&[":HEALTH", ":SLEEP", ":THYROID"]));

        // Dropping a Drive from the selection rewrites the same row.
        let health = v(&[":HEALTH", ":SLEEP", ":THYROID"]);
        save_glossary_group(&db, Some(("Magnesium", &health)), "Magnesium", "Health.", &v(&[":HEALTH", ":SLEEP"])).unwrap();
        assert_eq!(rows_of(&db, "Magnesium"), vec![":HEALTH\n:SLEEP"]);
        // Editing the text keeps the Drives; an empty selection uncategorizes it.
        let health = v(&[":HEALTH", ":SLEEP"]);
        save_glossary_group(&db, Some(("Magnesium", &health)), "Magnesium", "Health, revised.", &health).unwrap();
        assert_eq!(get_glossary_terms(&db).unwrap()[0].definition, "Health, revised.");
        save_glossary_group(&db, Some(("Magnesium", &health)), "Magnesium", "Health, revised.", &[]).unwrap();
        assert_eq!(rows_of(&db, "Magnesium"), vec![""]);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn the_same_term_can_have_a_different_definition_per_set_of_drives() {
        let db = temp_db("perdrive");
        save_glossary_group(&db, None, "Magnesium", "Health.", &v(&[":HEALTH", ":SLEEP"])).unwrap();
        save_glossary_group(&db, None, "Magnesium", "An element.", &v(&[":CHEM"])).unwrap();
        assert_eq!(rows_of(&db, "Magnesium"), vec![":CHEM", ":HEALTH\n:SLEEP"]);

        // Editing the health entry leaves the chemistry one alone.
        let health = v(&[":HEALTH", ":SLEEP"]);
        save_glossary_group(&db, Some(("Magnesium", &health)), "Magnesium", "Minerals.", &health).unwrap();
        let entries = get_glossary_terms(&db).unwrap();
        assert_eq!(entries.iter().find(|e| e.drives == v(&[":CHEM"])).unwrap().definition, "An element.");
        assert_eq!(entries.iter().find(|e| e.drives.len() == 2).unwrap().definition, "Minerals.");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_drive_can_only_belong_to_one_definition_of_a_term() {
        let db = temp_db("clobber");
        save_glossary_group(&db, None, "Magnesium", "Health.", &v(&[":HEALTH"])).unwrap();
        save_glossary_group(&db, None, "Magnesium", "An element.", &v(&[":CHEM"])).unwrap();
        let health = v(&[":HEALTH"]);
        let err = save_glossary_group(&db, Some(("Magnesium", &health)), "Magnesium", "Health.", &v(&[":HEALTH", ":CHEM"])).unwrap_err().to_string();
        assert!(err.contains("already has a different definition in :CHEM"), "{err}");
        assert_eq!(rows_of(&db, "Magnesium"), vec![":CHEM", ":HEALTH"], "a refused save changes nothing");
        // Adding a fresh entry over a taken Drive is refused too.
        assert!(save_glossary_group(&db, None, "Magnesium", "Other.", &v(&[":CHEM"])).is_err());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn the_same_text_under_other_drives_is_absorbed_into_one_row() {
        let db = temp_db("absorb");
        save_glossary_group(&db, None, "Magnesium", "Health.", &v(&[":HEALTH"])).unwrap();
        save_glossary_group(&db, None, "Magnesium", "Health.", &v(&[":SLEEP"])).unwrap();
        assert_eq!(rows_of(&db, "Magnesium"), vec![":HEALTH\n:SLEEP"], "no two rows with one definition");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn the_dropdown_lists_only_top_level_drives_including_empty_ones() {
        let db = temp_db("rootlist");
        crate::db::save_video(&db, "v1", "T", "A", 1, "x", 1, "2026-01-01T00:00:00Z", "@a", None).unwrap();
        crate::db::save_video(&db, "v2", "T2", "A", 1, "x", 1, "2026-01-01T00:00:00Z", "@a", None).unwrap();
        crate::db::update_video_wdbs(&db, "v1", "θψCRYPTO_DOAC_VVV").unwrap();
        crate::db::update_video_wdbs(&db, "v2", "θψFIN").unwrap();
        crate::db::ensure_wdbs_path_exists(&db, ":CRYPTO-DOAC-VVV").unwrap();
        crate::db::ensure_wdbs_path_exists(&db, ":FIN").unwrap();
        crate::db::set_wdbs_alias(&db, "θψCRYPTO", "Crypto Assets").unwrap();
        // A root with no videos yet, and ones that exist only because a term is filed under them.
        crate::db::ensure_wdbs_path_exists(&db, ":EMPTY").unwrap();
        save_glossary_group(&db, None, "Halving", "d", &v(&[":ONLYTERM", ":OTHERONLY"])).unwrap();

        let roots = crate::db::get_wdbs_roots(&db).unwrap();
        let names: Vec<&str> = roots.iter().map(|r| r.segment.as_str()).collect();
        assert_eq!(names, vec!["CRYPTO", "EMPTY", "FIN", "ONLYTERM", "OTHERONLY"], "no DOAC/VVV, sorted");
        assert!(roots.iter().all(|r| is_root_path(&r.path)));
        assert_eq!(roots[0].path, ":CRYPTO");
        assert_eq!(roots[0].alias.as_deref(), Some("Crypto Assets"));
        assert_eq!(roots[2].alias, None, "an uncurated alias isn't reported");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn quick_tags_are_always_uncategorized() {
        let db = temp_db("quick");
        save_glossary_group(&db, None, "qt", "", &v(&[":CRYPTO", ":FIN"])).unwrap();
        assert_eq!(rows_of(&db, "qt"), vec![""]);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn renaming_moves_the_row_and_deleting_removes_it() {
        let db = temp_db("rename");
        let both = v(&[":CRYPTO", ":FIN"]);
        save_glossary_group(&db, None, "Old", "d", &both).unwrap();
        save_glossary_group(&db, Some(("Old", &both)), "New", "d", &both).unwrap();
        assert!(rows_of(&db, "Old").is_empty());
        assert_eq!(rows_of(&db, "New"), vec![":CRYPTO\n:FIN"]);

        delete_glossary_group(&db, "New", &both).unwrap();
        assert!(get_glossary_terms(&db).unwrap().is_empty());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn deleting_one_entry_keeps_the_others_and_the_links_to_the_term() {
        let db = temp_db("keeplinks");
        save_glossary_group(&db, None, "Magnesium", "Health.", &v(&[":HEALTH", ":SLEEP"])).unwrap();
        save_glossary_group(&db, None, "Magnesium", "An element.", &v(&[":CHEM"])).unwrap();
        save_glossary_group(&db, None, "Other", "See [Mg](kinesis://glossary/Magnesium)", &[]).unwrap();
        delete_glossary_group(&db, "Magnesium", &v(&[":HEALTH", ":SLEEP"])).unwrap();
        assert_eq!(rows_of(&db, "Magnesium"), vec![":CHEM"]);
        let other = get_glossary_terms(&db).unwrap().into_iter().find(|e| e.term == "Other").unwrap();
        assert!(other.definition.contains("kinesis://glossary/Magnesium"), "the surviving entry still satisfies the link");
        delete_glossary_group(&db, "Magnesium", &v(&[":CHEM"])).unwrap();
        let other = get_glossary_terms(&db).unwrap().into_iter().find(|e| e.term == "Other").unwrap();
        assert!(!other.definition.contains("kinesis://glossary/Magnesium"), "no rows left, so the link is dropped");
        let _ = std::fs::remove_file(&db);
    }
}
