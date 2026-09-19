//! HTTP client for the sync protocol (docs/sync-protocol.md).

use std::net::IpAddr;
use std::time::Duration;

use kinesis_sync_proto::{ChangesPage, Manifest, Policy};
use reqwest::redirect::Policy as RedirectPolicy;
use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;

/// Hard cap on a single response body. Pages are requested with a small `limit`, so a legitimate
/// page is far below this; anything bigger is a misbehaving (or hostile) server.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub enum ApiError {
    /// 410 Gone: the cursor is older than the server's retention window.
    ResyncRequired,
    Auth(String),
    Http(u16, String),
    Network(String),
    Protocol(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::ResyncRequired => write!(f, "The server requires a full resync."),
            ApiError::Auth(m) => write!(f, "{m}"),
            ApiError::Http(code, m) => write!(f, "Server error {code}: {m}"),
            ApiError::Network(m) => write!(f, "Couldn't reach the server: {m}"),
            ApiError::Protocol(m) => write!(f, "Unexpected server response: {m}"),
        }
    }
}

/// Validates and normalizes a user-entered server address. `https` is required, except `http`
/// for loopback and private-network hosts (a LAN or local test server).
pub fn normalize_server_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Enter a server address.".into());
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let mut url = Url::parse(&with_scheme).map_err(|e| format!("Not a valid address: {e}"))?;
    let host = url.host_str().map(str::to_string).ok_or("The address has no host.")?;
    match url.scheme() {
        "https" => {}
        "http" if is_local_or_private_host(&host) => {}
        "http" => {
            return Err("Plain http is only allowed for localhost and private-network addresses. Use https.".into())
        }
        other => return Err(format!("Unsupported scheme '{other}'.")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Don't put credentials in the address; use the access token field.".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn is_local_or_private_host(host: &str) -> bool {
    let host = host.trim_matches(|c| c == '[' || c == ']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => false,
    }
}

pub struct ServerApi {
    client: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl ServerApi {
    pub fn new(base: &str, token: Option<String>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .user_agent(format!("Kinesis-Sync/{}", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            // Never follow a redirect that downgrades https to http.
            .redirect(RedirectPolicy::custom(|attempt| {
                let downgrade = attempt
                    .previous()
                    .last()
                    .map(|prev| prev.scheme() == "https" && attempt.url().scheme() != "https")
                    .unwrap_or(false);
                if downgrade || attempt.previous().len() >= 3 {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(ServerApi { client, base: base.trim_end_matches('/').to_string(), token: token.filter(|t| !t.trim().is_empty()) })
    }

    async fn get_json<T: DeserializeOwned>(&self, path_and_query: &str) -> Result<T, ApiError> {
        let mut req = self.client.get(format!("{}{}", self.base, path_and_query)).header("Accept", "application/json");
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let mut resp = req.send().await.map_err(|e| ApiError::Network(e.to_string()))?;
        let status = resp.status();

        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| ApiError::Network(e.to_string()))? {
            if body.len() + chunk.len() > MAX_BODY_BYTES {
                return Err(ApiError::Protocol("response too large".into()));
            }
            body.extend_from_slice(&chunk);
        }

        match status {
            s if s.is_success() => serde_json::from_slice(&body).map_err(|e| ApiError::Protocol(e.to_string())),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                Err(ApiError::Auth("The server rejected the access token.".into()))
            }
            StatusCode::GONE => Err(ApiError::ResyncRequired),
            s => {
                let text = String::from_utf8_lossy(&body);
                let short: String = text.chars().take(200).collect();
                Err(ApiError::Http(s.as_u16(), short))
            }
        }
    }

    pub async fn manifest(&self) -> Result<Manifest, ApiError> {
        self.get_json("/api/v1/manifest").await
    }

    /// `snapshot` marks a page of a full resync: the server never answers 410 for it and omits
    /// tombstones (the client sweeps whatever the snapshot didn't mention).
    pub async fn changes(&self, since: u64, limit: usize, snapshot: bool) -> Result<ChangesPage, ApiError> {
        let snap = if snapshot { "&snapshot=1" } else { "" };
        self.get_json(&format!("/api/v1/changes?since={since}&limit={limit}{snap}")).await
    }

    pub async fn policy(&self) -> Result<Policy, ApiError> {
        self.get_json("/api/v1/policy").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_is_required_except_for_local_hosts() {
        assert_eq!(normalize_server_url("example.com/").unwrap(), "https://example.com");
        assert_eq!(normalize_server_url("https://example.com/base/?x=1#f").unwrap(), "https://example.com/base");
        assert!(normalize_server_url("http://example.com").is_err());
        assert!(normalize_server_url("http://localhost:8080").is_ok());
        assert!(normalize_server_url("http://127.0.0.1:8080").is_ok());
        assert!(normalize_server_url("http://192.168.1.20").is_ok());
        assert!(normalize_server_url("http://10.0.0.5:9000").is_ok());
        assert!(normalize_server_url("http://8.8.8.8").is_err());
    }

    #[test]
    fn junk_and_credentials_are_rejected() {
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("   ").is_err());
        assert!(normalize_server_url("ftp://example.com").is_err());
        assert!(normalize_server_url("https://user:pass@example.com").is_err());
    }
}
