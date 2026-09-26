//! Workspaces: every workspace is a folder under the app data directory that holds its own
//! `init.conf`, and usually its `kinesis_data.db` too.
//!
//! ```text
//! kinesisapp/
//!   Metabolic Warp Drive/
//!     kinesis_data.db
//!     init.conf          db_path: E:\Drives\MWD   <- only when the database lives elsewhere
//!                        last_opened: 1789000000000
//! ```
//!
//! There is no global registry: the recents list is a scan of these folders, and "the most recent
//! workspace" is the one with the newest `last_opened`. A workspace on an external drive is a folder
//! here holding just an `init.conf` that points at it, so it stays listed (dimmed) while the drive is
//! unplugged. The workspace's own name lives inside its database (db/workspace.rs); the folder is
//! named after it and renamed with it.
//!
//! Nothing here ever creates a database as a side effect of looking for one: a missing database is
//! an error the launcher shows, never a fresh empty library.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use tauri::Manager;

use crate::db;

pub const DB_FILE: &str = "kinesis_data.db";
pub const CONF_FILE: &str = "init.conf";
const LEGACY_CONF_BACKUP: &str = "init.conf.legacy";
const LOCK_FILE: &str = ".kinesis.lock";
/// A workspace's database while it's still being built (an import can take a while). It only becomes
/// `kinesis_data.db` once complete, so a build that was interrupted never leaves something that looks
/// like a finished workspace, or blocks trying again in the same place.
const DB_PART: &str = "kinesis_data.db.part";

const KEY_DB_PATH: &str = "db_path";
const KEY_LAST_OPENED: &str = "last_opened";
const KEY_HIDDEN: &str = "hidden";

/// Names Windows won't accept for a folder, whatever the extension.
const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

// ─── init.conf ──────────────────────────────────────────────────────────────

/// `key: value` per line (the format the app has always used). Unknown keys are kept on rewrite.
pub fn read_conf(dir: &Path) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Ok(text) = fs::read_to_string(dir.join(CONF_FILE)) {
        for line in text.lines() {
            if let Some((k, v)) = line.split_once(':') {
                let (k, v) = (k.trim(), v.trim());
                if !k.is_empty() {
                    map.insert(k.to_string(), v.to_string());
                }
            }
        }
    }
    map
}

pub fn write_conf(dir: &Path, map: &BTreeMap<String, String>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let text: String = map.iter().map(|(k, v)| format!("{k}: {v}\n")).collect();
    fs::write(dir.join(CONF_FILE), text).map_err(|e| format!("Couldn't write {}: {e}", dir.join(CONF_FILE).display()))
}

fn update_conf(dir: &Path, change: impl FnOnce(&mut BTreeMap<String, String>)) -> Result<(), String> {
    let mut map = read_conf(dir);
    change(&mut map);
    write_conf(dir, &map)
}

/// The folder holding this workspace's database: the redirect in its `init.conf`, else the
/// workspace folder itself.
pub fn data_dir(ws_dir: &Path) -> PathBuf {
    match read_conf(ws_dir).get(KEY_DB_PATH).filter(|v| !v.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => ws_dir.to_path_buf(),
    }
}

pub fn is_redirected(ws_dir: &Path) -> bool {
    read_conf(ws_dir).get(KEY_DB_PATH).is_some_and(|v| !v.is_empty())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Marks a workspace as the most recently opened (and shows it again if it had been hidden).
pub fn touch(ws_dir: &Path) {
    let _ = update_conf(ws_dir, |m| {
        m.insert(KEY_LAST_OPENED.into(), now_ms().to_string());
        m.remove(KEY_HIDDEN);
    });
}

// ─── Names ──────────────────────────────────────────────────────────────────

/// A workspace name is a folder name, so on top of the label rules (letters, digits, single spaces,
/// 64 characters) it can't be empty or one of Windows' reserved device names.
pub fn validate_name(raw: &str) -> Result<String, String> {
    let name = db::normalize_label(raw, db::MAX_WORKSPACE_NAME_LEN)?;
    if name.is_empty() {
        return Err("Give the workspace a name.".into());
    }
    if RESERVED_NAMES.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(format!("\"{name}\" is a reserved name on Windows. Pick another."));
    }
    Ok(name)
}

/// Turns any text (a folder name, a name from a foreign pack) into something `validate_name` accepts.
pub fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' }).collect();
    let mut name: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.chars().count() > db::MAX_WORKSPACE_NAME_LEN {
        name = name.chars().take(db::MAX_WORKSPACE_NAME_LEN).collect::<String>().trim().to_string();
    }
    if name.is_empty() || validate_name(&name).is_err() {
        "Workspace".to_string()
    } else {
        name
    }
}

/// An existing entry in `root` whose name matches `name` ignoring case (Windows and macOS treat
/// "Research" and "research" as the same folder, so the app must too).
fn entry_named(root: &Path, name: &str) -> Option<PathBuf> {
    fs::read_dir(root).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(name))
    })
}

/// True when `name` is used by a folder here, or is the name a workspace shows in the list.
pub fn name_taken(root: &Path, name: &str) -> bool {
    entry_named(root, name).is_some() || find_workspace(root, name).is_some()
}

/// The existing workspace called `name` (ignoring case), hidden ones included: a kinpak with that
/// name is added to it rather than made into a second one. It goes by the name the workspace shows
/// (the one in its database, which is what a kinpak records) as well as by its folder, because the
/// two can differ: a folder that couldn't be renamed along with its workspace, or a database
/// registered from a folder with another name. A workspace on an unplugged drive still counts, by
/// its folder name.
pub fn find_workspace(root: &Path, name: &str) -> Option<PathBuf> {
    if let Some(dir) = entry_named(root, name).filter(|p| is_workspace_dir(p)) {
        return Some(dir);
    }
    list(root, true).into_iter().find(|w| w.name.eq_ignore_ascii_case(name)).map(|w| root.join(&w.folder))
}

