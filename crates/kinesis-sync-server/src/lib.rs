//! Reference sync server for Kinesis (protocol: docs/sync-protocol.md).
//!
//! Serves a curated Kinesis database (the "master", opened read-only), admin policy read from the
//! same database's settings, and an optional provider license via a key-injecting proxy.

pub mod api;
pub mod config;
pub mod proxy;
pub mod store;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::routing::{any, get};
use axum::Router;
use tower_http::compression::CompressionLayer;

use config::Config;
use store::{open_master, ScanStats, Store};

/// Upper bound for a proxied request body (chat prompts with long transcripts).
const MAX_PROXY_BODY_BYTES: usize = 16 * 1024 * 1024;

pub struct AppState {
    pub config: Config,
    pub store: Store,
    pub http: reqwest::Client,
    pub limiter: proxy::RateLimiter,
}

pub fn build_state(config: Config) -> Result<Arc<AppState>, String> {
    let store = Store::open(&config.state_db)?;
    let http = reqwest::Client::builder()
        .user_agent(concat!("kinesis-sync-server/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        // Chat completions can be slow; the caller has its own timeout.
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Arc::new(AppState { config, store, http, limiter: Default::default() }))
}

/// Rescans the master database (blocking; call from `spawn_blocking` in async code).
pub fn scan_once(state: &AppState) -> Result<ScanStats, String> {
    let master = open_master(&state.config.master_db)?;
    state.store.scan(&master, state.config.retention_revisions, state.config.allow_mass_removal)
}

/// Serves the API on an already-bound listener until it fails.
pub async fn serve(listener: tokio::net::TcpListener, state: Arc<AppState>) -> std::io::Result<()> {
    axum::serve(listener, router(state)).await
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(api::health))
        .route("/api/v1/manifest", get(api::manifest))
        .route("/api/v1/changes", get(api::changes))
        .route("/api/v1/policy", get(api::policy))
        .route("/api/v1/proxy/:provider/*rest", any(proxy::proxy))
        .layer(DefaultBodyLimit::max(MAX_PROXY_BODY_BYTES))
        .layer(CompressionLayer::new())
        .with_state(state)
}
