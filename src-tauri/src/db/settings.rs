use rusqlite::{params, Connection, Result};

pub fn get_setting(db_path: &str, key: &str) -> Result<Option<String>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_setting(db_path: &str, key: &str, value: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value)
         VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete_setting(db_path: &str, key: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM settings WHERE key = ?", params![key])?;
    Ok(())
}

// Reads a boolean setting via an already-open connection, for callers (save_summary, save_video)
// that don't otherwise need a second SQLite connection just to check a flag. Missing/anything
// other than the literal "true" reads as false, so new boolean settings default to off without
// needing a seed row.
pub(crate) fn get_setting_bool(conn: &Connection, key: &str) -> bool {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .map(|v| v == "true")
    .unwrap_or(false)
}
