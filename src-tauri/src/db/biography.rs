use rusqlite::{params, Connection, Result};

pub type BiographyRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
);

pub fn upsert_biography_from_video(db_path: &str, handle: &str, display_name: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    let cleaned_handle = handle.trim();
    if cleaned_handle.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO biographies (handle, display_name)
         VALUES (?1, ?2)
         ON CONFLICT(handle) DO UPDATE SET
           display_name = CASE
             WHEN biographies.display_name IS NULL OR TRIM(biographies.display_name) = ''
             THEN excluded.display_name
             ELSE biographies.display_name
           END",
        params![cleaned_handle, display_name.trim()],
    )?;
    Ok(())
}

pub fn get_biographies(db_path: &str) -> Result<Vec<BiographyRow>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT handle, display_name, bio, wikipedia, website, twitter, instagram, facebook, threads, youtube, tiktok, twitch, reddit, discord
         FROM biographies
         ORDER BY
           CASE WHEN TRIM(display_name) = '' THEN handle ELSE display_name END COLLATE NOCASE",
    )?;
    let mut rows = stmt.query([])?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        entries.push((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
            row.get(10)?,
            row.get(11)?,
            row.get(12)?,
            row.get(13)?,
        ));
    }
    Ok(entries)
}

pub fn get_biography_by_handle(db_path: &str, handle: &str) -> Result<Option<BiographyRow>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT handle, display_name, bio, wikipedia, website, twitter, instagram, facebook, threads, youtube, tiktok, twitch, reddit, discord
         FROM biographies
         WHERE LOWER(handle) = LOWER(?)",
    )?;
    let mut rows = stmt.query(params![handle.trim()])?;
    if let Some(row) = rows.next()? {
        Ok(Some((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
            row.get(10)?,
            row.get(11)?,
            row.get(12)?,
            row.get(13)?,
        )))
    } else {
        Ok(None)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn update_biography_details(
    db_path: &str,
    handle: &str,
    bio: &str,
    wikipedia: &str,
    website: &str,
    twitter: &str,
    instagram: &str,
    facebook: &str,
    threads: &str,
    youtube: &str,
    tiktok: &str,
    twitch: &str,
    reddit: &str,
    discord: &str,
) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE biographies
         SET bio = ?2,
             wikipedia = ?3,
             website = ?4,
             twitter = ?5,
             instagram = ?6,
             facebook = ?7,
             threads = ?8,
             youtube = ?9,
             tiktok = ?10,
             twitch = ?11,
             reddit = ?12,
             discord = ?13
         WHERE LOWER(handle) = LOWER(?1)",
        params![
            handle.trim(),
            bio,
            wikipedia,
            website,
            twitter,
            instagram,
            facebook,
            threads,
            youtube,
            tiktok,
            twitch,
            reddit,
            discord
        ],
    )?;
    Ok(())
}

/// Populate biographies table from existing video handles.
/// For each distinct handle in the videos table:
/// - If no biography entry exists, create one with the author as display_name
/// - If biography entry exists but display_name is empty, update it with author
pub fn populate_biographies_from_videos(db_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;

    // Get distinct handles with their corresponding author (use MIN for deterministic choice)
    let mut stmt = conn.prepare(
        "SELECT handle, MIN(author) as author
         FROM videos
         WHERE handle IS NOT NULL AND handle != ''
         GROUP BY handle"
    )?;
    let rows: Vec<(String, Option<String>)> = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
        ))
    })?.filter_map(|r| r.ok()).collect();

    // One transaction for the whole batch instead of an autocommit round trip per handle.
    let tx = conn.unchecked_transaction()?;
    let mut count = 0;
    for (handle, author_opt) in rows {
        let display_name = author_opt.unwrap_or_else(|| "".to_string());

        // Use upsert that preserves existing non-empty display_name
        tx.execute(
            "INSERT INTO biographies (handle, display_name)
             VALUES (?1, ?2)
             ON CONFLICT(handle) DO UPDATE SET
               display_name = CASE
                 WHEN TRIM(biographies.display_name) = ''
                 THEN excluded.display_name
                 ELSE biographies.display_name
               END",
            params![handle, display_name],
        )?;
        count += 1;
    }
    tx.commit()?;

    log::info!("Populated {} biography entries from existing videos", count);
    Ok(())
}
