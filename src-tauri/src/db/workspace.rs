//! Customized display names: the workspace's own name and the aliases for Search, Library, Drive
//! and so on, stored in `workspace_labels` (key/value). A missing row means the built-in default,
//! so nothing has to be seeded and "reset" is just deleting the row. The UI's copy of the keys,
//! defaults and limits is `src/lib/workspace.ts` (a test keeps the two in step).
//!
//! Names are ASCII letters, digits and single spaces only, so they can safely become part of a
//! file name (see the export commands) or a sync-pack name. Two flags gate editing:
//! `showWorkspaceAdvanced` (the aliases) and `allowWorkspaceRename` (the workspace name, once set).

use rusqlite::{params, Connection};
use std::collections::HashMap;

use super::settings::get_flag;

pub const WORKSPACE_NAME_KEY: &str = "workspaceName";
pub const MAX_WORKSPACE_NAME_LEN: usize = 64;
pub const MAX_ALIAS_LEN: usize = 18;

/// `(key, default, max length)` for every customizable name.
pub const LABELS: &[(&str, &str, usize)] = &[
    (WORKSPACE_NAME_KEY, "New Workspace", MAX_WORKSPACE_NAME_LEN),
    ("aliasDriveName", "Drive", MAX_ALIAS_LEN),
    ("aliasSearch", "Search", MAX_ALIAS_LEN),
    ("aliasLibrary", "Library", MAX_ALIAS_LEN),
    ("aliasGlossary", "Glossary", MAX_ALIAS_LEN),
    // The plural/section name ("Biography", "Creators") and the singular for one entry
    // ("Person", "Creator"), used in phrases like "Look up Person".
    ("aliasBiography", "Biography", MAX_ALIAS_LEN),
    ("aliasBiographyItem", "Person", MAX_ALIAS_LEN),
    // A video's extra Drive categories: the "Also in" link and its symbolic-link flavor.
    ("aliasDriveLink", "Link", MAX_ALIAS_LEN),
    ("aliasDriveSymlink", "Symlink", MAX_ALIAS_LEN),
];

fn label_def(key: &str) -> Option<&'static (&'static str, &'static str, usize)> {
    LABELS.iter().find(|(k, _, _)| *k == key)
}

/// Trims, collapses runs of spaces, and checks the name is letters/digits/spaces within `max`
/// characters. An empty result is valid and means "use the default".
pub fn normalize_label(raw: &str, max: usize) -> Result<String, String> {
    let cleaned = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(bad) = cleaned.chars().find(|c| !(c.is_ascii_alphanumeric() || *c == ' ')) {
        return Err(format!("Only letters, numbers and spaces are allowed (found '{bad}')."));
    }
    if cleaned.chars().count() > max {
        return Err(format!("Must be {max} characters or fewer."));
    }
    Ok(cleaned)
}

/// Every name, with the default filled in for anything unset. A hand-edited row that breaks the
/// rules is ignored in favor of the default rather than shown.
pub fn get_workspace_labels(db_path: &str) -> rusqlite::Result<HashMap<String, String>> {
    let conn = Connection::open(db_path)?;
    let mut stored: HashMap<String, String> = HashMap::new();
    let mut stmt = conn.prepare("SELECT key, value FROM workspace_labels")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (k, v) = row?;
        stored.insert(k, v);
    }
    Ok(LABELS
        .iter()
        .map(|(key, default, max)| {
            let value = stored
                .get(*key)
                .and_then(|v| normalize_label(v, *max).ok())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| default.to_string());
            (key.to_string(), value)
        })
        .collect())
}

/// Sets one name; an empty value resets it to the default. Returns the value now in effect.
pub fn set_workspace_label(db_path: &str, key: &str, value: &str) -> Result<String, String> {
    let &(_, default, max) = label_def(key).ok_or_else(|| format!("Unknown name '{key}'."))?;
    let cleaned = normalize_label(value, max)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    if key == WORKSPACE_NAME_KEY {
        let already_named: bool = conn
            .query_row("SELECT 1 FROM workspace_labels WHERE key = ?", params![key], |_| Ok(true))
            .unwrap_or(false);
        if already_named && !get_flag(db_path, "allowWorkspaceRename", true) {
            return Err("This workspace's name can't be changed.".into());
        }
    } else if !get_flag(db_path, "showWorkspaceAdvanced", true) {
        return Err("Renaming sections is turned off for this workspace.".into());
    }

    if cleaned.is_empty() {
        conn.execute("DELETE FROM workspace_labels WHERE key = ?", params![key]).map_err(|e| e.to_string())?;
        return Ok(default.to_string());
    }
    conn.execute(
        "INSERT OR REPLACE INTO workspace_labels (key, value) VALUES (?1, ?2)",
        params![key, cleaned],
    )
    .map_err(|e| e.to_string())?;
    Ok(cleaned)
}