/// The folder of the workspace called `folder` (the id the UI got from `list`). Rejects anything
/// that isn't a plain folder name, so a request can never reach outside the app data directory.
pub fn workspace_dir(root: &Path, folder: &str) -> Result<PathBuf, String> {
    let plain = !folder.is_empty()
        && !folder.starts_with('.')
        && !folder.contains(['/', '\\', ':'])
        && Path::new(folder).components().count() == 1;
    let dir = root.join(folder);
    if !plain || !is_workspace_dir(&dir) {
        return Err("That workspace no longer exists.".into());
    }
    Ok(dir)
}

/// `base`, or "base 2", "base 3", ... — the first name no folder in `root` uses.
pub fn unique_name(root: &Path, base: &str) -> String {
    if !name_taken(root, base) {
        return base.to_string();
    }
    for n in 2..10_000 {
        let suffix = format!(" {n}");
        let keep = db::MAX_WORKSPACE_NAME_LEN.saturating_sub(suffix.chars().count());
        let stem: String = base.chars().take(keep).collect();
        let candidate = format!("{}{}", stem.trim_end(), suffix);
        if !name_taken(root, &candidate) {
            return candidate;
        }
    }
    format!("{base} {}", now_ms())
}

// ─── Reading workspaces ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceInfo {
    /// Folder name under the app data directory: the workspace's identity for open/forget/relocate.
    pub folder: String,
    pub name: String,
    /// Where the data actually lives (what the launcher shows under the name).
    pub path: String,
    pub db_path: String,
    /// False when the database can't be found (an unplugged drive, a moved folder).
    pub available: bool,
    pub redirected: bool,
    pub last_opened: i64,
    pub hidden: bool,
    pub current: bool,
}

/// The workspace's own name from its database, without opening it for writing or migrating it.
fn read_name(db_file: &Path) -> Option<String> {
    let conn = Connection::open_with_flags(db_file, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let value: String = conn
        .query_row("SELECT value FROM WorkspaceLabels WHERE key = ?1", params![db::WORKSPACE_NAME_KEY], |r| r.get(0))
        .ok()?;
    db::normalize_label(&value, db::MAX_WORKSPACE_NAME_LEN).ok().filter(|s| !s.is_empty())
}

pub fn info(ws_dir: &Path) -> WorkspaceInfo {
    let conf = read_conf(ws_dir);
    let folder = ws_dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let dir = data_dir(ws_dir);
    let db_file = dir.join(DB_FILE);
    let available = db_file.is_file();
    let name = if available { read_name(&db_file) } else { None }.unwrap_or_else(|| folder.clone());
    WorkspaceInfo {
        folder,
        name,
        path: dir.to_string_lossy().into_owned(),
        db_path: db_file.to_string_lossy().into_owned(),
        available,
        redirected: is_redirected(ws_dir),
        last_opened: conf.get(KEY_LAST_OPENED).and_then(|v| v.parse().ok()).unwrap_or(0),
        hidden: conf.get(KEY_HIDDEN).is_some_and(|v| v == "true"),
        current: false,
    }
}

/// A folder counts as a workspace only if it has its own `init.conf` or database, so unrelated
/// folders the app or the OS keeps here are never listed. Dot-folders are staging areas.
fn is_workspace_dir(dir: &Path) -> bool {
    let hidden_name = dir.file_name().and_then(|n| n.to_str()).is_none_or(|n| n.starts_with('.'));
    dir.is_dir() && !hidden_name && (dir.join(CONF_FILE).is_file() || dir.join(DB_FILE).is_file())
}

/// Workspaces, most recently opened first. Hidden ones ("removed from the list") only when asked.
pub fn list(root: &Path, include_hidden: bool) -> Vec<WorkspaceInfo> {
    let mut all: Vec<WorkspaceInfo> = fs::read_dir(root)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| is_workspace_dir(p))
                .map(|p| info(&p))
                .filter(|w| include_hidden || !w.hidden)
                .collect()
        })
        .unwrap_or_default();
    all.sort_by(|a, b| b.last_opened.cmp(&a.last_opened).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    all
}

pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    fn norm(p: &Path) -> String {
        let c = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let s = c.to_string_lossy().replace('\\', "/");
        let s = s.trim_start_matches("//?/").trim_end_matches('/').to_string();
        if cfg!(windows) { s.to_lowercase() } else { s }
    }
    norm(a) == norm(b)
}

// ─── Creating and registering ───────────────────────────────────────────────

/// Sets the workspace's name directly, bypassing the rename flags: choosing a name at creation or
/// import is not a "rename", and a pack may itself carry `allowWorkspaceRename=false`.
pub fn force_workspace_name(db_path: &str, name: &str) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO WorkspaceLabels (key, value) VALUES (?1, ?2)",
        params![db::WORKSPACE_NAME_KEY, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    // Antivirus and indexers briefly hold a fresh file on Windows; a short retry rides that out.
    let mut last = None;
    for _ in 0..5 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(120));
            }
        }
    }
    Err(last.unwrap())
}

