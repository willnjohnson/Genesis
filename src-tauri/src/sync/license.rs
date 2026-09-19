//! Provider access: the user's own API key, or a license from the connected sync server.
//!
//! A license never hands the client a key. Instead the provider call is sent to the server's
//! proxy (`{server}/api/v1/proxy/{provider}/...`) with the user's sync token, and the server adds
//! the real key. Every call site asks `route()` how to reach a provider, so the choice between
//! "own key, direct" and "license, via the proxy" lives in one place.

use kinesis_sync_proto::Manifest;
use serde::{Deserialize, Serialize};

use crate::db;


#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LicenseInfo {
    /// Providers reachable through the server's proxy: "venice", "youtube", "pixabay".
    #[serde(default)]
    pub providers: Vec<String>,
    /// "fallback" (the user's own key wins) or "enforce" (always use the proxy).
    #[serde(default)]
    pub mode: String,
}

pub fn store(db_path: &str, manifest: &Manifest) {
    let info = LicenseInfo {
        providers: manifest.capabilities.license.clone(),
        mode: if manifest.license_mode == "enforce" { "enforce".into() } else { "fallback".into() },
    };
    if let Ok(json) = serde_json::to_string(&info) {
        if let Err(e) = db::set_setting(db_path, super::KEY_LICENSE, &json) {
            log::warn!("sync: couldn't store license info: {e}");
        }
    }
}

pub fn load(db_path: &str) -> LicenseInfo {
    db::get_setting(db_path, super::KEY_LICENSE)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// The setting the user's own key for `provider` lives in.
fn own_key_setting(provider: &str) -> &'static str {
    match provider {
        "venice" => "venice_api_key",
        "pixabay" => "pixabay_api_key",
        _ => "api_key", // YouTube Data API
    }
}

/// Where a provider's own API expects the key.
fn key_in_query(provider: &str) -> bool {
    provider != "venice"
}

fn default_base(provider: &str) -> &'static str {
    match provider {
        "venice" => "https://api.venice.ai/api/v1",
        "youtube" => "https://youtube.googleapis.com",
        _ => "https://pixabay.com",
    }
}

/// How to reach one provider right now.
#[derive(Debug, Clone)]
pub struct Route {
    base: String,
    /// Sent as `Authorization: Bearer ...` (the provider's own key, or the sync token via proxy).
    bearer: Option<String>,
    /// Sent as a `key=` query parameter (providers that authenticate that way, direct only).
    key_param: Option<String>,
    pub via_proxy: bool,
}

impl Route {
    /// Full URL for `path_and_query` (relative to the provider's API base), with the key appended
    /// when the provider takes it in the query string.
    pub fn url(&self, path_and_query: &str) -> String {
        let mut url = format!("{}/{}", self.base, path_and_query.trim_start_matches('/'));
        if let Some(key) = &self.key_param {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str("key=");
            url.push_str(&urlencoding::encode(key));
        }
        url
    }

    /// Adds the bearer header when this route uses one.
    pub fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.bearer {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }
}

