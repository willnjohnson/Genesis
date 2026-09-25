//! The server's own bookkeeping: a revision log over the master database.
//!
//! The master database (the admin's Kinesis DB) is never modified and needs no schema changes.
//! Instead each scan hashes every syncable row and records `(kind, key) -> (hash, rev, deleted)`
//! here. A changed hash gets a new, higher revision; a row that disappeared becomes a tombstone.
//! Only hashes are stored: row contents are read from the master at serve time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use kinesis_sync_proto::sqlite::{self, ReadOptions};
use kinesis_sync_proto::{content_hash, Kind};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

/// Below this many live items the mass-removal safety check doesn't apply (small catalogues can
/// legitimately be emptied and rebuilt).
const MASS_REMOVAL_MIN_ITEMS: usize = 20;

pub struct Store {
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub kind: String,
    pub key: String,
    pub rev: u64,
    pub deleted: bool,
}

#[derive(Debug)]
pub struct Page {
    pub entries: Vec<Entry>,
    pub has_more: bool,
    pub revision: u64,
}

#[derive(Debug)]
pub enum PageResult {
    Page(Page),
    /// The client's cursor predates retained history.
    ResyncRequired,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanStats {
    pub changed: u64,
    pub removed: u64,
    pub head: u64,
}

fn e(err: rusqlite::Error) -> String {
    err.to_string()
}

/// Opens the admin's database read-only.
pub fn open_master(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|err| format!("can't open master database {}: {err}", path.display()))?;
    conn.busy_timeout(Duration::from_secs(10)).map_err(e)?;
    Ok(conn)
}

