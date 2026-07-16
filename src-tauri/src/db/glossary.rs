use rusqlite::{params, Connection, Result};

pub fn add_glossary_term(db_path: &str, term: &str, definition: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT INTO glossary (term, definition) VALUES (?1, ?2) ON CONFLICT(term) DO UPDATE SET definition=excluded.definition",
        params![term, definition],
    )?;
    Ok(())
}

pub fn get_glossary_terms(db_path: &str) -> Result<Vec<(String, String)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt =
        conn.prepare("SELECT term, definition FROM glossary ORDER BY term COLLATE NOCASE")?;
    let mut rows = stmt.query([])?;
    let mut terms = Vec::new();
    while let Some(row) = rows.next()? {
        terms.push((row.get(0)?, row.get(1)?));
    }
    Ok(terms)
}

pub fn delete_glossary_term(db_path: &str, term: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM glossary WHERE term = ?", params![term])?;
    Ok(())
}