fn own_key(db_path: &str, provider: &str) -> Option<String> {
    db::get_setting(db_path, own_key_setting(provider))
        .ok()
        .flatten()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// The server's proxy for `provider`, when a connected server has licensed it for this user.
fn licensed_route(db_path: &str, provider: &str) -> Option<Route> {
    let cfg = super::load_config(db_path)?;
    // A license is tied to a token; without one the server would refuse the proxy anyway.
    let token = cfg.token?;
    if !load(db_path).providers.iter().any(|p| p == provider) {
        return None;
    }
    Some(Route {
        base: format!("{}/api/v1/proxy/{provider}", cfg.url.trim_end_matches('/')),
        bearer: Some(token),
        key_param: None,
        via_proxy: true,
    })
}

fn direct_route(db_path: &str, provider: &str) -> Option<Route> {
    let key = own_key(db_path, provider)?;
    let in_query = key_in_query(provider);
    Some(Route {
        base: default_base(provider).to_string(),
        bearer: if in_query { None } else { Some(key.clone()) },
        key_param: if in_query { Some(key) } else { None },
        via_proxy: false,
    })
}

/// How to reach `provider`: through the server's license when one applies, otherwise with the
/// user's own key. A license applies when the server offers it AND (it is set to "enforce", or the
/// user has no key of their own). `None` = no way to reach it (no key, no license).
pub fn route(db_path: &str, provider: &str) -> Option<Route> {
    let licensed = licensed_route(db_path, provider);
    if licensed.is_some() && (load(db_path).mode == "enforce" || own_key(db_path, provider).is_none()) {
        return licensed;
    }
    direct_route(db_path, provider)
}

/// Per-provider state for the Settings UI and the "is an API key set" checks.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderStatus {
    /// The user has their own key stored.
    pub own_key: bool,
    /// The connected server offers a license for this provider.
    pub licensed: bool,
    /// A call would work right now (own key or license).
    pub available: bool,
    /// The license is what a call would use.
    pub via_license: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyStatus {
    pub server_name: String,
    pub youtube: ProviderStatus,
    pub venice: ProviderStatus,
    pub pixabay: ProviderStatus,
}

pub fn key_status(db_path: &str) -> KeyStatus {
    let one = |provider: &str| {
        let r = route(db_path, provider);
        ProviderStatus {
            own_key: own_key(db_path, provider).is_some(),
            licensed: licensed_route(db_path, provider).is_some(),
            available: r.is_some(),
            via_license: r.map(|r| r.via_proxy).unwrap_or(false),
        }
    };
    KeyStatus {
        server_name: db::get_setting(db_path, super::KEY_SERVER_NAME).ok().flatten().unwrap_or_default(),
        youtube: one("youtube"),
        venice: one("venice"),
        pixabay: one("pixabay"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_license_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn connect(db_path: &str, providers: &[&str], mode: &str) {
        db::set_setting(db_path, super::super::KEY_URL, "https://sync.example.com/").unwrap();
        db::set_setting(db_path, super::super::KEY_TOKEN, "SYNC-TOKEN").unwrap();
        let info = LicenseInfo { providers: providers.iter().map(|p| p.to_string()).collect(), mode: mode.into() };
        db::set_setting(db_path, super::super::KEY_LICENSE, &serde_json::to_string(&info).unwrap()).unwrap();
    }

    #[test]
    fn nothing_available_without_a_key_or_license() {
        let db = temp_db("none");
        assert!(route(&db, "venice").is_none());
        assert!(!key_status(&db).youtube.available);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn own_keys_go_direct_in_the_providers_own_style() {
        let db = temp_db("own");
        db::set_setting(&db, "venice_api_key", "V-KEY").unwrap();
        db::set_setting(&db, "api_key", "YT KEY&x").unwrap();
        let v = route(&db, "venice").unwrap();
        assert!(!v.via_proxy);
        assert_eq!(v.url("chat/completions"), "https://api.venice.ai/api/v1/chat/completions", "Venice takes a header, not a query key");
        let y = route(&db, "youtube").unwrap();
        assert_eq!(
            y.url("youtube/v3/videos?part=statistics&id=abc"),
            "https://youtube.googleapis.com/youtube/v3/videos?part=statistics&id=abc&key=YT%20KEY%26x"
        );
        assert_eq!(y.url("youtube/v3/x"), "https://youtube.googleapis.com/youtube/v3/x?key=YT%20KEY%26x");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_license_covers_users_without_their_own_key() {
        let db = temp_db("lic");
        connect(&db, &["venice", "youtube"], "fallback");
        let v = route(&db, "venice").unwrap();
        assert!(v.via_proxy);
        assert_eq!(v.url("chat/completions"), "https://sync.example.com/api/v1/proxy/venice/chat/completions");
        // Via the proxy no provider key is in the URL, whatever the provider's own style.
        let y = route(&db, "youtube").unwrap();
        assert_eq!(y.url("youtube/v3/videos?id=a"), "https://sync.example.com/api/v1/proxy/youtube/youtube/v3/videos?id=a");
        assert!(route(&db, "pixabay").is_none(), "not licensed for pixabay");

        let s = key_status(&db);
        assert!(s.venice.available && s.venice.licensed && s.venice.via_license && !s.venice.own_key);
        assert!(!s.pixabay.available);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn own_key_wins_in_fallback_mode_but_not_when_the_server_enforces() {
        let db = temp_db("mode");
        db::set_setting(&db, "venice_api_key", "V-KEY").unwrap();
        connect(&db, &["venice"], "fallback");
        assert!(!route(&db, "venice").unwrap().via_proxy);
        assert!(key_status(&db).venice.licensed, "still reported as offered");

        connect(&db, &["venice"], "enforce");
        assert!(route(&db, "venice").unwrap().via_proxy);
        assert!(key_status(&db).venice.own_key, "the user's key isn't touched, just bypassed");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn an_emptied_key_counts_as_no_key() {
        let db = temp_db("empty");
        // The Venice tab "removes" a key by storing "".
        db::set_setting(&db, "venice_api_key", "").unwrap();
        assert!(route(&db, "venice").is_none());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn licenses_stop_working_after_disconnect() {
        let db = temp_db("disc");
        connect(&db, &["venice"], "fallback");
        assert!(route(&db, "venice").is_some());
        super::super::disconnect(&db, true).unwrap();
        assert!(route(&db, "venice").is_none());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_license_needs_a_token() {
        let db = temp_db("notoken");
        connect(&db, &["venice"], "fallback");
        db::delete_setting(&db, super::super::KEY_TOKEN).unwrap();
        assert!(route(&db, "venice").is_none(), "no token, no proxy");
        let _ = std::fs::remove_file(&db);
    }
}
