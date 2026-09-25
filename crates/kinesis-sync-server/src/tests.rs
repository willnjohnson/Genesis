//! End-to-end tests: a real server on an ephemeral port, driven over HTTP.

use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, Uri};
use axum::routing::any;
use axum::Router;
use kinesis_sync_proto::{ChangesPage, Manifest, Policy};

use crate::config::{Config, Providers, ProviderConfig, TokenConfig};
use crate::store::tests::{make_master, temp_dir};
use crate::{build_state, router, scan_once};

const TOKEN: &str = "0123456789abcdef-alice";
const OTHER_TOKEN: &str = "0123456789abcdef-bob";

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

/// What the fake provider saw.
#[derive(Debug, Clone, Default)]
struct Seen {
    path: String,
    query: String,
    authorization: Option<String>,
    body: String,
}

async fn mock_provider() -> (String, Arc<Mutex<Vec<Seen>>>) {
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    async fn record(State(seen): State<Arc<Mutex<Vec<Seen>>>>, uri: Uri, headers: HeaderMap, body: String) -> &'static str {
        seen.lock().unwrap().push(Seen {
            path: uri.path().to_string(),
            query: uri.query().unwrap_or("").to_string(),
            authorization: headers.get("authorization").and_then(|v| v.to_str().ok()).map(String::from),
            body,
        });
        r#"{"ok":true}"#
    }
    let app = Router::new().fallback(any(record)).with_state(seen.clone());
    (serve(app).await, seen)
}

struct Harness {
    base: String,
    master: rusqlite::Connection,
    state: Arc<crate::AppState>,
    upstream: Arc<Mutex<Vec<Seen>>>,
    dir: std::path::PathBuf,
}

async fn harness(name: &str, tweak: impl FnOnce(&mut Config)) -> Harness {
    let dir = temp_dir(name);
    let master = make_master(&dir.join("master.db"));
    let (upstream_base, upstream) = mock_provider().await;

    let mut config = Config {
        bind: "127.0.0.1:0".into(),
        server_name: "Test Library".into(),
        master_db: dir.join("master.db"),
        state_db: dir.join("state.db"),
        scan_interval_secs: 0,
        retention_revisions: 1000,
        page_max: 500,
        min_client_version: String::new(),
        license_mode: "fallback".into(),
        proxy_rate_limit_per_minute: 0,
        allow_mass_removal: false,
        allow_anonymous: false,
        policy: crate::config::PolicyConfig { enforced: vec!["showDrive".into(), "showBiography".into()] },
        tokens: vec![
            TokenConfig { name: "alice".into(), token: TOKEN.into(), licenses: vec!["venice".into(), "youtube".into(), "pixabay".into()] },
            TokenConfig { name: "bob".into(), token: OTHER_TOKEN.into(), licenses: vec![] },
        ],
        providers: Providers {
            venice: ProviderConfig { api_key: Some("REAL-VENICE-KEY".into()), api_key_env: None, base_url: Some(format!("{upstream_base}/api/v1")) },
            youtube: ProviderConfig { api_key: Some("REAL-YT-KEY".into()), api_key_env: None, base_url: Some(upstream_base.clone()) },
            pixabay: ProviderConfig { api_key: None, api_key_env: Some("KINESIS_TEST_UNSET_PIXABAY".into()), base_url: Some(upstream_base.clone()) },
        },
    };
    tweak(&mut config);
    config.validate().unwrap();
    let state = build_state(config).unwrap();
    let base = serve(router(state.clone())).await;
    Harness { base, master, state, upstream, dir }
}

impl Harness {
    fn scan(&self) {
        scan_once(&self.state).unwrap();
    }

