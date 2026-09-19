use rusqlite::{Connection, Result, params};

/// Add (or update the timestamp of) a query in history.
/// Deduplication: same query just updates `searched_at`.
pub fn add_history(path: &str, query: &str) -> Result<()> {
    let conn = Connection::open(path)?;
    conn.execute(
        "INSERT INTO search_history (search_query)
         VALUES (?1)
         ON CONFLICT(search_query) DO UPDATE SET searched_at = CURRENT_TIMESTAMP",
        params![query],
    )?;
    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct HistoryEntry {
    pub id: i64,
    pub search_query: String,
    #[serde(rename = "searchedAt")]
    pub searched_at: String,
}

/// Return the N most recent history entries.
pub fn get_history(path: &str, limit: i64) -> Result<Vec<HistoryEntry>> {
    let conn = Connection::open(path)?;
    let mut stmt = conn.prepare(
        "SELECT id, search_query, searched_at FROM search_history
         ORDER BY searched_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(HistoryEntry {
            id: row.get(0)?,
            search_query: row.get(1)?,
            searched_at: row.get(2)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Delete all entries on or before the given date (YYYY-MM-DD).
pub fn clear_history_before(path: &str, date: &str) -> Result<usize> {
    let conn = Connection::open(path)?;
    let n = conn.execute(
        "DELETE FROM search_history WHERE date(searched_at) <= date(?1)",
        params![date],
    )?;
    Ok(n)
}

/// Delete a single entry by id.
pub fn delete_history_entry(path: &str, id: i64) -> Result<()> {
    let conn = Connection::open(path)?;
    conn.execute("DELETE FROM search_history WHERE id = ?1", params![id])?;
    Ok(())
}

/// Clear the entire history table.
pub fn clear_all_history(path: &str) -> Result<()> {
    let conn = Connection::open(path)?;
    conn.execute_batch("DELETE FROM search_history;")?;
    Ok(())
}

/// The setting holding how long history is kept: "never" (keep everything, the default), "6m", "3m"
/// or "1m". Anything else counts as "never", so a stray value never deletes anything.
pub const CLEAR_AFTER_KEY: &str = "searchHistoryClearAfter";

pub fn clear_after_months(value: Option<&str>) -> Option<i64> {
    match value.map(|v| v.trim().to_lowercase()).as_deref() {
        Some("6m") => Some(6),
        Some("3m") => Some(3),
        Some("1m") => Some(1),
        _ => None,
    }
}

/// Deletes entries older than the "clear after" period, if one is set. Cheap enough to run before
/// every read and write of history, so the list never shows entries that should already be gone.
pub fn apply_retention(path: &str) -> Result<usize> {
    let value = crate::db::get_setting(path, CLEAR_AFTER_KEY).ok().flatten();
    let Some(months) = clear_after_months(value.as_deref()) else {
        return Ok(0);
    };
    let conn = Connection::open(path)?;
    conn.execute(
        "DELETE FROM search_history WHERE searched_at < datetime('now', ?1)",
        params![format!("-{months} months")],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_db, set_setting};

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_history_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    /// Adds a search and back-dates it by `days`.
    fn add_aged(db: &str, query: &str, days: i64) {
        add_history(db, query).unwrap();
        Connection::open(db)
            .unwrap()
            .execute(
                "UPDATE search_history SET searched_at = datetime('now', ?1) WHERE search_query = ?2",
                params![format!("-{days} days"), query],
            )
            .unwrap();
    }

    fn queries(db: &str) -> Vec<String> {
        let mut q: Vec<String> = get_history(db, 100).unwrap().into_iter().map(|e| e.search_query).collect();
        q.sort();
        q
    }

    #[test]
    fn only_the_four_choices_mean_anything() {
        assert_eq!(clear_after_months(Some("6m")), Some(6));
        assert_eq!(clear_after_months(Some("3m")), Some(3));
        assert_eq!(clear_after_months(Some(" 1M ")), Some(1));
        for v in [None, Some("never"), Some(""), Some("12m"), Some("0"), Some("junk")] {
            assert_eq!(clear_after_months(v), None, "{v:?}");
        }
    }

    #[test]
    fn keeps_everything_by_default_and_when_set_to_never() {
        let db = temp_db("never");
        add_aged(&db, "ancient", 4000);
        add_aged(&db, "fresh", 0);
        assert_eq!(apply_retention(&db).unwrap(), 0);
        set_setting(&db, CLEAR_AFTER_KEY, "never").unwrap();
        assert_eq!(apply_retention(&db).unwrap(), 0);
        assert_eq!(queries(&db), vec!["ancient", "fresh"]);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn clears_entries_older_than_the_chosen_period() {
        let db = temp_db("period");
        add_aged(&db, "two days", 2);
        add_aged(&db, "forty days", 40);
        add_aged(&db, "hundred days", 100);
        add_aged(&db, "year", 365);

        set_setting(&db, CLEAR_AFTER_KEY, "6m").unwrap();
        apply_retention(&db).unwrap();
        assert_eq!(queries(&db), vec!["forty days", "hundred days", "two days"], "6 months keeps all but the year-old one");

        set_setting(&db, CLEAR_AFTER_KEY, "3m").unwrap();
        apply_retention(&db).unwrap();
        assert_eq!(queries(&db), vec!["forty days", "two days"]);

        set_setting(&db, CLEAR_AFTER_KEY, "1m").unwrap();
        apply_retention(&db).unwrap();
        assert_eq!(queries(&db), vec!["two days"]);
        let _ = std::fs::remove_file(&db);
    }
}