/// Builds a new workspace named `raw_name` and returns its folder. `init` receives the database
/// path and must create everything in it (the schema, and an import if there is one). The work
/// happens in a staging folder that is only renamed into place once it all succeeded, so a failure
/// never leaves a half-made workspace behind. It never touches an existing workspace: a name that's
/// taken is an error. `location` puts the data in `<location>/<name>` instead (an external drive);
/// the workspace folder then only holds the `init.conf` pointing there.
pub fn create_with(
    root: &Path,
    raw_name: &str,
    location: Option<&Path>,
    init: impl FnOnce(&str) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let name = validate_name(raw_name)?;
    let final_dir = root.join(&name);

    if name_taken(root, &name) {
        return Err(format!("A workspace named \"{name}\" already exists."));
    }

    fs::create_dir_all(root).map_err(|e| format!("Couldn't create {}: {e}", root.display()))?;
    let stage = root.join(format!(".staging-{}", now_ms()));
    fs::create_dir_all(&stage).map_err(|e| format!("Couldn't create {}: {e}", stage.display()))?;

    let external = location.map(|p| p.join(&name));
    let mut created_external = false;
    if let Some(dir) = &external {
        if dir.join(DB_FILE).exists() {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("{} already contains a Kinesis database. Pick another location.", dir.display()));
        }
        created_external = !dir.exists();
        if let Err(e) = fs::create_dir_all(dir) {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("Couldn't create {}: {e}", dir.display()));
        }
    }
    let data = external.clone().unwrap_or_else(|| stage.clone());

    let remove_part = |dir: &Path| {
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let _ = fs::remove_file(dir.join(format!("{DB_PART}{suffix}")));
        }
    };
    // What's left of an earlier attempt that was interrupted (the app closed mid-import): it can't be
    // in use, since the workspace it belongs to doesn't exist yet.
    remove_part(&data);

    let built = (|| -> Result<(), String> {
        let part = data.join(DB_PART);
        let part_str = part.to_string_lossy().into_owned();
        init(&part_str)?;
        force_workspace_name(&part_str, &name)?;
        rename_retry(&part, &data.join(DB_FILE)).map_err(|e| format!("Couldn't finish the database: {e}"))?;
        let mut conf = BTreeMap::new();
        if let Some(dir) = &external {
            conf.insert(KEY_DB_PATH.to_string(), dir.to_string_lossy().into_owned());
        }
        conf.insert(KEY_LAST_OPENED.to_string(), now_ms().to_string());
        write_conf(&stage, &conf)
    })();

    let cleanup = |stage: &Path| {
        let _ = fs::remove_dir_all(stage);
        if let Some(dir) = &external {
            remove_part(dir);
            let _ = fs::remove_file(dir.join(DB_FILE));
            if created_external {
                let _ = fs::remove_dir(dir);
            }
        }
    };
    if let Err(e) = built {
        cleanup(&stage);
        return Err(e);
    }

    // Swap into place.
    if let Err(e) = rename_retry(&stage, &final_dir) {
        cleanup(&stage);
        return Err(format!("Couldn't create the workspace folder: {e}"));
    }
    Ok(final_dir)
}

/// A brand-new, empty workspace.
pub fn create(root: &Path, raw_name: &str, location: Option<&Path>) -> Result<PathBuf, String> {
    create_with(root, raw_name, location, |db_file| {
        db::init_db(db_file).map_err(|e| format!("Couldn't create the database: {e}"))
    })
}

/// Adds an existing database (a workspace folder from elsewhere, an external drive) to the list.
/// `picked` is a folder holding `kinesis_data.db`, or a workspace folder with an `init.conf`.
/// Already-known databases are found by path, so opening the same one twice never duplicates it.
pub fn register_existing(root: &Path, picked: &Path) -> Result<PathBuf, String> {
    let data = if picked.join(CONF_FILE).is_file() { data_dir(picked) } else { picked.to_path_buf() };
    let db_file = data.join(DB_FILE);
    if !db_file.is_file() {
        return Err(format!(
            "There's no Kinesis database ({DB_FILE}) in {}. Choose the folder that contains it.",
            data.display()
        ));
    }
    for known in list(root, true) {
        let ws_dir = root.join(&known.folder);
        if same_path(&data_dir(&ws_dir), &data) {
            let _ = update_conf(&ws_dir, |m| {
                m.remove(KEY_HIDDEN);
            });
            return Ok(ws_dir);
        }
    }
    let base = read_name(&db_file).unwrap_or_else(|| {
        sanitize_name(picked.file_name().and_then(|n| n.to_str()).unwrap_or("Workspace"))
    });
    let name = unique_name(root, &sanitize_name(&base));
    let ws_dir = root.join(&name);
    fs::create_dir_all(&ws_dir).map_err(|e| format!("Couldn't create {}: {e}", ws_dir.display()))?;
    let mut conf = BTreeMap::new();
    conf.insert(KEY_DB_PATH.to_string(), data.to_string_lossy().into_owned());
    conf.insert(KEY_LAST_OPENED.to_string(), now_ms().to_string());
    if let Err(e) = write_conf(&ws_dir, &conf) {
        let _ = fs::remove_dir_all(&ws_dir);
        return Err(e);
    }
    Ok(ws_dir)
}

/// "Remove from list". Never deletes a database: a redirect entry just loses its `init.conf`
/// stub, and a workspace whose data is in its own folder is hidden (opening it again by path, or
/// creating one with a fresh name, is still possible).
pub fn forget(ws_dir: &Path) -> Result<(), String> {
    if is_redirected(ws_dir) {
        let _ = fs::remove_file(ws_dir.join(CONF_FILE));
        // Only an empty stub folder goes; anything else in it stays.
        let _ = fs::remove_dir(ws_dir);
        Ok(())
    } else {
        update_conf(ws_dir, |m| {
            m.insert(KEY_HIDDEN.into(), "true".into());
        })
    }
}

/// Points a workspace at a new data folder ("Locate…" for a moved or re-lettered drive).
pub fn relocate(ws_dir: &Path, new_data_dir: &Path) -> Result<(), String> {
    if !new_data_dir.join(DB_FILE).is_file() {
        return Err(format!("There's no Kinesis database ({DB_FILE}) in {}.", new_data_dir.display()));
    }
    set_data_dir(ws_dir, new_data_dir)
}

/// Records where the data lives; the workspace folder itself needs no redirect.
pub fn set_data_dir(ws_dir: &Path, new_data_dir: &Path) -> Result<(), String> {
    update_conf(ws_dir, |m| {
        if same_path(ws_dir, new_data_dir) {
            m.remove(KEY_DB_PATH);
        } else {
            m.insert(KEY_DB_PATH.into(), new_data_dir.to_string_lossy().into_owned());
        }
    })
}

/// Checks a workspace can take `new_name` (not taken by another workspace, a legal folder name).
pub fn check_rename(root: &Path, ws_dir: &Path, raw_name: &str) -> Result<String, String> {
    let name = validate_name(raw_name)?;
    if let Some(ex) = find_workspace(root, &name).or_else(|| entry_named(root, &name)) {
        if !same_path(&ex, ws_dir) {
            return Err(format!("Another workspace is already named \"{name}\"."));
        }
    }
    Ok(name)
}