fn meta(conn: &Connection, key: &str) -> u64 {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn set_meta(conn: &Connection, key: &str, value: u64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )
    .map_err(e)?;
    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        let store = Store { path: path.to_path_buf() };
        let conn = store.conn()?;
        // WAL lets /changes readers keep reading while a scan commits.
        let _ = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0));
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS rev_log (
                kind     TEXT NOT NULL,
                item_key TEXT NOT NULL,
                hash     TEXT NOT NULL,
                rev      INTEGER NOT NULL,
                deleted  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (kind, item_key)
             );
             CREATE INDEX IF NOT EXISTS idx_rev_log_rev ON rev_log (rev);
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             -- Names this revision history. A fresh (or deleted-and-recreated) state database gets a
             -- new one, which tells clients their saved revision numbers no longer apply.
             INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', lower(hex(randomblob(16))));",
        )
        .map_err(e)?;
        Ok(store)
    }

    /// The identity of this revision history (see `Manifest::epoch`).
    pub fn epoch(&self) -> Result<String, String> {
        let conn = self.conn()?;
        conn.query_row("SELECT value FROM meta WHERE key = 'epoch'", [], |r| r.get::<_, String>(0)).map_err(e)
    }

    fn conn(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.path).map_err(|err| format!("can't open state database {}: {err}", self.path.display()))?;
        conn.busy_timeout(Duration::from_secs(10)).map_err(e)?;
        Ok(conn)
    }

    /// `(head revision, retention revision)`.
    pub fn revisions(&self) -> Result<(u64, u64), String> {
        let conn = self.conn()?;
        Ok((meta(&conn, "head"), meta(&conn, "retention_revision")))
    }

    /// Rescans the master database and records what changed. All-or-nothing: an error (busy
    /// database, refused mass removal) leaves the log untouched.
    pub fn scan(&self, master: &Connection, retention_revisions: u64, allow_mass_removal: bool) -> Result<ScanStats, String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(e)?;

        let head = meta(&tx, "head");
        let mut known: HashMap<(String, String), (String, bool)> = HashMap::new();
        {
            let mut stmt = tx.prepare("SELECT kind, item_key, hash, deleted FROM rev_log").map_err(e)?;
            let rows = stmt
                .query_map([], |r| Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), (r.get::<_, String>(2)?, r.get::<_, i64>(3)? != 0))))
                .map_err(e)?;
            for row in rows {
                let (k, v) = row.map_err(e)?;
                known.insert(k, v);
            }
        }
        let live_before = known.values().filter(|(_, deleted)| !deleted).count();

        let opts = ReadOptions::default();
        let mut next = head;
        let mut changed = 0u64;
        for kind in Kind::APPLY_ORDER {
            sqlite::for_each_item(master, kind, &opts, |key, data| {
                let hash = content_hash(kind.as_str(), key, &data);
                let same = matches!(
                    known.remove(&(kind.as_str().to_string(), key.to_string())),
                    Some((old, false)) if old == hash
                );
                if !same {
                    next += 1;
                    changed += 1;
                    tx.execute(
                        "INSERT INTO rev_log (kind, item_key, hash, rev, deleted) VALUES (?1, ?2, ?3, ?4, 0)
                         ON CONFLICT(kind, item_key) DO UPDATE SET hash = excluded.hash, rev = excluded.rev, deleted = 0",
                        params![kind.as_str(), key, hash, next as i64],
                    )
                    .map_err(e)?;
                }
                Ok(())
            })?;
        }

        // Whatever is still in `known` wasn't in the master this time around.
        let vanished: Vec<(String, String)> =
            known.into_iter().filter(|(_, (_, deleted))| !deleted).map(|(k, _)| k).collect();
        if !allow_mass_removal && live_before >= MASS_REMOVAL_MIN_ITEMS && vanished.len() * 2 > live_before {
            return Err(format!(
                "refusing to remove {} of {} items in one scan: is master_db pointing at the right (and complete) database? \
                 Set allow_mass_removal = true to confirm an intentional cleanup.",
                vanished.len(),
                live_before
            ));
        }
        for (kind, key) in &vanished {
            next += 1;
            tx.execute(
                "UPDATE rev_log SET rev = ?3, deleted = 1 WHERE kind = ?1 AND item_key = ?2",
                params![kind, key, next as i64],
            )
            .map_err(e)?;
        }

        // Forget old tombstones; clients that far behind will be told to resync.
        if next > retention_revisions {
            let cutoff = next - retention_revisions;
            let newest_pruned: Option<i64> = tx
                .query_row("SELECT MAX(rev) FROM rev_log WHERE deleted = 1 AND rev <= ?1", params![cutoff as i64], |r| r.get(0))
                .optional()
                .map_err(e)?
                .flatten();
            if let Some(rev) = newest_pruned {
                tx.execute("DELETE FROM rev_log WHERE deleted = 1 AND rev <= ?1", params![cutoff as i64]).map_err(e)?;
                let existing = meta(&tx, "retention_revision");
                set_meta(&tx, "retention_revision", existing.max(rev as u64))?;
            }
        }

        if next != head {
            set_meta(&tx, "head", next)?;
        }
        tx.commit().map_err(e)?;
        Ok(ScanStats { changed, removed: vanished.len() as u64, head: next })
    }

    /// One page of changes with `rev > since`, ordered by revision.
    pub fn page(&self, since: u64, limit: usize, snapshot: bool) -> Result<PageResult, String> {
        let mut conn = self.conn()?;
        // A read transaction, so head and the rows come from the same snapshot.
        let tx = conn.transaction().map_err(e)?;
        let head = meta(&tx, "head");
        let retention = meta(&tx, "retention_revision");
        if !snapshot && (since < retention || since > head) {
            return Ok(PageResult::ResyncRequired);
        }
        let mut stmt = tx
            .prepare(
                "SELECT kind, item_key, rev, deleted FROM rev_log
                 WHERE rev > ?1 AND (?2 = 0 OR deleted = 0) ORDER BY rev LIMIT ?3",
            )
            .map_err(e)?;
        let mut entries: Vec<Entry> = stmt
            .query_map(params![since as i64, snapshot as i64, (limit + 1) as i64], |r| {
                Ok(Entry { kind: r.get(0)?, key: r.get(1)?, rev: r.get::<_, i64>(2)? as u64, deleted: r.get::<_, i64>(3)? != 0 })
            })
            .map_err(e)?
            .filter_map(|r| r.ok())
            .collect();
        let has_more = entries.len() > limit;
        entries.truncate(limit);
        // Mid-stream the cursor is the last entry; on the final page it is the head, which is where
        // the client's cursor should land.
        let revision = if has_more { entries.last().map(|x| x.rev).unwrap_or(head) } else { head };
        Ok(PageResult::Page(Page { entries, has_more, revision }))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A minimal stand-in for a Kinesis database: just the tables the readers query.
    pub fn make_master(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS Videos (video_id TEXT PRIMARY KEY, title TEXT, author TEXT, handle TEXT, length_seconds INTEGER,
                transcript TEXT, summary TEXT, view_count INTEGER, published_at TEXT, tags TEXT, WDBS TEXT);
             CREATE TABLE IF NOT EXISTS tblWDBS (WDBS TEXT PRIMARY KEY, lev INTEGER, WDID TEXT, WDInfo TEXT, WDIcon TEXT, WDDefault INTEGER);
             CREATE TABLE IF NOT EXISTS VideoWDBSLinks (video_id TEXT NOT NULL, wdbs TEXT NOT NULL, PRIMARY KEY (video_id, wdbs));
             CREATE TABLE IF NOT EXISTS Glossary (term TEXT NOT NULL, definition TEXT NOT NULL, drives TEXT NOT NULL DEFAULT '', PRIMARY KEY (term, drives));
             CREATE TABLE IF NOT EXISTS Biographies (handle TEXT PRIMARY KEY, display_name TEXT, bio TEXT, wikipedia TEXT, website TEXT,
                twitter TEXT, instagram TEXT, facebook TEXT, threads TEXT, youtube TEXT, tiktok TEXT, twitch TEXT, reddit TEXT,
                discord TEXT, channel_id TEXT, subscriber_count INTEGER);
             CREATE TABLE IF NOT EXISTS CustomPrompts (handle TEXT PRIMARY KEY, local_prompt_text TEXT, cloud_prompt_text TEXT);
             CREATE TABLE IF NOT EXISTS Settings (key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
        conn
    }

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kinesis_sync_server_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture(name: &str) -> (Store, Connection, PathBuf) {
        let dir = temp_dir(name);
        let master_path = dir.join("master.db");
        let master = make_master(&master_path);
        let store = Store::open(&dir.join("state.db")).unwrap();
        (store, master, dir)
    }

    fn ids(page: &Page) -> Vec<String> {
        page.entries.iter().map(|x| format!("{}:{}{}", x.kind, x.key, if x.deleted { "!" } else { "" })).collect()
    }

    fn page(store: &Store, since: u64, limit: usize, snapshot: bool) -> Page {
        match store.page(since, limit, snapshot).unwrap() {
            PageResult::Page(p) => p,
            PageResult::ResyncRequired => panic!("unexpected resync"),
        }
    }

    #[test]
    fn first_scan_assigns_revisions_and_unchanged_rescans_do_nothing() {
        let (store, master, dir) = fixture("scan");
        master.execute("INSERT INTO Glossary (term, definition) VALUES ('a', 'one'), ('b', 'two')", []).unwrap();
        master.execute("INSERT INTO Videos (video_id, title) VALUES ('v1', 'T')", []).unwrap();

        let stats = store.scan(&master, 1000, false).unwrap();
        assert_eq!(stats, ScanStats { changed: 3, removed: 0, head: 3 });
        assert_eq!(store.scan(&master, 1000, false).unwrap(), ScanStats { changed: 0, removed: 0, head: 3 }, "no change, no new revisions");

        master.execute("UPDATE Glossary SET definition = 'ONE' WHERE term = 'a'", []).unwrap();
        let stats = store.scan(&master, 1000, false).unwrap();
        assert_eq!((stats.changed, stats.head), (1, 4));
        let p = page(&store, 3, 10, false);
        assert_eq!(ids(&p), vec!["glossary:|a"]);
        assert_eq!(p.revision, 4);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pages_are_ordered_and_the_last_page_reports_head() {
        let (store, master, dir) = fixture("paging");
        for n in 1..=5 {
            master.execute("INSERT INTO Glossary (term, definition) VALUES (?1, 'd')", params![format!("t{n}")]).unwrap();
        }
        store.scan(&master, 1000, false).unwrap();

        let p1 = page(&store, 0, 2, true);
        assert_eq!((p1.entries.len(), p1.has_more, p1.revision), (2, true, 2));
        let p2 = page(&store, p1.revision, 2, true);
        assert_eq!((p2.entries.len(), p2.has_more, p2.revision), (2, true, 4));
        let p3 = page(&store, p2.revision, 2, true);
        assert_eq!((p3.entries.len(), p3.has_more, p3.revision), (1, false, 5));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn removals_become_tombstones_that_snapshots_omit() {
        let (store, master, dir) = fixture("tomb");
        master.execute("INSERT INTO Glossary (term, definition) VALUES ('a', '1'), ('b', '2')", []).unwrap();
        store.scan(&master, 1000, false).unwrap();
        master.execute("DELETE FROM Glossary WHERE term = 'a'", []).unwrap();
        let stats = store.scan(&master, 1000, false).unwrap();
        assert_eq!((stats.removed, stats.head), (1, 3));

        assert_eq!(ids(&page(&store, 2, 10, false)), vec!["glossary:|a!"], "a delta carries the tombstone");
        assert_eq!(ids(&page(&store, 0, 10, true)), vec!["glossary:|b"], "a snapshot only lists what exists");

        // Re-adding the row revives it under a fresh revision.
        master.execute("INSERT INTO Glossary (term, definition) VALUES ('a', '1')", []).unwrap();
        store.scan(&master, 1000, false).unwrap();
        assert_eq!(ids(&page(&store, 3, 10, false)), vec!["glossary:|a"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn old_tombstones_are_pruned_and_stale_clients_must_resync() {
        let (store, master, dir) = fixture("retention");
        master.execute("INSERT INTO Glossary (term, definition) VALUES ('a', '1'), ('b', '2'), ('c', '3')", []).unwrap();
        store.scan(&master, 4, false).unwrap(); // head 3
        master.execute("DELETE FROM Glossary WHERE term = 'a'", []).unwrap();
        store.scan(&master, 4, false).unwrap(); // tombstone at rev 4, head 4
        for n in 0..3 {
            master.execute("INSERT INTO Glossary (term, definition) VALUES (?1, 'x')", params![format!("n{n}")]).unwrap();
        }
        let stats = store.scan(&master, 4, false).unwrap(); // head 7, cutoff 3... tombstone at 4 kept
        assert_eq!(stats.head, 7);
        for n in 3..6 {
            master.execute("INSERT INTO Glossary (term, definition) VALUES (?1, 'x')", params![format!("n{n}")]).unwrap();
        }
        store.scan(&master, 4, false).unwrap(); // head 10, cutoff 6: the tombstone at 4 is pruned
        let (head, retention) = store.revisions().unwrap();
        assert_eq!((head, retention), (10, 4));

        assert!(matches!(store.page(2, 10, false).unwrap(), PageResult::ResyncRequired), "cursor before the pruned tombstone");
        assert!(matches!(store.page(4, 10, false).unwrap(), PageResult::Page(_)), "cursor at the retention edge is fine");
        assert!(matches!(store.page(99, 10, false).unwrap(), PageResult::ResyncRequired), "cursor ahead of the server");
        assert!(matches!(store.page(2, 10, true).unwrap(), PageResult::Page(_)), "snapshots never 410");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_epoch_survives_restarts_but_not_a_reset_state_database() {
        let dir = temp_dir("epoch");
        let path = dir.join("state.db");
        let first = Store::open(&path).unwrap().epoch().unwrap();
        assert_eq!(first.len(), 32, "{first}");
        assert_eq!(Store::open(&path).unwrap().epoch().unwrap(), first, "reopening keeps the same history");

        // Scans (which change revisions) don't change the epoch.
        let master = make_master(&dir.join("master.db"));
        master.execute("INSERT INTO Glossary (term, definition) VALUES ('a', '1')", []).unwrap();
        let store = Store::open(&path).unwrap();
        store.scan(&master, 1000, false).unwrap();
        assert_eq!(store.epoch().unwrap(), first);

        // Deleting the state database starts a new history.
        drop(store);
        std::fs::remove_file(&path).unwrap();
        let _ = std::fs::remove_file(dir.join("state.db-wal"));
        let _ = std::fs::remove_file(dir.join("state.db-shm"));
        assert_ne!(Store::open(&path).unwrap().epoch().unwrap(), first);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_scan_that_would_wipe_the_catalogue_is_refused() {
        let (store, master, dir) = fixture("mass");
        for n in 0..30 {
            master.execute("INSERT INTO Glossary (term, definition) VALUES (?1, 'd')", params![format!("t{n}")]).unwrap();
        }
        store.scan(&master, 1000, false).unwrap();
        master.execute("DELETE FROM Glossary", []).unwrap(); // e.g. master_db now points at an empty database

        let err = store.scan(&master, 1000, false).unwrap_err();
        assert!(err.contains("refusing to remove 30 of 30"), "{err}");
        assert_eq!(store.revisions().unwrap().0, 30, "a refused scan leaves the log untouched");

        let stats = store.scan(&master, 1000, true).unwrap();
        assert_eq!(stats.removed, 30);
        let _ = std::fs::remove_dir_all(dir);
    }
}