/// What the workspace calls its Drive (`aliasDriveName`), for messages built in the backend.
pub fn drive_label(db_path: &str) -> String {
    get_workspace_labels(db_path)
        .ok()
        .and_then(|mut labels| labels.remove("aliasDriveName"))
        .unwrap_or_else(|| "Drive".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_db, set_setting};

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_workspace_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    #[test]
    fn the_ui_and_the_backend_agree_on_every_name_default_and_limit() {
        let src = include_str!("../../../src/lib/workspace.ts");
        let body = src
            .split("export const LABEL_DEFS = [")
            .nth(1)
            .expect("LABEL_DEFS in src/lib/workspace.ts")
            .split("] as const;")
            .next()
            .unwrap();
        // One `{ key: 'x', default: 'y', max: N, ... }` per line.
        let field = |line: &str, name: &str| -> Option<String> {
            let rest = line.split(&format!("{name}: ")).nth(1)?;
            let rest = rest.trim_start_matches('\'');
            Some(rest.split(|c| c == '\'' || c == ',').next()?.to_string())
        };
        let mut ui = Vec::new();
        for line in body.lines().filter(|l| l.contains("key:")) {
            ui.push((field(line, "key").unwrap(), field(line, "default").unwrap(), field(line, "max").unwrap()));
        }
        let backend: Vec<_> = LABELS.iter().map(|(k, d, m)| (k.to_string(), d.to_string(), m.to_string())).collect();
        assert_eq!(ui, backend);
    }

    #[test]
    fn names_are_letters_digits_and_single_spaces_within_the_limit() {
        assert_eq!(normalize_label("  Metabolic   Warp Drive ", 64).unwrap(), "Metabolic Warp Drive");
        assert_eq!(normalize_label("", 18).unwrap(), "");
        assert_eq!(normalize_label("   ", 18).unwrap(), "");
        for bad in ["a/b", "a_b", "Warp-Drive", "Café", "a.b", "<x>", "a\\b"] {
            assert!(normalize_label(bad, 64).is_err(), "{bad:?}");
        }
        assert!(normalize_label(&"a".repeat(18), 18).is_ok());
        assert!(normalize_label(&"a".repeat(19), 18).is_err());
        assert!(normalize_label(&"a".repeat(64), 64).is_ok());
        assert!(normalize_label(&"a".repeat(65), 64).is_err());
    }

    #[test]
    fn unset_names_use_defaults_and_an_empty_value_resets() {
        let db = temp_db("defaults");
        let labels = get_workspace_labels(&db).unwrap();
        assert_eq!(labels["workspaceName"], "New Workspace");
        assert_eq!(labels["aliasLibrary"], "Library");
        assert_eq!(labels["aliasBiographyItem"], "Person");
        assert_eq!(labels.len(), LABELS.len());

        assert_eq!(set_workspace_label(&db, "aliasLibrary", "Portal").unwrap(), "Portal");
        assert_eq!(get_workspace_labels(&db).unwrap()["aliasLibrary"], "Portal");
        assert_eq!(set_workspace_label(&db, "aliasLibrary", "  ").unwrap(), "Library");
        assert_eq!(get_workspace_labels(&db).unwrap()["aliasLibrary"], "Library");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn invalid_or_unknown_names_are_rejected_and_junk_rows_fall_back() {
        let db = temp_db("invalid");
        assert!(set_workspace_label(&db, "aliasSearch", "Look/up").is_err());
        assert!(set_workspace_label(&db, "aliasSearch", &"x".repeat(19)).is_err());
        assert!(set_workspace_label(&db, "nope", "x").is_err());
        Connection::open(&db)
            .unwrap()
            .execute("INSERT INTO workspace_labels (key, value) VALUES ('aliasSearch', 'bad/name')", [])
            .unwrap();
        assert_eq!(get_workspace_labels(&db).unwrap()["aliasSearch"], "Search");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn the_flags_gate_renaming() {
        let db = temp_db("flags");
        set_workspace_label(&db, "workspaceName", "Metabolic Warp Drive").unwrap();

        set_setting(&db, "allowWorkspaceRename", "false").unwrap();
        assert!(set_workspace_label(&db, "workspaceName", "Other").is_err());
        // Aliases have their own flag.
        assert!(set_workspace_label(&db, "aliasSearch", "Lookup").is_ok());

        set_setting(&db, "showWorkspaceAdvanced", "false").unwrap();
        assert!(set_workspace_label(&db, "aliasSearch", "Find").is_err());
        assert_eq!(get_workspace_labels(&db).unwrap()["aliasSearch"], "Lookup");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_workspace_can_be_named_once_even_when_renaming_is_off() {
        let db = temp_db("first_name");
        set_setting(&db, "allowWorkspaceRename", "false").unwrap();
        assert!(set_workspace_label(&db, "workspaceName", "First Name").is_ok());
        assert!(set_workspace_label(&db, "workspaceName", "Second Name").is_err());
        let _ = std::fs::remove_file(&db);
    }
}
