//! HTTP handlers for the sync protocol (docs/sync-protocol.md).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use kinesis_sync_proto::sqlite::{self, ReadOptions};
use kinesis_sync_proto::{
    Capabilities, ChangesPage, Item, Kind, Manifest, Policy, Tombstone, MAX_PAGE_ITEMS, PACK_VERSION, PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::json;

use crate::config::PROVIDERS;
use crate::store::{open_master, Entry, PageResult};
use crate::AppState;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError { status, message: message.into() }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        let message = message.into();
        log::error!("{message}");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

/// Who is calling, from their bearer token.
#[derive(Debug, Clone)]
pub struct Principal {
    pub name: String,
    pub licenses: Vec<String>,
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Principal, ApiError> {
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    match bearer {
        Some(presented) => {
            // Compare against every token (no early exit) so timing doesn't reveal which matched.
            let mut found: Option<Principal> = None;
            for t in &state.config.tokens {
                if ct_eq(presented.as_bytes(), t.token.as_bytes()) {
                    found = Some(Principal { name: t.name.clone(), licenses: t.licenses.clone() });
                }
            }
            found.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "invalid access token"))
        }
        None if state.config.allow_anonymous => Ok(Principal { name: "anonymous".into(), licenses: vec![] }),
        None => Err(ApiError::new(StatusCode::UNAUTHORIZED, "an access token is required")),
    }
}

/// Providers this principal can actually use: licensed for them AND the server holds a key.
fn usable_licenses(state: &AppState, principal: &Principal) -> Vec<String> {
    PROVIDERS
        .iter()
        .filter(|p| principal.licenses.iter().any(|l| l == *p))
        .filter(|p| state.config.providers.get(p).and_then(|cfg| cfg.resolve_key(p)).is_some())
        .map(|p| p.to_string())
        .collect()
}

pub async fn health() -> &'static str {
    "ok"
}

pub async fn manifest(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<Manifest>, ApiError> {
    let principal = authenticate(&state, &headers)?;
    let (revision, retention_revision) = state.store.revisions().map_err(ApiError::internal)?;
    let epoch = state.store.epoch().map_err(ApiError::internal)?;
    Ok(Json(Manifest {
        server_name: state.config.server_name.clone(),
        protocol_version: PROTOCOL_VERSION,
        min_client_version: state.config.min_client_version.clone(),
        pack_version: PACK_VERSION,
        revision,
        epoch,
        retention_revision,
        capabilities: Capabilities { content: true, policy: true, license: usable_licenses(&state, &principal) },
        license_mode: state.config.license_mode.clone(),
    }))
}

pub async fn policy(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<Policy>, ApiError> {
    authenticate(&state, &headers)?;
    let st = state.clone();
    let policy = tokio::task::spawn_blocking(move || -> Result<Policy, String> {
        let master = open_master(&st.config.master_db)?;
        let (head, _) = st.store.revisions()?;
        let available = sqlite::read_syncable_settings(&master);
        let mut policy = Policy { revision: head, ..Policy::default() };
        for key in &st.config.policy.enforced {
            if let Some(value) = available.get(key) {
                policy.settings.insert(key.clone(), value.clone());
                policy.locked.push(key.clone());
            }
        }
        Ok(policy)
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(ApiError::internal)?;
    Ok(Json(policy))
}

#[derive(Debug, Deserialize)]
pub struct ChangesQuery {
    since: Option<u64>,
    limit: Option<usize>,
    snapshot: Option<String>,
}

pub async fn changes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ChangesQuery>,
) -> Result<Response, ApiError> {
    authenticate(&state, &headers)?;
    let since = q.since.unwrap_or(0);
    let snapshot = q.snapshot.as_deref() == Some("1");
    let limit = q.limit.unwrap_or(200).clamp(1, state.config.page_max.min(MAX_PAGE_ITEMS));

    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Option<ChangesPage>, String> {
        let page = match st.store.page(since, limit, snapshot)? {
            PageResult::ResyncRequired => return Ok(None),
            PageResult::Page(p) => p,
        };
        let master = open_master(&st.config.master_db)?;
        let opts = ReadOptions::default();
        let mut out = ChangesPage { revision: page.revision, has_more: page.has_more, upserts: vec![], deletes: vec![] };
        for Entry { kind, key, rev, deleted } in page.entries {
            if deleted {
                out.deletes.push(Tombstone { kind, key, rev });
                continue;
            }
            let Some(parsed) = Kind::parse(&kind) else { continue };
            // A row can vanish between the scan and now; its tombstone arrives with the next scan.
            if let Some(data) = sqlite::load_item(&master, parsed, &key, &opts)? {
                let hash = kinesis_sync_proto::content_hash(&kind, &key, &data);
                out.upserts.push(Item { kind, key, rev: Some(rev), hash, data });
            }
        }
        Ok(Some(out))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
    .map_err(ApiError::internal)?;

    match result {
        Some(page) => Ok(Json(page).into_response()),
        None => Ok(ApiError::new(StatusCode::GONE, "resync_required").into_response()),
    }
}