/// Renames the workspace's folder to `name` and returns the new folder. A case-only change
/// ("research" → "Research") is a plain rename too.
pub fn rename_folder(root: &Path, ws_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let target = root.join(name);
    if ws_dir.file_name().and_then(|n| n.to_str()) == Some(name) {
        return Ok(ws_dir.to_path_buf());
    }
    rename_retry(ws_dir, &target).map_err(|e| format!("Couldn't rename the workspace folder: {e}"))?;
    Ok(target)
}

// ─── Upgrading from the single-database layout ──────────────────────────────

/// Settings a brand-new database is seeded with (db/schema.rs), plus internal migration markers.
/// Anything else in `settings` (an API key, a theme, a plugin choice) means someone used the app.
fn is_seeded_setting(key: &str) -> bool {
    key.starts_with("migrated")
        || matches!(key, "navigation_orientation" | "venice_model")
        || kinesis_sync_proto::FEATURE_FLAGS.iter().any(|(k, _)| *k == key)
}

/// True for a database nobody has used: no content, no name, no notes or history, and no settings
/// beyond the seeded ones. A database that can't be read is *not* pristine: better to adopt it and
/// show the error than to quietly ignore someone's library.
fn is_pristine(db_file: &Path) -> bool {
    let Ok(conn) = Connection::open_with_flags(db_file, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    let has_rows = |table: &str| -> bool {
        // A table that doesn't exist (an old or partial database) simply has no rows.
        conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table})"), [], |r| r.get::<_, bool>(0)).unwrap_or(false)
    };
    let content = [
        "Videos", "Glossary", "Biographies", "CustomPrompts", "SearchHistory", "VideoNotes",
        "VideoAttachments", "WorkspaceLabels", "tblWDBS", "VideoWDBSLinks",
    ];
    if content.iter().any(|t| has_rows(t)) {
        return false;
    }
    let Ok(mut stmt) = conn.prepare("SELECT key FROM Settings") else {
        return true;
    };
    let Ok(keys) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return false;
    };
    let used = keys.filter_map(|k| k.ok()).any(|k| !is_seeded_setting(&k));
    !used
}

/// Older versions kept one `init.conf` (with an optional `db_path`) and `kinesis_data.db` directly
/// in the app data directory. Adopts that database as a workspace so existing users open straight
/// into their library. The database is moved (a rename, not a copy) when it's in the default place,
/// and left where it is behind a redirect when it was somewhere else. The old `init.conf` is kept
/// as `init.conf.legacy`. Returns the new workspace's folder when something was adopted.
pub fn migrate_legacy(root: &Path) -> Result<Option<PathBuf>, String> {
    let legacy_conf = root.join(CONF_FILE);
    let root_db = root.join(DB_FILE);
    if !legacy_conf.is_file() && !root_db.is_file() {
        return Ok(None);
    }
    let redirect = read_conf(root).get(KEY_DB_PATH).filter(|v| !v.is_empty()).map(PathBuf::from);
    // The database the app was really using: the redirect when there was one.
    let source_dir = redirect.clone().unwrap_or_else(|| root.to_path_buf());
    let source_db = source_dir.join(DB_FILE);

    let retire_conf = || {
        if legacy_conf.is_file() {
            let _ = fs::remove_file(root.join(LEGACY_CONF_BACKUP));
            let _ = fs::rename(&legacy_conf, root.join(LEGACY_CONF_BACKUP));
        }
    };

    // An older Kinesis (an installed copy that's still in use next to this one) re-creates these
    // files every time it starts. If what's there was never used, there's nothing to bring across, and
    // adopting it would only litter the list with empty "New Workspace" entries and skip the
    // launcher. It's left alone, and the launcher shows if nothing else is open.
    if source_db.is_file() && is_pristine(&source_db) {
        return Ok(None);
    }
    // Already adopted on an earlier start (the same database, still behind the same pointer).
    if source_db.is_file() {
        let already = list(root, true).into_iter().any(|w| same_path(&data_dir(&root.join(&w.folder)), &source_dir));
        if already {
            retire_conf();
            return Ok(None);
        }
    }

    if !source_db.is_file() {
        // A leftover config pointing at nothing: nothing to adopt. An unplugged drive must not make
        // the app conjure up an empty library, so keep the pointer as a workspace that's "not found".
        if let Some(dir) = redirect {
            let base = sanitize_name(dir.file_name().and_then(|n| n.to_str()).unwrap_or("Workspace"));
            let name = unique_name(root, &base);
            let ws_dir = root.join(&name);
            let mut conf = BTreeMap::new();
            conf.insert(KEY_DB_PATH.to_string(), dir.to_string_lossy().into_owned());
            conf.insert(KEY_LAST_OPENED.to_string(), now_ms().to_string());
            write_conf(&ws_dir, &conf)?;
            retire_conf();
            return Ok(Some(ws_dir));
        }
        retire_conf();
        return Ok(None);
    }

    let name = unique_name(root, &sanitize_name(&read_name(&source_db).unwrap_or_else(|| "New Workspace".into())));
    let ws_dir = root.join(&name);
    fs::create_dir_all(&ws_dir).map_err(|e| format!("Couldn't create {}: {e}", ws_dir.display()))?;
    let mut conf = BTreeMap::new();
    conf.insert(KEY_LAST_OPENED.to_string(), now_ms().to_string());

    if let Some(dir) = redirect {
        conf.insert(KEY_DB_PATH.to_string(), dir.to_string_lossy().into_owned());
    } else {
        // Move the database and any SQLite side files. If a move fails, keep the database where it
        // is and point at it, which is always safe.
        let mut moved = Vec::new();
        let mut failed = false;
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let from = root.join(format!("{DB_FILE}{suffix}"));
            if !from.exists() {
                continue;
            }
            let to = ws_dir.join(format!("{DB_FILE}{suffix}"));
            if fs::rename(&from, &to).is_err() {
                failed = true;
                break;
            }
            moved.push((from, to));
        }
        if failed {
            for (from, to) in moved.into_iter().rev() {
                let _ = fs::rename(to, from);
            }
            conf.insert(KEY_DB_PATH.to_string(), root.to_string_lossy().into_owned());
        }
    }
    write_conf(&ws_dir, &conf)?;
    retire_conf();
    Ok(Some(ws_dir))
}

