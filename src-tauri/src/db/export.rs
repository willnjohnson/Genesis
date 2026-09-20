use rusqlite::{Connection, Result};

/// Full biography row for the Obsidian export — unlike commands::biography's `BiographyEntry`
/// (which deliberately strips `channel_id`/`subscriber_count`, see its own docs), the export note
/// wants `subscriber_count` when it's known. Queried directly here rather than widening the
/// existing command-facing type.
pub struct BiographyExportRow {
    pub handle: String,
    pub display_name: String,
    pub bio: String,
    pub wikipedia: String,
    pub website: String,
    pub twitter: String,
    pub instagram: String,
    pub facebook: String,
    pub threads: String,
    pub youtube: String,
    pub tiktok: String,
    pub twitch: String,
    pub reddit: String,
    pub discord: String,
    // -1 sentinel = unknown/not yet backfilled (see schema.rs), same convention as the column.
    pub subscriber_count: i64,
}

pub fn get_all_biographies_for_export(db_path: &str) -> Result<Vec<BiographyExportRow>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT handle, display_name, bio, wikipedia, website, twitter, instagram, facebook, \
                threads, youtube, tiktok, twitch, reddit, discord, subscriber_count
         FROM Biographies
         ORDER BY CASE WHEN TRIM(display_name) = '' THEN handle ELSE display_name END COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(BiographyExportRow {
            handle: row.get(0)?,
            display_name: row.get(1)?,
            bio: row.get(2)?,
            wikipedia: row.get(3)?,
            website: row.get(4)?,
            twitter: row.get(5)?,
            instagram: row.get(6)?,
            facebook: row.get(7)?,
            threads: row.get(8)?,
            youtube: row.get(9)?,
            tiktok: row.get(10)?,
            twitch: row.get(11)?,
            reddit: row.get(12)?,
            discord: row.get(13)?,
            // The column is declared NOT NULL DEFAULT -1 in a freshly created database (see
            // schema.rs), but schema.rs only ADDs the column with that constraint when it's
            // missing entirely — a database where an older app version already added it (without
            // NOT NULL, before that constraint was introduced here) never gets retroactively
            // tightened, and can carry a real NULL. Read leniently and fall back to the same -1
            // "unknown" sentinel the column itself uses, rather than failing the whole export
            // over one legacy row.
            subscriber_count: row.get::<_, Option<i64>>(14)?.unwrap_or(-1),
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Simulates a database from before this app's schema declared subscriber_count NOT NULL —
    // schema.rs's own migration only ADDs the column when it's missing (see its
    // `column_exists` guard), so a database that already had it from an older version never gets
    // the stricter constraint retroactively, and can carry a genuine NULL to this day. A fresh
    // `db::init_db`-created database can't reproduce this (SQLite enforces NOT NULL on every
    // write against it), so this builds the legacy shape by hand.
    #[test]
    fn tolerates_null_subscriber_count() {
        let db_path = std::env::temp_dir().join(format!(
            "kinesis_export_biography_test_{}.db",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let db_path = db_path.to_string_lossy().to_string();
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE Biographies (
                handle TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                bio TEXT NOT NULL DEFAULT '',
                wikipedia TEXT NOT NULL DEFAULT '',
                website TEXT NOT NULL DEFAULT '',
                twitter TEXT NOT NULL DEFAULT '',
                instagram TEXT NOT NULL DEFAULT '',
                facebook TEXT NOT NULL DEFAULT '',
                threads TEXT NOT NULL DEFAULT '',
                youtube TEXT NOT NULL DEFAULT '',
                tiktok TEXT NOT NULL DEFAULT '',
                twitch TEXT NOT NULL DEFAULT '',
                reddit TEXT NOT NULL DEFAULT '',
                discord TEXT NOT NULL DEFAULT '',
                channel_id TEXT NOT NULL DEFAULT '',
                subscriber_count INTEGER
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO Biographies (handle, display_name, subscriber_count) VALUES ('@legacy', 'Legacy Creator', NULL)",
            [],
        )
        .unwrap();
        drop(conn);

        let rows = get_all_biographies_for_export(&db_path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subscriber_count, -1);

        std::fs::remove_file(&db_path).ok();
    }
}
