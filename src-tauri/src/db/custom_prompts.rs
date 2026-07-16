use rusqlite::{params, Connection, Result};

pub fn get_custom_prompt(
    db_path: &str,
    handle: &str,
) -> Result<Option<(Option<String>, Option<String>)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT local_prompt_text, cloud_prompt_text FROM custom_prompts WHERE LOWER(handle) = LOWER(?)",
    )?;
    let mut rows = stmt.query(params![handle])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?)))
    } else {
        Ok(None)
    }
}

pub fn get_all_custom_prompts(
    db_path: &str,
) -> Result<Vec<(String, Option<String>, Option<String>)>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT handle, local_prompt_text, cloud_prompt_text FROM custom_prompts ORDER BY handle COLLATE NOCASE")?;
    let mut rows = stmt.query([])?;
    let mut prompts = Vec::new();
    while let Some(row) = rows.next()? {
        prompts.push((row.get(0)?, row.get(1)?, row.get(2)?));
    }
    Ok(prompts)
}

pub fn set_custom_prompt(
    db_path: &str,
    handle: &str,
    local_prompt_text: Option<&str>,
    cloud_prompt_text: Option<&str>,
) -> Result<()> {
    let conn = Connection::open(db_path)?;
    let normalized_handle = handle.to_lowercase();

    // Check if exists (case-insensitive)
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM custom_prompts WHERE LOWER(handle) = LOWER(?)",
        params![normalized_handle],
        |row| Ok(row.get::<_, i32>(0)? > 0),
    )?;

    if exists {
        conn.execute(
            "UPDATE custom_prompts SET local_prompt_text = ?2, cloud_prompt_text = ?3 WHERE LOWER(handle) = LOWER(?1)",
            params![normalized_handle, local_prompt_text, cloud_prompt_text],
        )?;
    } else {
        conn.execute(
            "INSERT INTO custom_prompts (handle, local_prompt_text, cloud_prompt_text) VALUES (?1, ?2, ?3)",
            params![normalized_handle, local_prompt_text, cloud_prompt_text],
        )?;
    }
    Ok(())
}

pub fn delete_custom_prompt(db_path: &str, handle: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "DELETE FROM custom_prompts WHERE LOWER(handle) = LOWER(?)",
        params![handle],
    )?;
    Ok(())
}
