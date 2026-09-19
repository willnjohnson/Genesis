use rusqlite::{params, Connection, Result};

/// The value the sync server enforces for `key`, if any. Reads `sync_policy` (db/sync.rs) and
/// treats a missing table (a connection opened before `init_db` ran) the same as no policy.
pub(crate) fn policy_value(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM sync_policy WHERE key = ?",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// Every key the sync server currently locks against local edits.
pub(crate) fn locked_keys(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare("SELECT key FROM sync_policy WHERE locked = 1 ORDER BY key") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

fn is_locked(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM sync_policy WHERE key = ? AND locked = 1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn locked_error(key: &str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!("'{key}' is managed by your sync server and can't be changed here"),
    )))
}

pub fn get_setting(db_path: &str, key: &str) -> Result<Option<String>> {
    let conn = Connection::open(db_path)?;
    if let Some(enforced) = policy_value(&conn, key) {
        return Ok(Some(enforced));
    }
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
    if let Some(enforced) = is_locked(&conn, key) {
        // A write of the enforced value itself is a harmless no-op. Callers such as
        // set_display_settings re-save every field they read back (which already carries the
        // enforced value), so rejecting those would break unrelated edits.
        return if enforced == value { Ok(()) } else { Err(locked_error(key)) };
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value)
         VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete_setting(db_path: &str, key: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    if is_locked(&conn, key).is_some() {
        return Err(locked_error(key));
    }
    conn.execute("DELETE FROM settings WHERE key = ?", params![key])?;
    Ok(())
}

/// Reads a yes/no flag the way a person editing the settings table by hand would write it:
/// true/1/yes/on and false/0/no/off (any case, surrounding spaces ignored). Anything else, or a
/// missing value, means `default`, so a typo never flips a flag to a surprising state.
pub fn parse_flag(value: Option<&str>, default: bool) -> bool {
    match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("true") | Some("1") | Some("yes") | Some("on") => true,
        Some("false") | Some("0") | Some("no") | Some("off") => false,
        _ => default,
    }
}

pub fn get_flag(db_path: &str, key: &str, default: bool) -> bool {
    parse_flag(get_setting(db_path, key).ok().flatten().as_deref(), default)
}

/// Several settings in one call (one connection), with the sync policy applied, for the UI's
/// feature flags. A key with no value comes back as `None`.
pub fn get_settings(db_path: &str, keys: &[String]) -> Result<std::collections::HashMap<String, Option<String>>> {
    let conn = Connection::open(db_path)?;
    let mut out = std::collections::HashMap::with_capacity(keys.len());
    for key in keys {
        let value = match policy_value(&conn, key) {
            Some(enforced) => Some(enforced),
            None => conn
                .query_row("SELECT value FROM settings WHERE key = ?", params![key], |r| r.get::<_, Option<String>>(0))
                .ok()
                .flatten(),
        };
        out.insert(key.clone(), value);
    }
    Ok(out)
}

/// Locked settings for the frontend, so it can disable the matching controls.
pub fn get_locked_settings(db_path: &str) -> Result<Vec<String>> {
    let conn = Connection::open(db_path)?;
    Ok(locked_keys(&conn))
}

// Reads a boolean setting via an already-open connection, for callers (save_summary, save_video)
// that don't otherwise need a second SQLite connection just to check a flag. Missing/anything
// other than the literal "true" reads as false, so new boolean settings default to off without
// needing a seed row.
pub(crate) fn get_setting_bool(conn: &Connection, key: &str) -> bool {
    if let Some(enforced) = policy_value(conn, key) {
        return enforced == "true";
    }
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .map(|v| v == "true")
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_settings_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn lock(db: &str, key: &str, value: &str) {
        Connection::open(db)
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO sync_policy (key, value, locked) VALUES (?, ?, 1)",
                params![key, value],
            )
            .unwrap();
    }

    #[test]
    fn policy_overrides_local_value_without_touching_it() {
        let db = temp_db("override");
        set_setting(&db, "showBiography", "true").unwrap();
        lock(&db, "showBiography", "false");
        assert_eq!(get_setting(&db, "showBiography").unwrap().as_deref(), Some("false"));
        let conn = Connection::open(&db).unwrap();
        assert!(!get_setting_bool(&conn, "showBiography"));
        let local: String = conn
            .query_row("SELECT value FROM settings WHERE key='showBiography'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(local, "true", "the user's own value must survive underneath the policy");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn flags_accept_the_ways_a_person_would_type_them_and_fall_back_on_junk() {
        for yes in ["true", "TRUE", " True ", "1", "yes", "On"] {
            assert!(parse_flag(Some(yes), false), "{yes:?}");
        }
        for no in ["false", "False", "0", "no", " OFF "] {
            assert!(!parse_flag(Some(no), true), "{no:?}");
        }
        // A typo or empty value is neither: the flag's own default applies, in both directions.
        for junk in ["", "banana", "2", "fasle"] {
            assert!(parse_flag(Some(junk), true), "{junk:?} should keep a true default");
            assert!(!parse_flag(Some(junk), false), "{junk:?} should keep a false default");
        }
        assert!(parse_flag(None, true) && !parse_flag(None, false));
    }

    #[test]
    fn get_settings_reads_many_keys_and_applies_the_policy() {
        let db = temp_db("many");
        set_setting(&db, "showBiography", "true").unwrap();
        set_setting(&db, "showDrive", "false").unwrap();
        lock(&db, "showBiography", "false");
        let keys: Vec<String> = ["showBiography", "showDrive", "nope"].iter().map(|k| k.to_string()).collect();
        let got = get_settings(&db, &keys).unwrap();
        assert_eq!(got["showBiography"].as_deref(), Some("false"), "enforced value wins");
        assert_eq!(got["showDrive"].as_deref(), Some("false"));
        assert_eq!(got["nope"], None);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn locked_keys_reject_changes_but_allow_the_enforced_value() {
        let db = temp_db("locked");
        lock(&db, "showDrive", "false");
        let err = set_setting(&db, "showDrive", "true").unwrap_err().to_string();
        assert!(err.contains("managed by your sync server"), "{err}");
        assert!(set_setting(&db, "showDrive", "false").is_ok());
        assert!(delete_setting(&db, "showDrive").is_err());
        assert_eq!(get_locked_settings(&db).unwrap(), vec!["showDrive".to_string()]);
        // Unrelated keys stay editable.
        assert!(set_setting(&db, "showSearch", "false").is_ok());
        let _ = std::fs::remove_file(&db);
    }
}
