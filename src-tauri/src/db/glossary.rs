use rusqlite::{params, Connection, Result};

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

/// Validates, de-duplicates and sorts a list of roots. Errors on anything that isn't a root, so a
/// deeper level can never be stored.
fn normalize_roots(roots: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for r in roots {
        if !is_root_path(r) {
            return Err(invalid(format!("'{r}' is not a Drive root; terms can only be assigned to top-level drives")));
        }
        if !out.contains(r) {
            out.push(r.clone());
        }
    }
    out.sort_by_key(|r| r.to_lowercase());
    Ok(out)
}

pub fn add_glossary_term(db_path: &str, term: &str, definition: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT INTO Glossary (term, definition) VALUES (?1, ?2) ON CONFLICT(term) DO UPDATE SET definition=excluded.definition",
        params![term, definition],
    )?;
    Ok(())
}

pub fn get_glossary_terms(db_path: &str) -> Result<Vec<(String, String)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt =
        conn.prepare("SELECT term, definition FROM Glossary ORDER BY term COLLATE NOCASE")?;
    let mut rows = stmt.query([])?;
    let mut terms = Vec::new();
    while let Some(row) = rows.next()? {
        terms.push((row.get(0)?, row.get(1)?));
    }
    Ok(terms)
}

pub fn delete_glossary_term(db_path: &str, term: &str) -> Result<()> {
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM Glossary WHERE term = ?", params![term])?;
    tx.execute("DELETE FROM GlossaryDrives WHERE term = ?", params![term])?;
    tx.commit()?;
    // Links to a term that no longer exists are dropped, leaving their text.
    if let Err(e) = super::links::apply_link_edits(db_path, &[super::links::LinkEdit::Unlink(super::links::LinkKind::Glossary, term.to_string())]) {
        log::warn!("Couldn't remove links to deleted term {term}: {e}");
    }
    Ok(())
}

/// Every (term, root) assignment, for terms that still exist.
pub fn get_glossary_drive_links(db_path: &str) -> Result<Vec<(String, String)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT d.term, d.root FROM GlossaryDrives d
         JOIN Glossary g ON g.term = d.term
         ORDER BY d.root COLLATE NOCASE, d.term COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Replaces the roots `term` is filed under. Only Standard Glossary Tags (non-empty definition) can
/// be filed, so a Quick Tag, or a term that doesn't exist, ends up with none. Callers pass roots
/// already validated with `normalize_roots`.
pub(crate) fn set_glossary_drives(conn: &Connection, term: &str, roots: &[String]) -> Result<()> {
    conn.execute("DELETE FROM GlossaryDrives WHERE term = ?", params![term])?;
    let definition: Option<String> = conn
        .query_row("SELECT definition FROM Glossary WHERE term = ?", params![term], |r| r.get(0))
        .ok();
    if definition.map(|d| d.trim().is_empty()).unwrap_or(true) {
        return Ok(());
    }
    for root in roots {
        conn.execute("INSERT OR IGNORE INTO GlossaryDrives (term, root) VALUES (?1, ?2)", params![term, root])?;
    }
    Ok(())
}

/// Adds or edits a term together with its drive assignments, atomically. `original_term` is the
/// term's current name when editing: a different `term` renames it, carrying nothing over but the
/// roots given here (the old name's rows are removed).
pub fn save_glossary_term(
    db_path: &str,
    original_term: Option<&str>,
    term: &str,
    definition: &str,
    drives: &[String],
) -> Result<()> {
    let term = term.trim();
    if term.is_empty() {
        return Err(invalid("A term needs a name."));
    }
    let roots = normalize_roots(drives)?;
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    if let Some(original) = original_term.filter(|o| *o != term) {
        tx.execute("DELETE FROM Glossary WHERE term = ?", params![original])?;
        tx.execute("DELETE FROM GlossaryDrives WHERE term = ?", params![original])?;
    }
    tx.execute(
        "INSERT INTO Glossary (term, definition) VALUES (?1, ?2) ON CONFLICT(term) DO UPDATE SET definition=excluded.definition",
        params![term, definition],
    )?;
    set_glossary_drives(&tx, term, &roots)?;
    tx.commit()?;
    // A renamed term keeps the links that pointed at it.
    if let Some(original) = original_term.filter(|o| *o != term) {
        use super::links::{apply_link_edits, LinkEdit, LinkKind};
        if let Err(e) = apply_link_edits(db_path, &[LinkEdit::Retarget(LinkKind::Glossary, original.to_string(), term.to_string())]) {
            log::warn!("Couldn't move links from renamed term {original}: {e}");
        }
    }
    Ok(())
}

