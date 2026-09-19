//! Shared protocol definitions for Kinesis sync.
//!
//! Used by both the Kinesis client (`src-tauri`) and the reference sync server so the two
//! cannot drift: wire types, the settings allowlist, canonical content hashing and the
//! NDJSON "sync pack" codec all live here.

pub mod hash;
pub mod pack;
pub mod settings;
#[cfg(feature = "sqlite")]
pub mod sqlite;
pub mod types;

pub use hash::{canonical_json, content_hash};
pub use pack::{PackLine, PackReader, PackWriter};
pub use settings::{is_denied_setting, is_syncable_setting, FEATURE_FLAGS, SYNCABLE_SETTINGS};
pub use types::*;

/// Wire protocol version spoken over HTTP. Bumped only on breaking changes.
pub const PROTOCOL_VERSION: u32 = 1;
/// Version of the on-disk pack format (NDJSON export/import).
pub const PACK_VERSION: u32 = 1;
/// Identifier written into every pack header.
pub const PACK_FORMAT: &str = "kinesis-sync-pack";

/// Upper bound the client will accept for `limit` / items per `/changes` page.
pub const MAX_PAGE_ITEMS: usize = 1000;
/// Upper bound for one serialized item (transcripts can be large, but not unbounded).
pub const MAX_ITEM_BYTES: usize = 8 * 1024 * 1024;
/// Upper bound for a key (video id, WDBS path, glossary term, handle...).
pub const MAX_KEY_LEN: usize = 512;
