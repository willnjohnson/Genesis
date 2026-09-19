//! The license proxy: `ANY /api/v1/proxy/{venice|youtube|pixabay}/<path>`.
//!
//! The client sends the request it would have sent to the provider, minus its API key, with its
//! sync token. The server checks the token is licensed for that provider, adds the real key and
//! forwards. Provider keys never leave the server.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::header::{ACCEPT, CONTENT_TYPE};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use reqwest::Url;

use crate::api::{authenticate, ApiError};
use crate::config::PROVIDERS;
use crate::AppState;

/// Providers that take their key as a `key` query parameter (Venice uses a bearer header).
fn key_in_query(provider: &str) -> bool {
    provider == "youtube" || provider == "pixabay"
}

/// Fixed one-minute window per token; enough to stop a runaway client without extra dependencies.
#[derive(Default)]
pub struct RateLimiter {
    windows: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn allow(&self, who: &str, per_minute: u32) -> bool {
        if per_minute == 0 {
            return true;
        }
        let mut windows = self.windows.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let entry = windows.entry(who.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(60) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= per_minute
    }
}

/// Builds the upstream URL from the provider's base and the client's path and query. The path is
/// re-encoded segment by segment and `.`/`..` are refused, so a client can't climb out of the
/// provider's base path. For key-in-query providers any client-sent `key` is dropped and the real
/// one appended.
pub fn build_upstream_url(base: &str, rest: &str, query: Option<&str>, key_param: Option<&str>) -> Result<Url, String> {
    let mut url = Url::parse(base).map_err(|e| format!("bad upstream base: {e}"))?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| "upstream base can't have a path".to_string())?;
        segments.pop_if_empty();
        for segment in rest.split('/') {
            if segment == ".." || segment == "." || segment.contains('\\') {
                return Err("invalid path".into());
            }
            if !segment.is_empty() {
                segments.push(segment);
            }
        }
    }
    // pixabay's endpoint is "/api/" (trailing slash matters to it).
    if rest.ends_with('/') && !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    let pairs: Vec<(String, String)> = match query {
        Some(q) if !q.is_empty() => Url::parse(&format!("http://placeholder/?{q}"))
            .map_err(|_| "invalid query".to_string())?
            .query_pairs()
            .filter(|(k, _)| key_param.map(|kp| k != kp).unwrap_or(true))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
        _ => vec![],
    };
    if !pairs.is_empty() || key_param.is_some() {
        let mut q = url.query_pairs_mut();
        q.extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    Ok(url)
}

pub async fn proxy(
    State(state): State<Arc<AppState>>,
    Path((provider, rest)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Result<Response, ApiError> {
    let principal = authenticate(&state, &headers)?;
    if !PROVIDERS.contains(&provider.as_str()) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown provider"));
    }
    if !principal.licenses.iter().any(|l| l == &provider) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("your token isn't licensed for {provider}")));
    }
    if method != Method::GET && method != Method::POST {
        return Err(ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "only GET and POST are proxied"));
    }
    let cfg = state.config.providers.get(&provider).cloned().unwrap_or_default();
    let Some(key) = cfg.resolve_key(&provider) else {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("this server has no {provider} key configured")));
    };
    if !state.limiter.allow(&principal.name, state.config.proxy_rate_limit_per_minute) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded; try again shortly"));
    }

    let key_param = key_in_query(&provider).then_some("key");
    let mut url = build_upstream_url(&cfg.base_url(&provider), &rest, uri.query(), key_param)
        .map_err(|m| ApiError::new(StatusCode::BAD_REQUEST, m))?;
    if key_param.is_some() {
        url.query_pairs_mut().append_pair("key", &key);
    }

    // Only content negotiation headers are forwarded: never the client's Authorization (its sync
    // token), cookies or anything else identifying.
    let mut request = state.http.request(method.clone(), url);
    if let Some(v) = headers.get(CONTENT_TYPE) {
        request = request.header(CONTENT_TYPE, v);
    }
    if let Some(v) = headers.get(ACCEPT) {
        request = request.header(ACCEPT, v);
    }
    if !key_in_query(&provider) {
        request = request.bearer_auth(&key);
    }
    if method == Method::POST {
        request = request.body(body);
    }

    let upstream = request.send().await.map_err(|e| {
        log::warn!("proxy {} {provider}: upstream error: {e}", principal.name);
        ApiError::new(StatusCode::BAD_GATEWAY, "couldn't reach the provider")
    })?;
    let status = upstream.status();
    log::info!("proxy {} {provider} {method} -> {status}", principal.name);

    let mut response = Response::builder().status(status);
    if let Some(ct) = upstream.headers().get(CONTENT_TYPE) {
        response = response.header(CONTENT_TYPE, ct);
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|e| ApiError::internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_urls_keep_the_base_path_and_reject_traversal() {
        let url = build_upstream_url("https://api.venice.ai/api/v1", "chat/completions", None, None).unwrap();
        assert_eq!(url.as_str(), "https://api.venice.ai/api/v1/chat/completions");
        assert!(build_upstream_url("https://x.test", "a/../b", None, None).is_err());
        assert!(build_upstream_url("https://x.test", "a/./b", None, None).is_err());
        assert!(build_upstream_url("https://x.test", "a\\b", None, None).is_err());
    }

    #[test]
    fn client_supplied_keys_are_dropped_and_other_params_kept() {
        let url = build_upstream_url("https://yt.test", "youtube/v3/videos", Some("id=abc&key=USERKEY&part=statistics,contentDetails"), Some("key")).unwrap();
        let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert!(pairs.contains(&("id".into(), "abc".into())));
        assert!(pairs.contains(&("part".into(), "statistics,contentDetails".into())));
        assert!(!pairs.iter().any(|(k, _)| k == "key"), "the caller's key must not survive");
    }

    #[test]
    fn trailing_slash_endpoints_are_preserved() {
        let url = build_upstream_url("https://pixabay.com", "api/", Some("q=cats"), Some("key")).unwrap();
        assert_eq!(url.path(), "/api/");
    }

    #[test]
    fn rate_limiter_counts_per_caller() {
        let rl = RateLimiter::default();
        assert!(rl.allow("a", 2));
        assert!(rl.allow("a", 2));
        assert!(!rl.allow("a", 2));
        assert!(rl.allow("b", 2), "other tokens have their own budget");
        assert!(rl.allow("a", 0), "0 = unlimited");
    }
}
