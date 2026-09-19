//! Feature flags: rows in the `settings` table a DB owner sets to shape the app for their users
//! (hide a tab, turn off editing, ...). The list and defaults live in
//! `kinesis_sync_proto::FEATURE_FLAGS`; the UI keeps a copy of the defaults in `src/lib/flags.ts`.

use kinesis_sync_proto::FEATURE_FLAGS;
use rusqlite::{params, Connection, Result};

/// Gives every flag a row with its default, without touching a value that's already there.
pub(crate) fn seed_feature_flags(conn: &Connection) -> Result<()> {
    for (key, default) in FEATURE_FLAGS {
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)", params![key, default])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use std::collections::BTreeMap;

    /// `key: default,` lines of `FLAG_DEFAULTS` in src/lib/flags.ts.
    fn ui_defaults() -> BTreeMap<String, String> {
        let src = include_str!("../../src/lib/flags.ts");
        let body = src
            .split("export const FLAG_DEFAULTS = {")
            .nth(1)
            .expect("FLAG_DEFAULTS in src/lib/flags.ts")
            .split("} as const;")
            .next()
            .unwrap();
        let mut out = BTreeMap::new();
        for line in body.lines() {
            let line = line.split("//").next().unwrap().trim();
            let Some((key, value)) = line.trim_end_matches(',').split_once(':') else { continue };
            let (key, value) = (key.trim(), value.trim().trim_matches('\''));
            if !key.is_empty() {
                out.insert(key.to_string(), value.to_string());
            }
        }
        out
    }

    #[test]
    fn the_ui_and_the_backend_agree_on_every_flag_and_default() {
        let ui = ui_defaults();
        let backend: BTreeMap<String, String> =
            FEATURE_FLAGS.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let only_ui: Vec<_> = ui.keys().filter(|k| !backend.contains_key(*k)).collect();
        let only_backend: Vec<_> = backend.keys().filter(|k| !ui.contains_key(*k)).collect();
        assert!(only_ui.is_empty(), "in src/lib/flags.ts but not in FEATURE_FLAGS: {only_ui:?}");
        assert!(only_backend.is_empty(), "in FEATURE_FLAGS but not in src/lib/flags.ts: {only_backend:?}");
        for (key, default) in &backend {
            assert_eq!(ui[key], *default, "default of {key} differs between the UI and the backend");
        }
    }

    #[test]
    fn every_flag_is_seeded_without_overwriting_what_a_db_owner_set() {
        let path = std::env::temp_dir().join(format!("kinesis_flags_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = path.to_string_lossy().to_string();
        init_db(&db).unwrap();
        {
            let conn = Connection::open(&db).unwrap();
            for (key, default) in FEATURE_FLAGS {
                let v: String = conn
                    .query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0))
                    .unwrap_or_else(|_| panic!("{key} was not seeded"));
                assert_eq!(&v, default, "{key}");
            }
            conn.execute("UPDATE settings SET value = 'false' WHERE key = 'showTabTheme'", []).unwrap();
        }
        // Starting the app again (init_db runs on every launch) leaves the owner's choice alone.
        init_db(&db).unwrap();
        assert_eq!(crate::db::get_setting(&db, "showTabTheme").unwrap().as_deref(), Some("false"));
        let _ = std::fs::remove_file(&path);
    }
}
