//! End-to-end tests of the sync engine against an in-process mock server.

use super::*;
use crate::db::init_db;
use kinesis_sync_proto::{ChangesPage, Item, Policy, Tombstone};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// A stand-in sync server: an append-only event log, folded into "latest state per key" and
/// served as `rev > since` pages of 2, the same shape the reference server produces.
#[derive(Default)]
struct Mock {
    events: Vec<(u64, String, String, Option<Value>)>,
    retention: u64,
    token: Option<String>,
    policy: Policy,
}

impl Mock {
    fn head(&self) -> u64 {
        self.events.last().map(|e| e.0).unwrap_or(0)
    }

    fn upsert(&mut self, kind: &str, key: &str, data: Value) {
        let rev = self.head() + 1;
        self.events.push((rev, kind.into(), key.into(), Some(data)));
    }

    fn delete(&mut self, kind: &str, key: &str) {
        let rev = self.head() + 1;
        self.events.push((rev, kind.into(), key.into(), None));
    }

    fn changes(&self, since: u64, snapshot: bool) -> ChangesPage {
        let mut latest: BTreeMap<(String, String), (u64, Option<Value>)> = BTreeMap::new();
        for (rev, kind, key, data) in &self.events {
            latest.insert((kind.clone(), key.clone()), (*rev, data.clone()));
        }
        let mut entries: Vec<_> = latest
            .into_iter()
            .filter(|(_, (rev, data))| *rev > since && (data.is_some() || !snapshot))
            .collect();
        entries.sort_by_key(|(_, (rev, _))| *rev);
        let has_more = entries.len() > 2;
        entries.truncate(2);
        // The final page reports the server head so the client's cursor lands on it.
        let revision = if has_more {
            entries.last().map(|(_, (rev, _))| *rev).unwrap_or(self.head())
        } else {
            self.head()
        };
        let mut page = ChangesPage { revision, has_more, upserts: vec![], deletes: vec![] };
        for ((kind, key), (rev, data)) in entries {
            match data {
                Some(data) => page.upserts.push(Item { kind, key, rev: Some(rev), hash: String::new(), data }),
                None => page.deletes.push(Tombstone { kind, key, rev }),
            }
        }
        page
    }
}

fn serve(mock: Arc<Mutex<Mock>>) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let (status, body) = {
                let m = mock.lock().unwrap();
                let auth = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Authorization"))
                    .map(|h| h.value.as_str().to_string());
                let url = req.url().to_string();
                let token_ok = match &m.token {
                    Some(t) => auth.as_deref() == Some(format!("Bearer {t}").as_str()),
                    None => true,
                };
                if !token_ok {
                    (401, json!({"error": "unauthorized"}).to_string())
                } else if url.starts_with("/api/v1/manifest") {
                    (
                        200,
                        json!({
                            "server_name": "Mock Server", "protocol_version": 1, "pack_version": 1,
                            "revision": m.head(), "retention_revision": m.retention,
                            "capabilities": {"content": true, "policy": true, "license": ["venice"]},
                            "license_mode": "fallback"
                        })
                        .to_string(),
                    )
                } else if url.starts_with("/api/v1/changes") {
                    let since: u64 = url
                        .split("since=")
                        .nth(1)
                        .and_then(|s| s.split('&').next())
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    let snapshot = url.contains("snapshot=1");
                    if !snapshot && since > 0 && since < m.retention {
                        (410, json!({"error": "resync_required"}).to_string())
                    } else {
                        (200, serde_json::to_string(&m.changes(since, snapshot)).unwrap())
                    }
                } else if url.starts_with("/api/v1/policy") {
                    (200, serde_json::to_string(&m.policy).unwrap())
                } else {
                    (404, "{}".to_string())
                }
            };
            let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status).with_header(header));
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn temp_db(name: &str) -> String {
    let path = std::env::temp_dir().join(format!("kinesis_engine_{}_{}.db", name, std::process::id()));
    let _ = std::fs::remove_file(&path);
    let p = path.to_string_lossy().to_string();
    init_db(&p).unwrap();
    p
}

fn connect(db_path: &str, url: &str, token: Option<&str>) {
    db::set_setting(db_path, KEY_URL, url).unwrap();
    if let Some(t) = token {
        db::set_setting(db_path, KEY_TOKEN, t).unwrap();
    }
}

fn count(db_path: &str, sql: &str) -> i64 {
    Connection::open(db_path).unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}