    fn get(&self, path: &str, token: Option<&str>) -> reqwest::RequestBuilder {
        let mut req = reqwest::Client::new().get(format!("{}{path}", self.base));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        req
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn requires_a_valid_token() {
    let h = harness("auth", |_| {}).await;
    h.scan();
    assert_eq!(h.get("/api/v1/manifest", None).send().await.unwrap().status(), 401);
    assert_eq!(h.get("/api/v1/manifest", Some("wrong-token-wrong-token")).send().await.unwrap().status(), 401);
    assert_eq!(h.get("/api/v1/changes", None).send().await.unwrap().status(), 401);
    assert_eq!(h.get("/api/v1/policy", None).send().await.unwrap().status(), 401);
    assert_eq!(h.get("/api/v1/manifest", Some(TOKEN)).send().await.unwrap().status(), 200);
    assert_eq!(h.get("/healthz", None).send().await.unwrap().status(), 200, "health checks need no token");
}

#[tokio::test]
async fn anonymous_access_gets_content_but_never_a_license() {
    let h = harness("anon", |c| {
        c.allow_anonymous = true;
    })
    .await;
    h.scan();
    let m: Manifest = h.get("/api/v1/manifest", None).send().await.unwrap().json().await.unwrap();
    assert!(m.capabilities.content);
    assert!(m.capabilities.license.is_empty());
    // A presented-but-wrong token is still refused, even when anonymous access is on.
    assert_eq!(h.get("/api/v1/manifest", Some("bogus-bogus-bogus-bogus")).send().await.unwrap().status(), 401);
}

#[tokio::test]
async fn manifest_lists_only_licenses_the_server_can_honour() {
    let h = harness("manifest", |_| {}).await;
    h.scan();
    let alice: Manifest = h.get("/api/v1/manifest", Some(TOKEN)).send().await.unwrap().json().await.unwrap();
    assert_eq!(alice.server_name, "Test Library");
    assert_eq!(alice.protocol_version, kinesis_sync_proto::PROTOCOL_VERSION);
    // Alice is licensed for pixabay, but the server has no pixabay key, so it isn't advertised.
    assert_eq!(alice.capabilities.license, vec!["venice".to_string(), "youtube".to_string()]);
    let bob: Manifest = h.get("/api/v1/manifest", Some(OTHER_TOKEN)).send().await.unwrap().json().await.unwrap();
    assert!(bob.capabilities.license.is_empty());
}

#[tokio::test]
async fn content_flows_as_snapshot_then_delta_with_tombstones() {
    let h = harness("content", |_| {}).await;
    h.master.execute("INSERT INTO Glossary (term, definition) VALUES ('alpha', 'first'), ('beta', 'second'), ('gamma', 'third')", []).unwrap();
    h.master.execute("INSERT INTO Videos (video_id, title, transcript, WDBS) VALUES ('vid1', 'A video', 'the words', 'θψUAP')", []).unwrap();
    h.master.execute("INSERT INTO tblWDBS VALUES (':UAP', 1, 'UAP', 'Aliased', 'star', 0)", []).unwrap();
    h.scan();

    let mut cursor = 0u64;
    let mut kinds: Vec<String> = vec![];
    loop {
        let page: ChangesPage = h
            .get(&format!("/api/v1/changes?since={cursor}&limit=2&snapshot=1"), Some(TOKEN))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(page.upserts.len() <= 2);
        for item in &page.upserts {
            assert!(!item.hash.is_empty());
            kinds.push(format!("{}:{}", item.kind, item.key));
            if item.kind == "video" {
                assert_eq!(item.data["title"], "A video");
                assert_eq!(item.data["transcript"], "the words");
            }
        }
        assert!(page.deletes.is_empty(), "snapshots carry no tombstones");
        cursor = page.revision;
        if !page.has_more {
            break;
        }
    }
    kinds.sort();
    assert_eq!(kinds, vec!["glossary:|alpha", "glossary:|beta", "glossary:|gamma", "video:vid1", "wdbs::UAP"]);
    assert_eq!(cursor, 5);

    // Edit one, delete one.
    h.master.execute("UPDATE Glossary SET definition = 'FIRST' WHERE term = 'alpha'", []).unwrap();
    h.master.execute("DELETE FROM Glossary WHERE term = 'beta'", []).unwrap();
    h.scan();
    let page: ChangesPage = h.get(&format!("/api/v1/changes?since={cursor}"), Some(TOKEN)).send().await.unwrap().json().await.unwrap();
    assert_eq!(page.upserts.len(), 1);
    assert_eq!(page.upserts[0].key, "|alpha");
    assert_eq!(page.upserts[0].data["definition"], "FIRST");
    assert_eq!(page.deletes.len(), 1);
    assert_eq!(page.deletes[0].key, "|beta");
    assert_eq!(page.revision, 7);
}

#[tokio::test]
async fn a_cursor_behind_pruned_history_gets_410() {
    let h = harness("gone", |c| c.retention_revisions = 2).await;
    h.master.execute("INSERT INTO Glossary (term, definition) VALUES ('a', '1'), ('b', '2')", []).unwrap();
    h.scan();
    h.master.execute("DELETE FROM Glossary WHERE term = 'a'", []).unwrap();
    h.scan(); // tombstone at rev 3
    h.master.execute("INSERT INTO Glossary (term, definition) VALUES ('c', '3'), ('d', '4'), ('e', '5')", []).unwrap();
    h.scan(); // head 6, cutoff 4: the tombstone is pruned

    let resp = h.get("/api/v1/changes?since=1", Some(TOKEN)).send().await.unwrap();
    assert_eq!(resp.status(), 410);
    let snapshot = h.get("/api/v1/changes?since=0&snapshot=1", Some(TOKEN)).send().await.unwrap();
    assert_eq!(snapshot.status(), 200, "a snapshot is always allowed");
}

#[tokio::test]
async fn policy_only_enforces_configured_allowlisted_keys_present_in_the_master() {
    let h = harness("policy", |_| {}).await;
    h.master
        .execute(
            "INSERT INTO Settings VALUES ('showDrive', 'false'), ('showSearch', 'false'), ('venice_api_key', 'MASTER-SECRET'), ('api_key', 'MASTER-YT')",
            [],
        )
        .unwrap();
    h.scan();
    let text = h.get("/api/v1/policy", Some(TOKEN)).send().await.unwrap().text().await.unwrap();
    assert!(!text.contains("MASTER-SECRET") && !text.contains("MASTER-YT"), "keys must never appear in policy: {text}");
    let policy: Policy = serde_json::from_str(&text).unwrap();
    // showDrive: enforced and present. showSearch: present but not enforced. showBiography: enforced but absent.
    assert_eq!(policy.settings.len(), 1);
    assert_eq!(policy.settings.get("showDrive").map(String::as_str), Some("false"));
    assert_eq!(policy.locked, vec!["showDrive".to_string()]);
}

#[tokio::test]
async fn proxy_injects_provider_keys_and_never_forwards_the_users_token() {
    let h = harness("proxy", |_| {}).await;
    let client = reqwest::Client::new();

    // Venice: bearer header.
    let resp = client
        .post(format!("{}/api/v1/proxy/venice/chat/completions", h.base))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .body(r#"{"model":"m"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.text().await.unwrap(), r#"{"ok":true}"#);
    {
        let seen = h.upstream.lock().unwrap();
        let s = seen.last().unwrap();
        assert_eq!(s.path, "/api/v1/chat/completions");
        assert_eq!(s.authorization.as_deref(), Some("Bearer REAL-VENICE-KEY"));
        assert_eq!(s.body, r#"{"model":"m"}"#);
        assert!(!format!("{s:?}").contains(TOKEN), "the sync token must not reach the provider");
    }

    // YouTube: key in the query; a key the caller supplied is replaced, other params survive.
    let resp = client
        .get(format!("{}/api/v1/proxy/youtube/youtube/v3/videos?id=abc&key=CALLER-KEY&part=statistics", h.base))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    {
        let seen = h.upstream.lock().unwrap();
        let s = seen.last().unwrap();
        assert_eq!(s.path, "/youtube/v3/videos");
        assert!(s.query.contains("id=abc") && s.query.contains("part=statistics"), "{}", s.query);
        assert!(s.query.contains("key=REAL-YT-KEY"), "{}", s.query);
        assert!(!s.query.contains("CALLER-KEY"), "{}", s.query);
        assert_eq!(s.query.matches("key=").count(), 1);
        assert!(s.authorization.is_none());
    }
}

#[tokio::test]
async fn proxy_refuses_unlicensed_unknown_and_unconfigured_providers() {
    let h = harness("proxyauth", |_| {}).await;
    let client = reqwest::Client::new();
    let post = |token: Option<&str>, provider: &str| {
        let mut req = client.post(format!("{}/api/v1/proxy/{provider}/x", h.base)).body("{}");
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        req
    };
    assert_eq!(post(None, "venice").send().await.unwrap().status(), 401);
    assert_eq!(post(Some(OTHER_TOKEN), "venice").send().await.unwrap().status(), 403, "bob has no licenses");
    assert_eq!(post(Some(TOKEN), "openai").send().await.unwrap().status(), 404);
    assert_eq!(post(Some(TOKEN), "pixabay").send().await.unwrap().status(), 503, "licensed, but the server has no key");
    assert_eq!(
        client.delete(format!("{}/api/v1/proxy/venice/x", h.base)).bearer_auth(TOKEN).send().await.unwrap().status(),
        405
    );
    assert!(h.upstream.lock().unwrap().is_empty(), "nothing may reach the provider on a refused call");
}

#[tokio::test]
async fn proxy_rate_limits_per_token() {
    let h = harness("ratelimit", |c| c.proxy_rate_limit_per_minute = 2).await;
    let client = reqwest::Client::new();
    let call = || client.get(format!("{}/api/v1/proxy/venice/models", h.base)).bearer_auth(TOKEN).send();
    assert_eq!(call().await.unwrap().status(), 200);
    assert_eq!(call().await.unwrap().status(), 200);
    assert_eq!(call().await.unwrap().status(), 429);
}