// ─── The open workspace ─────────────────────────────────────────────────────

pub(crate) struct ActiveWorkspace {
    pub ws_dir: PathBuf,
    /// Held for as long as the workspace is open; dropping it releases the lock.
    _lock: Option<File>,
}

pub(crate) struct ActiveWorkspaceState(pub Mutex<Option<ActiveWorkspace>>);
/// Why the app didn't open a workspace by itself at startup, for the launcher to show.
pub(crate) struct StartupNoticeState(pub Mutex<Option<String>>);

/// The long-running job (a Kinpak export or import) in progress, if any. While one runs, switching
/// workspaces, moving the database and renaming the workspace's folder are refused: they would pull
/// the ground out from under it, and the person who started it would lose the outcome.
pub(crate) struct BusyState(pub Mutex<Option<&'static str>>);

/// Held for as long as a long-running job runs; dropping it says the job is over.
pub(crate) struct BusyGuard {
    app: tauri::AppHandle,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        *lock_state(&self.app.state::<BusyState>().0) = None;
    }
}

/// Marks a job (`what` is "export" or "import") as running. Only one at a time.
pub(crate) fn begin_task(app: &tauri::AppHandle, what: &'static str) -> Result<BusyGuard, String> {
    let state = app.state::<BusyState>();
    let mut busy = lock_state(&state.0);
    if let Some(running) = *busy {
        return Err(format!("A Kinpak {running} is already running. Wait for it to finish first."));
    }
    *busy = Some(what);
    Ok(BusyGuard { app: app.clone() })
}

/// Refuses (with a message to show) when a job is running that switching or moving would disturb.
pub(crate) fn ensure_not_busy(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<BusyState>();
    let running = *lock_state(&state.0);
    match running {
        Some(running) => Err(format!("A Kinpak {running} is running. Wait for it to finish, then try again.")),
        None => Ok(()),
    }
}

fn lock_state<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// One Kinesis window per workspace: two processes writing the same SQLite file (one over an
/// external drive, say) is how databases get damaged. The OS drops the lock if the app crashes.
/// A folder that can't be written to (a read-only drive) simply goes without.
pub(crate) fn acquire_lock(data: &Path) -> Result<Option<File>, String> {
    let Ok(file) = OpenOptions::new().create(true).write(true).open(data.join(LOCK_FILE)) else {
        return Ok(None);
    };
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(Some(file)),
        // Only a lock somebody else really holds stops the open. A filesystem that can't lock at all
        // (a network share, a FUSE mount) says so with a different error, and goes without the lock.
        Err(e) if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
            Err("This workspace is already open in another Kinesis window.".into())
        }
        Err(e) => {
            log::warn!("Couldn't lock {}: {e}. Opening without the one-window-per-workspace guard.", data.display());
            Ok(None)
        }
    }
}