#[tokio::test]
async fn syncs_pages_then_deltas_then_recovers_from_a_pruned_cursor() {
    let mock = Arc::new(Mutex::new(Mock::default()));
    {
        let mut m = mock.lock().unwrap();
        m.token = Some("sekret".into());
        for n in 1..=5 {
            m.upsert("glossary", &format!("term{n}"), json!({"definition": format!("def {n}")}));
        }
        m.policy.settings.insert("showBiography".into(), "false".into());
        m.policy.settings.insert("venice_api_key".into(), "stolen".into());
        m.policy.locked = vec!["showBiography".into(), "venice_api_key".into()];
    }
    let url = serve(mock.clone());
    let db_path = temp_db("flow");
    connect(&db_path, &url, Some("sekret"));
    let state = SyncState::default();

    // First sync: a snapshot, delivered across several pages.
    let r = run_core(&db_path, &state, false, |_| {}).await.unwrap();
    assert!(r.full);
    assert!(r.pages >= 3, "5 items at 2 per page: {r:?}");
    assert_eq!(r.upserted, 5);
    assert_eq!(count(&db_path, "SELECT COUNT(*) FROM Glossary"), 5);
    assert_eq!(status(&db_path, &state).unwrap().cursor, 5);
    assert_eq!(r.policy_applied, 1);
    assert_eq!(r.policy_dropped, 1, "the api key entry must be refused");
    assert_eq!(db::get_setting(&db_path, "showBiography").unwrap().as_deref(), Some("false"));
    assert_eq!(count(&db_path, "SELECT COUNT(*) FROM SyncPolicy WHERE key='venice_api_key'"), 0);
    let st = status(&db_path, &state).unwrap();
    assert_eq!(st.server_name, "Mock Server");
    assert_eq!(st.license.providers, vec!["venice".to_string()]);
    assert_eq!(st.locked_settings, vec!["showBiography".to_string()]);
    assert_eq!(st.owned_counts.get("glossary"), Some(&5));

    // A local row the server has never heard of.
    Connection::open(&db_path)
        .unwrap()
        .execute("INSERT INTO Glossary (term, definition) VALUES ('mine', 'local')", [])
        .unwrap();

    // Delta: one edit, one delete, one addition.
    {
        let mut m = mock.lock().unwrap();
        m.upsert("glossary", "term1", json!({"definition": "edited"}));
        m.delete("glossary", "term2");
        m.upsert("glossary", "term6", json!({"definition": "def 6"}));
    }
    let r = run_core(&db_path, &state, false, |_| {}).await.unwrap();
    assert!(!r.full, "an up-to-date cursor should sync incrementally");
    assert_eq!(r.upserted, 2);
    assert_eq!(r.deleted, 1);
    assert_eq!(count(&db_path, "SELECT COUNT(*) FROM Glossary WHERE term='term2'"), 0);
    assert_eq!(count(&db_path, "SELECT COUNT(*) FROM Glossary WHERE definition='edited'"), 1);
    assert_eq!(count(&db_path, "SELECT COUNT(*) FROM Glossary WHERE term='mine'"), 1);

    // Nothing new: a no-op sync.
    let r = run_core(&db_path, &state, false, |_| {}).await.unwrap();
    assert_eq!((r.upserted, r.deleted), (0, 0));

    // The server prunes history past our cursor and has dropped term3 in the meantime: the
    // client falls back to a snapshot and sweeps what is gone.
    {
        let mut m = mock.lock().unwrap();
        m.delete("glossary", "term3");
        m.retention = m.head();
    }
    let r = run_core(&db_path, &state, false, |_| {}).await.unwrap();
    assert!(r.full, "410 must trigger a snapshot");
    assert_eq!(count(&db_path, "SELECT COUNT(*) FROM Glossary WHERE term='term3'"), 0);
    assert_eq!(count(&db_path, "SELECT COUNT(*) FROM Glossary WHERE term='mine'"), 1);
    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn wrong_token_is_reported_and_recorded() {
    let mock = Arc::new(Mutex::new(Mock { token: Some("right".into()), ..Default::default() }));
    let url = serve(mock);
    let db_path = temp_db("auth");
    connect(&db_path, &url, Some("wrong"));
    let err = run_core(&db_path, &SyncState::default(), false, |_| {}).await.unwrap_err();
    assert!(err.contains("rejected"), "{err}");
    assert!(status(&db_path, &SyncState::default()).unwrap().last_error.contains("rejected"));
    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test]
async fn not_connected_and_concurrent_runs_are_refused() {
    let db_path = temp_db("guard");
    let state = SyncState::default();
    let err = run_core(&db_path, &state, false, |_| {}).await.unwrap_err();
    assert!(err.contains("Not connected"), "{err}");

    state.running.store(true, Ordering::SeqCst);
    let err = run_core(&db_path, &state, false, |_| {}).await.unwrap_err();
    assert!(err.contains("already running"), "{err}");
    let _ = std::fs::remove_file(&db_path);
}

#[test]
fn disconnect_forgets_the_server_and_restores_local_settings() {
    let db_path = temp_db("disc");
    connect(&db_path, "http://127.0.0.1:1", Some("t"));
    db::set_setting(&db_path, "showDrive", "true").unwrap();
    Connection::open(&db_path)
        .unwrap()
        .execute("INSERT INTO SyncPolicy (key, value, locked) VALUES ('showDrive', 'false', 1)", [])
        .unwrap();
    assert_eq!(db::get_setting(&db_path, "showDrive").unwrap().as_deref(), Some("false"));

    disconnect(&db_path, true).unwrap();
    assert!(load_config(&db_path).is_none());
    assert_eq!(db::get_setting(&db_path, "showDrive").unwrap().as_deref(), Some("true"));
    assert!(db::get_setting(&db_path, KEY_TOKEN).unwrap().is_none());
    let _ = std::fs::remove_file(&db_path);
}
