use rusqlite::{params, Connection, Result};

/// Fixed field order returned by get_biographies/get_biography_by_handle: (handle, display_name,
/// bio, wikipedia, website, twitter, instagram, facebook, threads, youtube, tiktok, twitch,
/// reddit, discord).
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

/// Ensures a biography row exists for `handle`, seeding it with `display_name`. If a row already
/// exists, `display_name` is only applied when the existing one is empty — this never overwrites
/// a display name a user has already set (e.g. via manual edit), only fills in a blank one.
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

/// Returns all biography rows, sorted by display_name (falling back to handle when display_name
/// is blank), case-insensitively.
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

/// Looks up one biography row by handle, case-insensitively.
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

/// Updates the editable bio/social fields for a handle. Does not touch `handle` or
/// `display_name` — those are only ever set via upsert_biography_from_video.
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
