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
///
/// `channel_id`/`subscriber_count` are only ever written on the INSERT branch (first time this
/// handle is seen) — the ON CONFLICT branch intentionally omits them from its SET list, so they
/// are never touched again on a later save. channel_id is YouTube's immutable channel ID, which
/// must be captured at the outset since (unlike handle) it can't be recovered later once missed;
/// subscriber_count is meant to be kept in sync by a separate backend routine going forward, not
/// by Kinesis's own video-save flow. See commands::youtube::library::ensure_biography_seeded for
/// the caller that resolves these before calling in.
pub fn upsert_biography_from_video(
    db_path: &str,
    handle: &str,
    display_name: &str,
    channel_id: Option<&str>,
    subscriber_count: i64,
) -> Result<()> {
    let conn = Connection::open(db_path)?;
    let cleaned_handle = handle.trim();
    if cleaned_handle.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO Biographies (handle, display_name, channel_id, subscriber_count)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(handle) DO UPDATE SET
           display_name = CASE
             WHEN Biographies.display_name IS NULL OR TRIM(Biographies.display_name) = ''
             THEN excluded.display_name
             ELSE Biographies.display_name
           END",
        params![cleaned_handle, display_name.trim(), channel_id.unwrap_or("").trim(), subscriber_count],
    )?;
    Ok(())
}

/// Returns all biography rows, sorted by display_name (falling back to handle when display_name
/// is blank), case-insensitively.
pub fn get_biographies(db_path: &str) -> Result<Vec<BiographyRow>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT handle, display_name, bio, wikipedia, website, twitter, instagram, facebook, threads, youtube, tiktok, twitch, reddit, discord
         FROM Biographies
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
         FROM Biographies
         WHERE LOWER(LTRIM(handle, '@')) = LOWER(?)",
    )?;
    // The leading "@" is optional on either side: "@Name", "Name" and "name" all find the same
    // biography (links to a biography, see db/links.rs, carry the handle without it).
    let mut rows = stmt.query(params![handle.trim().trim_start_matches('@')])?;
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
        "UPDATE Biographies
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