/// Validates roots coming from outside (sync, packs) the same way the UI path does.
pub(crate) fn validated_roots(roots: &[String]) -> Result<Vec<String>> {
    normalize_roots(roots)
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

    fn roots(db: &str, term: &str) -> Vec<String> {
        get_glossary_drive_links(db).unwrap().into_iter().filter(|(t, _)| t == term).map(|(_, r)| r).collect()
    }

    #[test]
    fn only_top_level_roots_are_accepted() {
        assert!(is_root_path(":CRYPTO"));
        assert!(is_root_path(":Fin Tech"));
        for bad in [":", "", "CRYPTO", ":CRYPTO-DOAC", ":CRYPTO-DOAC-VVV", ":A:B", ":A_B", ": ", ":X\n", "θψCRYPTO"] {
            assert!(!is_root_path(bad), "{bad:?} must not be a root");
        }
        let db = temp_db("roots");
        let err = save_glossary_term(&db, None, "T", "def", &[":CRYPTO-DOAC".to_string()]).unwrap_err().to_string();
        assert!(err.contains("top-level"), "{err}");
        assert!(get_glossary_terms(&db).unwrap().is_empty(), "a rejected save must not leave a half-saved term");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_standard_tag_can_belong_to_several_drives_and_they_replace_cleanly() {
        let db = temp_db("multi");
        save_glossary_term(&db, None, "Halving", "Supply cut", &[":FIN".into(), ":CRYPTO".into(), ":FIN".into()]).unwrap();
        assert_eq!(roots(&db, "Halving"), vec![":CRYPTO", ":FIN"], "sorted and de-duplicated");
        save_glossary_term(&db, Some("Halving"), "Halving", "Supply cut", &[":CRYPTO".into()]).unwrap();
        assert_eq!(roots(&db, "Halving"), vec![":CRYPTO"]);
        save_glossary_term(&db, Some("Halving"), "Halving", "Supply cut", &[]).unwrap();
        assert!(roots(&db, "Halving").is_empty(), "an empty selection uncategorizes the term");
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
        // A root with no videos yet, and one that exists only because a term is filed under it.
        crate::db::ensure_wdbs_path_exists(&db, ":EMPTY").unwrap();
        save_glossary_term(&db, None, "Halving", "d", &[":ONLYTERM".into()]).unwrap();

        let roots = crate::db::get_wdbs_roots(&db).unwrap();
        let names: Vec<&str> = roots.iter().map(|r| r.segment.as_str()).collect();
        assert_eq!(names, vec!["CRYPTO", "EMPTY", "FIN", "ONLYTERM"], "no DOAC/VVV, sorted");
        assert!(roots.iter().all(|r| is_root_path(&r.path)));
        assert_eq!(roots[0].path, ":CRYPTO");
        assert_eq!(roots[0].alias.as_deref(), Some("Crypto Assets"));
        assert_eq!(roots[2].alias, None, "an uncurated alias isn't reported");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn quick_tags_never_get_drives() {
        let db = temp_db("quick");
        save_glossary_term(&db, None, "qt", "", &[":CRYPTO".into()]).unwrap();
        assert!(roots(&db, "qt").is_empty());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn renaming_moves_the_assignments_and_deleting_removes_them() {
        let db = temp_db("rename");
        save_glossary_term(&db, None, "Old", "d", &[":CRYPTO".into()]).unwrap();
        save_glossary_term(&db, Some("Old"), "New", "d", &[":CRYPTO".into(), ":FIN".into()]).unwrap();
        assert!(roots(&db, "Old").is_empty());
        assert_eq!(roots(&db, "New"), vec![":CRYPTO", ":FIN"]);
        assert_eq!(get_glossary_terms(&db).unwrap().len(), 1, "the old name is gone");

        delete_glossary_term(&db, "New").unwrap();
        assert!(get_glossary_drive_links(&db).unwrap().is_empty());
        let conn = Connection::open(&db).unwrap();
        let orphans: i64 = conn.query_row("SELECT COUNT(*) FROM GlossaryDrives", [], |r| r.get(0)).unwrap();
        assert_eq!(orphans, 0, "no orphan rows left behind");
        let _ = std::fs::remove_file(&db);
    }
}