pub(crate) fn app_root(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub(crate) fn current_folder(app: &tauri::AppHandle) -> Option<PathBuf> {
    lock_state(&app.state::<ActiveWorkspaceState>().0).as_ref().map(|a| a.ws_dir.clone())
}

/// Makes `ws_dir` the open workspace: checks its database exists, takes the lock, runs the schema
/// upgrades and swaps the app's database path. Leaves the previous workspace open on any failure.
pub(crate) fn activate(app: &tauri::AppHandle, ws_dir: &Path) -> Result<WorkspaceInfo, String> {
    let data = data_dir(ws_dir);
    let db_file = data.join(DB_FILE);
    if !db_file.is_file() {
        return Err(format!(
            "Couldn't find this workspace's database at {}. If it's on an external drive, connect it, or use Locate to point to its new location.",
            data.display()
        ));
    }
    let state = app.state::<ActiveWorkspaceState>();
    let mut active = lock_state(&state.0);
    if active.as_ref().is_some_and(|a| a.ws_dir == ws_dir) {
        let mut i = info(ws_dir);
        i.current = true;
        return Ok(i);
    }
    let lock = acquire_lock(&data)?;
    let db_str = db_file.to_string_lossy().into_owned();
    db::init_db(&db_str).map_err(|e| format!("Couldn't open the database at {}: {e}", db_str))?;
    touch(ws_dir);
    *lock_state(&app.state::<crate::DbPathState>().0) = Some(db_str);
    *active = Some(ActiveWorkspace { ws_dir: ws_dir.to_path_buf(), _lock: lock });
    drop(active);
    // The Trash holds what was deleted from the workspace being left; it can't be restored into another.
    crate::trash::clear(crate::trash::store(app));
    crate::refresh_window_title(app);
    let mut i = info(ws_dir);
    i.current = true;
    Ok(i)
}

/// App start: adopts an older single-database install, then opens the most recent workspace.
/// Anything that stops that is recorded as a notice for the launcher instead of guessing.
pub(crate) fn startup(app: &tauri::AppHandle) {
    let root = app_root(app);
    remove_stale_staging(&root);
    let notice = |msg: String| {
        log::warn!("{msg}");
        *lock_state(&app.state::<StartupNoticeState>().0) = Some(msg);
    };
    if let Err(e) = migrate_legacy(&root) {
        notice(format!("Couldn't bring your existing library into a workspace: {e}"));
    }
    if let Some(recent) = list(&root, false).into_iter().next() {
        if let Err(e) = activate(app, &root.join(&recent.folder)) {
            notice(format!("Couldn't open \"{}\": {e}", recent.name));
        }
    }
}

/// Removes the staging and set-aside folders an interrupted import left in the app folder. Nothing
/// can be using them when the app starts.
pub(crate) fn remove_stale_staging(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_dir() && (name.starts_with(".staging-") || name.starts_with(".trash-")) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// After the data folder of the open workspace changed (or its folder was renamed): re-point the
/// app at the database and move the lock along.
pub(crate) fn repoint_active(app: &tauri::AppHandle, ws_dir: &Path) -> Result<(), String> {
    let state = app.state::<ActiveWorkspaceState>();
    let mut active = lock_state(&state.0);
    // Release the old lock first: it may sit in a folder that's about to be renamed or emptied.
    *active = None;
    let data = data_dir(ws_dir);
    let lock = acquire_lock(&data)?;
    let db_str = data.join(DB_FILE).to_string_lossy().into_owned();
    *lock_state(&app.state::<crate::DbPathState>().0) = Some(db_str);
    *active = Some(ActiveWorkspace { ws_dir: ws_dir.to_path_buf(), _lock: lock });
    Ok(())
}

/// Lets go of the lock (and forgets the open workspace) so its folder can be renamed or moved.
pub(crate) fn release_active(app: &tauri::AppHandle) {
    *lock_state(&app.state::<ActiveWorkspaceState>().0) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("kinesis_ws_{name}_{}_{nanos}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_db(dir: &Path, workspace_name: Option<&str>) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let db_file = dir.join(DB_FILE);
        let s = db_file.to_string_lossy().to_string();
        db::init_db(&s).unwrap();
        if let Some(n) = workspace_name {
            force_workspace_name(&s, n).unwrap();
        }
        db_file
    }

    #[test]
    fn names_are_checked_as_folder_names() {
        assert_eq!(validate_name("  Metabolic   Warp Drive ").unwrap(), "Metabolic Warp Drive");
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        for reserved in ["CON", "nul", "Com1", "LPT9", "aux", "PRN"] {
            assert!(validate_name(reserved).is_err(), "{reserved}");
        }
        assert!(validate_name("Console").is_ok());
        for bad in ["a/b", "a\\b", "a:b", "a.b", "Research (2)", "Café"] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
        assert!(validate_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn sanitizing_always_yields_a_valid_name() {
        for raw in ["My-Drive_2024", "Café Ünïcode", "***", "", &"x".repeat(200), "CON"] {
            let s = sanitize_name(raw);
            assert!(validate_name(&s).is_ok(), "{raw:?} -> {s:?}");
        }
        assert_eq!(sanitize_name("My-Drive_2024"), "My Drive 2024");
    }

    #[test]
    fn a_taken_name_gets_a_number_ignoring_case() {
        let root = temp_root("unique");
        assert_eq!(unique_name(&root, "Research"), "Research");
        create(&root, "Research", None).unwrap();
        assert_eq!(unique_name(&root, "Research"), "Research 2");
        assert_eq!(unique_name(&root, "research"), "research 2");
        create(&root, "Research 2", None).unwrap();
        assert_eq!(unique_name(&root, "Research"), "Research 3");
        // The suffix never pushes a name past the limit.
        let long = "a".repeat(64);
        create(&root, &long, None).unwrap();
        assert!(validate_name(&unique_name(&root, &long)).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_makes_a_named_workspace_with_its_database_and_config() {
        let root = temp_root("create");
        let ws = create(&root, "  My   Research ", None).unwrap();
        assert_eq!(ws, root.join("My Research"));
        assert!(ws.join(DB_FILE).is_file());
        assert!(ws.join(CONF_FILE).is_file());
        let i = info(&ws);
        assert_eq!((i.name.as_str(), i.available, i.redirected), ("My Research", true, false));
        // Same name, different case: refused, and nothing was disturbed.
        assert!(create(&root, "my research", None).unwrap_err().contains("already exists"));
        assert!(create(&root, "NUL", None).is_err());
        // No staging leftovers.
        assert!(fs::read_dir(&root).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with('.')));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_workspace_can_live_on_another_drive_behind_a_redirect() {
        let root = temp_root("redirect_root");
        let drive = temp_root("redirect_drive");
        let ws = create(&root, "Portable", Some(&drive)).unwrap();
        assert!(!ws.join(DB_FILE).exists(), "the data is on the other drive");
        assert!(drive.join("Portable").join(DB_FILE).is_file());
        let i = info(&ws);
        assert!(i.redirected && i.available);
        assert_eq!(same_path(Path::new(&i.path), &drive.join("Portable")), true);

        // Unplugging the drive: still listed, marked unavailable, named after its folder.
        fs::remove_dir_all(&drive).unwrap();
        let listed = list(&root, false);
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].available);
        assert_eq!(listed[0].name, "Portable");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_build_leaves_nothing_behind() {
        let root = temp_root("failed");
        let drive = temp_root("failed_drive");
        let err = create_with(&root, "Broken", Some(&drive), |_| Err("boom".into())).unwrap_err();
        assert_eq!(err, "boom");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&drive).unwrap().count(), 0, "the folder we created on the drive is removed");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&drive);
    }

    #[test]
    fn a_data_folder_that_already_has_a_database_is_never_overwritten() {
        let root = temp_root("clobber");
        let drive = temp_root("clobber_drive");
        let existing = write_db(&drive.join("Mine"), Some("Mine"));
        let before = fs::metadata(&existing).unwrap().len();
        assert!(create(&root, "Mine", Some(&drive)).unwrap_err().contains("already contains"));
        assert_eq!(fs::metadata(&existing).unwrap().len(), before);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&drive);
    }

    #[test]
    fn opening_an_existing_database_registers_it_once() {
        let root = temp_root("register");
        let drive = temp_root("register_drive");
        write_db(&drive.join("stuff"), Some("Field Notes"));
        let picked = drive.join("stuff");

        let ws = register_existing(&root, &picked).unwrap();
        assert_eq!(ws, root.join("Field Notes"));
        let i = info(&ws);
        assert!(i.redirected && i.available);
        assert_eq!(i.name, "Field Notes");

        // Again (or via its own workspace folder): the same entry, no duplicate.
        assert_eq!(register_existing(&root, &picked).unwrap(), ws);
        assert_eq!(register_existing(&root, &ws).unwrap(), ws);
        assert_eq!(list(&root, true).len(), 1);

        // A name clash with a different database gets a number instead of merging.
        let other = drive.join("other");
        write_db(&other, Some("Field Notes"));
        let ws2 = register_existing(&root, &other).unwrap();
        assert_eq!(ws2, root.join("Field Notes 2"));

        // A folder without a database is an error, and creates nothing.
        let empty = drive.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(register_existing(&root, &empty).unwrap_err().contains("no Kinesis database"));
        assert_eq!(list(&root, true).len(), 2);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&drive);
    }

    #[test]
    fn removing_from_the_list_never_deletes_a_database() {
        let root = temp_root("forget");
        let drive = temp_root("forget_drive");
        let local = create(&root, "Local", None).unwrap();
        let external = create(&root, "External", Some(&drive)).unwrap();

        forget(&local).unwrap();
        assert!(local.join(DB_FILE).is_file(), "data stays; the entry is only hidden");
        assert!(list(&root, false).iter().all(|w| w.name != "Local"));
        assert!(list(&root, true).iter().any(|w| w.name == "Local"));
        // Opening it again brings it back.
        touch(&local);
        assert!(list(&root, false).iter().any(|w| w.name == "Local"));

        forget(&external).unwrap();
        assert!(drive.join("External").join(DB_FILE).is_file());
        assert!(!external.exists(), "a redirect stub has nothing else in it");
        // Re-adding it by path finds the database again.
        let back = register_existing(&root, &drive.join("External")).unwrap();
        assert_eq!(info(&back).name, "External");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&drive);
    }

    #[test]
    fn locating_a_moved_database_updates_the_redirect() {
        let root = temp_root("locate");
        let drive = temp_root("locate_drive");
        let ws = create(&root, "Movable", Some(&drive)).unwrap();
        let moved = temp_root("locate_new");
        fs::rename(drive.join("Movable").join(DB_FILE), {
            fs::create_dir_all(moved.join("m")).unwrap();
            moved.join("m").join(DB_FILE)
        })
        .unwrap();
        assert!(!info(&ws).available);
        assert!(relocate(&ws, &drive).unwrap_err().contains("no Kinesis database"));
        relocate(&ws, &moved.join("m")).unwrap();
        assert!(info(&ws).available);
        // Bringing it home removes the redirect.
        fs::rename(moved.join("m").join(DB_FILE), ws.join(DB_FILE)).unwrap();
        set_data_dir(&ws, &ws).unwrap();
        assert!(!is_redirected(&ws) && info(&ws).available);
        for d in [&root, &drive, &moved] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn renaming_checks_for_clashes_and_renames_the_folder() {
        let root = temp_root("rename");
        let a = create(&root, "Alpha", None).unwrap();
        create(&root, "Beta", None).unwrap();
        assert!(check_rename(&root, &a, "beta").unwrap_err().contains("already named"));
        assert!(check_rename(&root, &a, "CON").is_err());
        // Changing only the case of your own name is fine.
        assert_eq!(check_rename(&root, &a, "ALPHA").unwrap(), "ALPHA");
        let renamed = rename_folder(&root, &a, "Gamma").unwrap();
        assert_eq!(renamed, root.join("Gamma"));
        assert!(renamed.join(DB_FILE).is_file() && !a.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_old_install_in_the_default_place_is_moved_into_a_workspace() {
        let root = temp_root("legacy_default");
        write_db(&root, Some("Metabolic Warp Drive"));
        fs::write(root.join(CONF_FILE), "resolution: ignored\n").unwrap();
        let ws = migrate_legacy(&root).unwrap().unwrap();
        assert_eq!(ws, root.join("Metabolic Warp Drive"));
        assert!(ws.join(DB_FILE).is_file());
        assert!(!root.join(DB_FILE).exists(), "moved, not copied");
        assert!(root.join(LEGACY_CONF_BACKUP).is_file() && !root.join(CONF_FILE).exists());
        assert_eq!(info(&ws).name, "Metabolic Warp Drive");
        // Nothing left to adopt on the next start.
        assert!(migrate_legacy(&root).unwrap().is_none());
        assert_eq!(list(&root, false).len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_old_install_with_a_custom_location_is_left_where_it_is() {
        let root = temp_root("legacy_custom");
        let drive = temp_root("legacy_custom_drive");
        write_db(&drive, Some("On The Drive"));
        fs::write(root.join(CONF_FILE), format!("db_path: {}\n", drive.display())).unwrap();
        let ws = migrate_legacy(&root).unwrap().unwrap();
        let i = info(&ws);
        assert!(i.redirected && i.available);
        assert_eq!(i.name, "On The Drive");
        assert!(drive.join(DB_FILE).is_file(), "an external database is never moved");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&drive);
    }

    #[test]
    fn an_old_install_whose_drive_is_missing_does_not_get_an_empty_library() {
        let root = temp_root("legacy_missing");
        fs::write(root.join(CONF_FILE), "db_path: Z:\\definitely\\not\\here\n").unwrap();
        let ws = migrate_legacy(&root).unwrap().unwrap();
        assert!(!info(&ws).available);
        assert!(!root.join(DB_FILE).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_never_used_leftover_database_is_not_adopted_as_a_workspace() {
        // What an older installed Kinesis leaves behind every time it starts: an untouched database in
        // the app folder and an init.conf pointing at another untouched one.
        let root = temp_root("legacy_pristine");
        let drive = temp_root("legacy_pristine_drive");
        write_db(&root, None);
        write_db(&drive, None);
        fs::write(root.join(CONF_FILE), format!("db_path: {}
", drive.display())).unwrap();
        assert!(migrate_legacy(&root).unwrap().is_none());
        assert_eq!(list(&root, true).len(), 0, "nothing is added, so the launcher shows");
        assert!(root.join(CONF_FILE).is_file() && drive.join(DB_FILE).is_file(), "and nothing is moved or deleted");

        // No redirect, just the default database.
        fs::remove_file(root.join(CONF_FILE)).unwrap();
        assert!(migrate_legacy(&root).unwrap().is_none());
        assert!(root.join(DB_FILE).is_file());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&drive);
    }

    #[test]
    fn any_sign_of_use_makes_a_legacy_database_worth_adopting() {
        let cases: [(&str, &str); 4] = [
            ("a video", "INSERT INTO Videos (video_id, title) VALUES ('v', 'T')"),
            ("an API key", "INSERT INTO Settings (key, value) VALUES ('api_key', 'k')"),
            ("a theme", "INSERT INTO Settings (key, value) VALUES ('theme', 'light')"),
            ("a search", "INSERT INTO SearchHistory (search_query) VALUES ('q')"),
        ];
        for (what, sql) in cases {
            let root = temp_root("legacy_used");
            let db_file = write_db(&root, None);
            rusqlite::Connection::open(&db_file).unwrap().execute(sql, []).unwrap();
            let ws = migrate_legacy(&root).unwrap();
            assert!(ws.is_some(), "a database with {what} should be adopted");
            assert!(info(&ws.unwrap()).available);
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn the_same_database_is_not_adopted_twice() {
        let root = temp_root("legacy_twice");
        let drive = temp_root("legacy_twice_drive");
        write_db(&drive, Some("Only Once"));
        fs::write(root.join(CONF_FILE), format!("db_path: {}
", drive.display())).unwrap();
        let first = migrate_legacy(&root).unwrap().unwrap();
        // The older app writes the same pointer again on its next start.
        fs::write(root.join(CONF_FILE), format!("db_path: {}
", drive.display())).unwrap();
        assert!(migrate_legacy(&root).unwrap().is_none());
        assert_eq!(list(&root, true).len(), 1);
        assert_eq!(list(&root, true)[0].folder, first.file_name().unwrap().to_string_lossy());
        assert!(!root.join(CONF_FILE).exists(), "the repeated pointer is retired");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&drive);
    }

    #[test]
    fn a_workspace_is_found_by_name_ignoring_case_but_other_folders_are_not() {
        let root = temp_root("find");
        let ws = create(&root, "Field Notes", None).unwrap();
        assert_eq!(find_workspace(&root, "field notes"), Some(ws.clone()));
        assert_eq!(find_workspace(&root, "Field Notes 2"), None);
        // Removed from the list, it's still the workspace with that name.
        forget(&ws).unwrap();
        assert_eq!(find_workspace(&root, "Field Notes"), Some(ws));
        // A folder the app keeps for itself is taken as a name, but isn't a workspace to add to.
        fs::create_dir_all(root.join("storage")).unwrap();
        assert!(name_taken(&root, "storage"));
        assert_eq!(find_workspace(&root, "storage"), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_workspace_is_recognized_by_the_name_it_shows_not_only_by_its_folder() {
        let root = temp_root("shown_name");
        let drive = temp_root("shown_name_drive");
        // A database that lives elsewhere (say Downloads), opened once so Kinesis knows it. Its folder
        // here is named after the database's own name.
        write_db(&drive.join("Downloads copy"), Some("Metabolic Warp Drive"));
        let ws = register_existing(&root, &drive.join("Downloads copy")).unwrap();
        assert_eq!(find_workspace(&root, "metabolic warp drive"), Some(ws.clone()));

        // The folder and the shown name drift apart (a rename that couldn't move the folder). A kinpak
        // carries the shown name, and must still land in this workspace, not make a second one.
        let other = create(&root, "Old Folder Name", None).unwrap();
        force_workspace_name(&other.join(DB_FILE).to_string_lossy(), "Brand New Name").unwrap();
        assert_eq!(info(&other).name, "Brand New Name");
        assert_eq!(find_workspace(&root, "Brand New Name"), Some(other.clone()));
        assert!(name_taken(&root, "Brand New Name"));
        assert!(create(&root, "Brand New Name", None).unwrap_err().contains("already exists"));
        // And it can't be renamed onto by another workspace either.
        assert!(check_rename(&root, &ws, "Brand New Name").is_err());
        assert!(check_rename(&root, &other, "brand new name").is_ok(), "its own name, in another case, is fine");

        // Drive unplugged: still found (by its folder name), so a kinpak is refused, not duplicated.
        fs::remove_dir_all(&drive).unwrap();
        assert_eq!(find_workspace(&root, "Metabolic Warp Drive"), Some(ws));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_interrupted_build_leaves_no_workspace_and_does_not_block_trying_again() {
        let root = temp_root("interrupted");
        let drive = temp_root("interrupted_drive");
        // The app closed part-way through an import to another drive: half a database under its
        // temporary name, and a staging folder in the app folder.
        let data = drive.join("Big Library");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join(DB_PART), "half a database").unwrap();
        fs::write(data.join(format!("{DB_PART}-journal")), "journal").unwrap();
        fs::create_dir_all(root.join(".staging-123")).unwrap();
        fs::write(root.join(".staging-123").join("x"), "y").unwrap();

        // Nothing there looks like a workspace...
        assert_eq!(list(&root, true).len(), 0);
        assert!(!data.join(DB_FILE).exists());
        // ...the next start clears the staging folder...
        remove_stale_staging(&root);
        assert!(!root.join(".staging-123").exists());
        // ...and trying again in the same place works.
        let ws = create(&root, "Big Library", Some(&drive)).unwrap();
        assert!(info(&ws).available && data.join(DB_FILE).is_file());
        assert!(!data.join(DB_PART).exists() && !data.join(format!("{DB_PART}-journal")).exists());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&drive);
    }

    #[test]
    fn only_real_workspace_folders_are_listed_newest_first() {
        let root = temp_root("list");
        let a = create(&root, "Old One", None).unwrap();
        let b = create(&root, "New One", None).unwrap();
        fs::create_dir_all(root.join("EBWebView")).unwrap();
        fs::write(root.join("EBWebView").join("junk"), "x").unwrap();
        update_conf(&a, |m| { m.insert(KEY_LAST_OPENED.into(), "100".into()); }).unwrap();
        update_conf(&b, |m| { m.insert(KEY_LAST_OPENED.into(), "200".into()); }).unwrap();
        let names: Vec<String> = list(&root, false).into_iter().map(|w| w.name).collect();
        assert_eq!(names, vec!["New One", "Old One"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_lock_on_the_same_workspace_is_refused() {
        let root = temp_root("lock");
        let ws = create(&root, "Locked", None).unwrap();
        let first = acquire_lock(&ws).unwrap();
        assert!(first.is_some());
        assert!(acquire_lock(&ws).unwrap_err().contains("already open"));
        drop(first);
        assert!(acquire_lock(&ws).unwrap().is_some());
        let _ = fs::remove_dir_all(&root);
    }
}
