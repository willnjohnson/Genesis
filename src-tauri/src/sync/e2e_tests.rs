//! The real client engine against the real reference server, with the server's master database
//! built by Kinesis's own `init_db`. This is what proves the two halves agree on the wire format,
//! and that the server's row readers work against the actual schema (triggers, FTS and all).

use super::*;
use super::license;
use crate::db::init_db;
use kinesis_sync_server::config::{Config, PolicyConfig, ProviderConfig, Providers, TokenConfig};
use kinesis_sync_server::{build_state, scan_once, serve};
use rusqlite::Connection;

const TOKEN: &str = "0123456789abcdef-e2e-token";

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kinesis_e2e_{}_{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn start_server(dir: &std::path::Path, master: &str) -> (String, std::sync::Arc<kinesis_sync_server::AppState>) {
    let config = Config {
        bind: "127.0.0.1:0".into(),
        server_name: "E2E Library".into(),
        master_db: master.into(),
        state_db: dir.join("state.db"),
        scan_interval_secs: 0,
        retention_revisions: 1000,
        page_max: 3, // tiny pages, so multi-page paths are exercised
        min_client_version: String::new(),
        license_mode: "fallback".into(),
        proxy_rate_limit_per_minute: 0,
        allow_mass_removal: false,
        allow_anonymous: false,
        policy: PolicyConfig { enforced: vec!["showBiography".into(), "plugin_summarize_enabled".into()] },
        tokens: vec![TokenConfig { name: "e2e".into(), token: TOKEN.into(), licenses: vec!["venice".into()] }],
        providers: Providers {
            venice: ProviderConfig { api_key: Some("REAL-VENICE-KEY".into()), api_key_env: None, base_url: None },
            ..Default::default()
        },
    };
    config.validate().unwrap();
    let state = build_state(config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let serving = state.clone();
    tokio::spawn(async move {
        serve(listener, serving).await.unwrap();
    });
    (format!("http://{addr}"), state)
}

fn q(db_path: &str, sql: &str) -> Option<String> {
    Connection::open(db_path).unwrap().query_row(sql, [], |r| r.get::<_, Option<String>>(0)).unwrap()
}

fn n(db_path: &str, sql: &str) -> i64 {
    Connection::open(db_path).unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}

#[tokio::test]
async fn a_client_syncs_a_real_kinesis_master_through_the_reference_server() {
    let dir = temp("flow");
    let master = dir.join("master.db").to_string_lossy().to_string();
    let client = dir.join("client.db").to_string_lossy().to_string();
    init_db(&master).unwrap();
    init_db(&client).unwrap();

    // ── The admin curates the master with plain SQL (the app itself does the same underneath).
    {
        let m = Connection::open(&master).unwrap();
        m.execute("INSERT OR IGNORE INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDIcon, WDDefault) VALUES (':UAP', 1, 'UAP', 'UAP', '', 0)", []).unwrap();
        m.execute("INSERT OR IGNORE INTO tblWDBS (WDBS, lev, WDID, WDInfo, WDIcon, WDDefault) VALUES (':UAP-GERB', 2, 'GERB', 'Gerb Alias', 'star', 0)", []).unwrap();
        for i in 1..=4 {
            m.execute(
                "INSERT INTO Videos (video_id, title, author, handle, length_seconds, transcript, view_count, published_at, tags, WDBS)
                 VALUES (?1, ?2, 'Author', '@auth', 120, ?3, 1000, '2024-05-06', 'a,b', 'θψUAP_GERB')",
                rusqlite::params![format!("vid{i}"), format!("Video {i}"), format!("transcript number {i} about saucers")],
            )
            .unwrap();
        }
        m.execute("INSERT INTO VideoWDBSLinks (video_id, wdbs) VALUES ('vid1', 'θψCRYPTO')", []).unwrap();
        m.execute("INSERT INTO Glossary (term, definition) VALUES ('saucer', 'a flying disc')", []).unwrap();
        m.execute("INSERT INTO GlossaryDrives (term, root) VALUES ('saucer', ':UAP')", []).unwrap();
        m.execute("INSERT OR REPLACE INTO Biographies (handle, display_name, bio, subscriber_count) VALUES ('@auth', 'Author', 'Bio text', 4200)", []).unwrap();
        m.execute("INSERT INTO CustomPrompts (handle, local_prompt_text, cloud_prompt_text) VALUES ('@auth', 'local p', 'cloud p')", []).unwrap();
        m.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('showBiography', 'false')", []).unwrap();
        m.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('plugin_summarize_enabled', 'true')", []).unwrap();
        m.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('venice_api_key', 'MASTER-SECRET')", []).unwrap();
    }
    let (url, server) = start_server(&dir, &master).await;
    scan_once(&server).unwrap();

    // ── A user with their own data connects.
    {
        let c = Connection::open(&client).unwrap();
        c.execute("INSERT INTO Videos (video_id, title, transcript) VALUES ('mine', 'My own video', 'my words')", []).unwrap();
        c.execute("INSERT INTO Glossary (term, definition) VALUES ('mine-term', 'local')", []).unwrap();
        c.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('showBiography', 'true')", []).unwrap();
        c.execute("INSERT OR REPLACE INTO Settings (key, value) VALUES ('venice_api_key', 'USERS-OWN-KEY')", []).unwrap();
    }
    db::set_setting(&client, KEY_URL, &url).unwrap();
    db::set_setting(&client, KEY_TOKEN, TOKEN).unwrap();
    let state = SyncState::default();

    let r = run_core(&client, &state, false, |_| {}).await.unwrap();
    assert!(r.full);
    assert_eq!(r.error_count, 0, "{:?}", r.errors);
    assert!(r.pages >= 3, "page_max 3 with 9+ items must paginate: {r:?}");

    // Content arrived, verbatim.
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Videos WHERE video_id LIKE 'vid%'"), 4);
    assert_eq!(q(&client, "SELECT transcript FROM Videos WHERE video_id='vid3'").as_deref(), Some("transcript number 3 about saucers"));
    assert_eq!(q(&client, "SELECT WDBS FROM Videos WHERE video_id='vid2'").as_deref(), Some("θψUAP_GERB"));
    assert_eq!(q(&client, "SELECT WDInfo FROM tblWDBS WHERE WDBS=':UAP-GERB'").as_deref(), Some("Gerb Alias"));
    assert_eq!(q(&client, "SELECT WDIcon FROM tblWDBS WHERE WDBS=':UAP-GERB'").as_deref(), Some("star"));
    assert_eq!(n(&client, "SELECT COUNT(*) FROM VideoWDBSLinks WHERE video_id='vid1'"), 1);
    assert_eq!(q(&client, "SELECT definition FROM Glossary WHERE term='saucer'").as_deref(), Some("a flying disc"));
    // The term's top-level drive assignment came with it.
    assert_eq!(q(&client, "SELECT group_concat(root) FROM GlossaryDrives WHERE term='saucer'").as_deref(), Some(":UAP"));
    assert_eq!(n(&client, "SELECT subscriber_count FROM Biographies WHERE handle='@auth'"), 4200);
    assert_eq!(q(&client, "SELECT cloud_prompt_text FROM CustomPrompts WHERE handle='@auth'").as_deref(), Some("cloud p"));
    // Derived data was rebuilt locally, so search works on synced videos.
    assert!(q(&client, "SELECT tokens FROM Videos WHERE video_id='vid1'").unwrap_or_default().contains("saucers"));
    assert!(n(&client, "SELECT COUNT(*) FROM ftsVideos WHERE ftsVideos MATCH 'saucers'") >= 4);

    // The user's own rows are untouched.
    assert_eq!(q(&client, "SELECT title FROM Videos WHERE video_id='mine'").as_deref(), Some("My own video"));
    assert_eq!(q(&client, "SELECT definition FROM Glossary WHERE term='mine-term'").as_deref(), Some("local"));

    // Policy: enforced over the user's own value, without overwriting it; secrets never travel.
    assert_eq!(db::get_setting(&client, "showBiography").unwrap().as_deref(), Some("false"));
    assert_eq!(q(&client, "SELECT value FROM Settings WHERE key='showBiography'").as_deref(), Some("true"));
    assert!(db::set_setting(&client, "showBiography", "true").is_err(), "a locked setting rejects local edits");
    assert_eq!(db::get_setting(&client, "venice_api_key").unwrap().as_deref(), Some("USERS-OWN-KEY"));
    assert_eq!(n(&client, "SELECT COUNT(*) FROM SyncPolicy"), 2);

    // License advertised (and only what the token is licensed for).
    let st = status(&client, &state).unwrap();
    assert_eq!(st.server_name, "E2E Library");
    assert_eq!(st.license.providers, vec!["venice".to_string()]);
    assert_eq!(st.owned_counts.get("video"), Some(&4));

    // ── The admin edits, deletes and adds; the client picks up exactly that.
    {
        let m = Connection::open(&master).unwrap();
        m.execute("UPDATE Videos SET title = 'Video 1 (revised)' WHERE video_id = 'vid1'", []).unwrap();
        m.execute("DELETE FROM Videos WHERE video_id = 'vid4'", []).unwrap();
        m.execute("INSERT INTO Glossary (term, definition) VALUES ('orb', 'a sphere')", []).unwrap();
        // The admin refiles a term: only the assignment changes, and the client must follow.
        m.execute("DELETE FROM GlossaryDrives WHERE term = 'saucer'", []).unwrap();
        m.execute("INSERT INTO GlossaryDrives (term, root) VALUES ('saucer', ':FIN'), ('saucer', ':CRYPTO')", []).unwrap();
        m.execute("UPDATE Settings SET value = 'true' WHERE key = 'showBiography'", []).unwrap();
    }
    scan_once(&server).unwrap();
    let r = run_core(&client, &state, false, |_| {}).await.unwrap();
    assert!(!r.full, "an up-to-date client syncs incrementally");
    assert_eq!(r.error_count, 0, "{:?}", r.errors);
    assert_eq!(q(&client, "SELECT title FROM Videos WHERE video_id='vid1'").as_deref(), Some("Video 1 (revised)"));
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Videos WHERE video_id='vid4'"), 0);
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Videos WHERE video_id='mine'"), 1, "the user's video survives the sync");
    assert_eq!(q(&client, "SELECT definition FROM Glossary WHERE term='orb'").as_deref(), Some("a sphere"));
    assert_eq!(
        q(&client, "SELECT group_concat(root) FROM (SELECT root FROM GlossaryDrives WHERE term='saucer' ORDER BY root)").as_deref(),
        Some(":CRYPTO,:FIN"),
        "a change that only touches drive assignments still syncs"
    );
    assert_eq!(db::get_setting(&client, "showBiography").unwrap().as_deref(), Some("true"), "policy updates follow the master");

    // ── Nothing changed: nothing to do.
    let r = run_core(&client, &state, false, |_| {}).await.unwrap();
    assert_eq!((r.upserted, r.deleted), (0, 0));

    // ── Disconnecting with "remove" takes the server's rows and policy away, and only those.
    let stats = disconnect(&client, false).unwrap();
    assert!(stats.deleted >= 8, "{stats:?}");
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Videos WHERE video_id LIKE 'vid%'"), 0);
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Videos WHERE video_id='mine'"), 1);
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Glossary WHERE term='mine-term'"), 1);
    assert_eq!(db::get_setting(&client, "showBiography").unwrap().as_deref(), Some("true"));
    assert!(load_config(&client).is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_client_recovers_when_the_server_forgets_its_history() {
    let dir = temp("retention");
    let master = dir.join("master.db").to_string_lossy().to_string();
    let client = dir.join("client.db").to_string_lossy().to_string();
    init_db(&master).unwrap();
    init_db(&client).unwrap();
    {
        let m = Connection::open(&master).unwrap();
        for i in 0..6 {
            m.execute("INSERT INTO Glossary (term, definition) VALUES (?1, 'd')", rusqlite::params![format!("t{i}")]).unwrap();
        }
    }
    let (url, server) = start_server(&dir, &master).await;
    scan_once(&server).unwrap();
    db::set_setting(&client, KEY_URL, &url).unwrap();
    db::set_setting(&client, KEY_TOKEN, TOKEN).unwrap();
    let state = SyncState::default();
    run_core(&client, &state, false, |_| {}).await.unwrap();
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Glossary WHERE term LIKE 't%'"), 6);

    // Rebuild the server's state from scratch: its revision numbers no longer relate to the
    // client's cursor (6), and it has no memory of what was deleted meanwhile. Two new rows make
    // the rebuilt server's head (7) HIGHER than the client's cursor, the case where comparing
    // numbers alone looks fine: a client that only asked "anything after 6?" would get u1 alone
    // and silently keep t0 and miss u0. Only the epoch tells it the history is a different one.
    {
        let m = Connection::open(&master).unwrap();
        m.execute("DELETE FROM Glossary WHERE term = 't0'", []).unwrap();
        m.execute("INSERT INTO Glossary (term, definition) VALUES ('u0', 'd'), ('u1', 'd')", []).unwrap();
    }
    std::fs::remove_file(dir.join("state.db")).unwrap();
    let _ = std::fs::remove_file(dir.join("state.db-wal"));
    let _ = std::fs::remove_file(dir.join("state.db-shm"));
    let (url2, server2) = start_server(&dir, &master).await;
    scan_once(&server2).unwrap();
    assert_eq!(server2.store.revisions().unwrap().0, 7);
    db::set_setting(&client, KEY_URL, &url2).unwrap();
    assert_eq!(status(&client, &state).unwrap().cursor, 6);

    let r = run_core(&client, &state, false, |_| {}).await.unwrap();
    assert!(r.full, "a new epoch must trigger a snapshot even though the cursor is below the new head");
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Glossary WHERE term='t0'"), 0, "the sweep removed what the new snapshot lacks");
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Glossary WHERE term IN ('u0', 'u1')"), 2, "and nothing new was skipped");
    assert_eq!(n(&client, "SELECT COUNT(*) FROM Glossary WHERE term LIKE 't%'"), 5);
    assert_eq!(status(&client, &state).unwrap().cursor, 7);

    // Steady state again: the same epoch means an ordinary incremental sync.
    let r = run_core(&client, &state, false, |_| {}).await.unwrap();
    assert!(!r.full);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A recording stand-in for the real providers (Venice, YouTube), reachable over plain http.
fn start_mock_provider() -> (String, std::sync::Arc<std::sync::Mutex<Vec<(String, Option<String>, String)>>>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let seen: std::sync::Arc<std::sync::Mutex<Vec<(String, Option<String>, String)>>> = Default::default();
    let log = seen.clone();
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
            let auth = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.as_str().to_string());
            log.lock().unwrap().push((req.url().to_string(), auth, body));
            let _ = req.respond(tiny_http::Response::from_string(r#"{"provider":"reached"}"#));
        }
    });
    (format!("http://127.0.0.1:{port}"), seen)
}

#[tokio::test]
async fn licensed_provider_calls_go_through_the_servers_proxy_with_the_real_key() {
    let dir = temp("license");
    let master = dir.join("master.db").to_string_lossy().to_string();
    let client_db = dir.join("client.db").to_string_lossy().to_string();
    init_db(&master).unwrap();
    init_db(&client_db).unwrap();
    let (upstream, seen) = start_mock_provider();

    let config = Config {
        bind: "127.0.0.1:0".into(),
        server_name: "Licensed Library".into(),
        master_db: master.clone().into(),
        state_db: dir.join("state.db"),
        scan_interval_secs: 0,
        retention_revisions: 1000,
        page_max: 100,
        min_client_version: String::new(),
        license_mode: "fallback".into(),
        proxy_rate_limit_per_minute: 0,
        allow_mass_removal: false,
        allow_anonymous: false,
        policy: PolicyConfig::default(),
        tokens: vec![TokenConfig {
            name: "e2e".into(),
            token: TOKEN.into(),
            licenses: vec!["venice".into(), "youtube".into(), "pixabay".into()],
        }],
        providers: Providers {
            venice: ProviderConfig { api_key: Some("REAL-VENICE-KEY".into()), api_key_env: None, base_url: Some(format!("{upstream}/api/v1")) },
            youtube: ProviderConfig { api_key: Some("REAL-YT-KEY".into()), api_key_env: None, base_url: Some(upstream.clone()) },
            pixabay: ProviderConfig { api_key: Some("REAL-PIXABAY-KEY".into()), api_key_env: None, base_url: Some(upstream.clone()) },
        },
    };
    config.validate().unwrap();
    let state = build_state(config).unwrap();
    scan_once(&state).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let serving = state.clone();
    tokio::spawn(async move {
        serve(listener, serving).await.unwrap();
    });

    // No keys of their own: nothing works until the license arrives.
    assert!(license::route(&client_db, "venice").is_none());
    db::set_setting(&client_db, KEY_URL, &url).unwrap();
    db::set_setting(&client_db, KEY_TOKEN, TOKEN).unwrap();
    run_core(&client_db, &SyncState::default(), false, |_| {}).await.unwrap();

    let ks = license::key_status(&client_db);
    assert_eq!(ks.server_name, "Licensed Library");
    for p in [&ks.venice, &ks.youtube, &ks.pixabay] {
        assert!(p.available && p.licensed && p.via_license && !p.own_key);
    }

    let http = reqwest::Client::new();

    // Venice: the client's request, minus any key, plus its sync token; the provider must see the real key.
    let venice = license::route(&client_db, "venice").unwrap();
    let resp = venice
        .apply(http.post(venice.url("chat/completions")))
        .header("Content-Type", "application/json")
        .body(r#"{"model":"m","messages":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.text().await.unwrap(), r#"{"provider":"reached"}"#);

    // YouTube Data API: key travels as a query parameter to the provider, never from the client.
    let yt = license::route(&client_db, "youtube").unwrap();
    let resp = yt.apply(http.get(yt.url("youtube/v3/videos?part=statistics,contentDetails&id=abc123"))).send().await.unwrap();
    assert_eq!(resp.status(), 200);

    // Pixabay's endpoint ends in a slash.
    let px = license::route(&client_db, "pixabay").unwrap();
    let resp = px.apply(http.get(px.url("api/?q=cats&image_type=photo"))).send().await.unwrap();
    assert_eq!(resp.status(), 200);

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    let (v_url, v_auth, v_body) = &seen[0];
    assert_eq!(v_url, "/api/v1/chat/completions");
    assert_eq!(v_auth.as_deref(), Some("Bearer REAL-VENICE-KEY"));
    assert_eq!(v_body, r#"{"model":"m","messages":[]}"#);
    let (y_url, y_auth, _) = &seen[1];
    assert!(y_url.starts_with("/youtube/v3/videos?"), "{y_url}");
    assert!(y_url.contains("id=abc123") && y_url.contains("key=REAL-YT-KEY"), "{y_url}");
    assert!(y_auth.is_none());
    let (p_url, _, _) = &seen[2];
    assert!(p_url.starts_with("/api/?"), "{p_url}");
    assert!(p_url.contains("q=cats") && p_url.contains("key=REAL-PIXABAY-KEY"), "{p_url}");
    // The user's sync token never reaches a provider, in any header or URL.
    assert!(!format!("{seen:?}").contains(TOKEN));
    drop(seen);

    // The user's own key takes over in fallback mode; disconnecting removes the license.
    db::set_setting(&client_db, "venice_api_key", "USERS-OWN").unwrap();
    assert!(!license::route(&client_db, "venice").unwrap().via_proxy);
    disconnect(&client_db, true).unwrap();
    assert!(license::route(&client_db, "youtube").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}
