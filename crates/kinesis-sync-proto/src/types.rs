use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::MAX_KEY_LEN;

/// Kinds of synced content. Unknown kinds coming from a newer server are skipped, not fatal,
/// which is why `Item::kind` stays a plain string on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Wdbs,
    Video,
    VideoLink,
    /// One video's membership (and position) in one Drive's sequence — see db/sequences.rs.
    DriveSequence,
    Glossary,
    Biography,
    CustomPrompt,
}

impl Kind {
    /// Order in which kinds must be applied: taxonomy before videos (the production schema
    /// validates `videos.WDBS`), links and sequence memberships after both (each needs its video
    /// to already exist).
    pub const APPLY_ORDER: [Kind; 7] = [
        Kind::Wdbs,
        Kind::Video,
        Kind::VideoLink,
        Kind::DriveSequence,
        Kind::Glossary,
        Kind::Biography,
        Kind::CustomPrompt,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Wdbs => "wdbs",
            Kind::Video => "video",
            Kind::VideoLink => "video_link",
            Kind::DriveSequence => "drive_sequence",
            Kind::Glossary => "glossary",
            Kind::Biography => "biography",
            Kind::CustomPrompt => "custom_prompt",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        Kind::APPLY_ORDER.iter().copied().find(|k| k.as_str() == s)
    }

    /// Position in `APPLY_ORDER`, used to sort a mixed batch.
    pub fn order(self) -> usize {
        Kind::APPLY_ORDER.iter().position(|k| *k == self).unwrap_or(usize::MAX)
    }
}

/// One synced row (upsert). `data` is the kind-specific payload (see the `*Data` structs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub kind: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<u64>,
    #[serde(default)]
    pub hash: String,
    pub data: Value,
}

/// A row the server no longer has.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tombstone {
    pub kind: String,
    pub key: String,
    #[serde(default)]
    pub rev: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Capabilities {
    #[serde(default)]
    pub content: bool,
    #[serde(default)]
    pub policy: bool,
    /// Providers reachable through `/api/v1/proxy/{provider}/...`: "venice", "youtube", "pixabay".
    #[serde(default)]
    pub license: Vec<String>,
}

/// `GET /api/v1/manifest`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub server_name: String,
    pub protocol_version: u32,
    #[serde(default)]
    pub min_client_version: String,
    pub pack_version: u32,
    pub revision: u64,
    /// Identifies which revision history `revision` belongs to. Revision numbers only mean
    /// something within one epoch: a server whose state was reset (or replaced) starts a new epoch,
    /// and a client that last synced under a different one must do a full resync, whatever its
    /// cursor happens to be. Empty from servers that predate this field (the client then skips the check).
    #[serde(default)]
    pub epoch: String,
    /// Oldest revision the server can still produce a delta from. A client whose cursor is older
    /// must do a full resync.
    #[serde(default)]
    pub retention_revision: u64,
    #[serde(default)]
    pub capabilities: Capabilities,
    /// "fallback" (own key wins, default) or "enforce" (always use the proxy).
    #[serde(default)]
    pub license_mode: String,
}

/// `GET /api/v1/changes`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangesPage {
    pub revision: u64,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub upserts: Vec<Item>,
    #[serde(default)]
    pub deletes: Vec<Tombstone>,
}

/// `GET /api/v1/policy` (also the `policy` line of a pack).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Policy {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub settings: BTreeMap<String, String>,
    /// Keys the user may not change locally. Values for these come from `settings`.
    #[serde(default)]
    pub locked: Vec<String>,
}

// ---- Per-kind payloads. Option fields: `None` (JSON null / absent) never clobbers a local value.

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct WdbsData {
    #[serde(default)]
    pub lev: Option<i64>,
    #[serde(default)]
    pub wdid: Option<String>,
    /// Alias shown in place of the path segment.
    #[serde(default)]
    pub info: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub default: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct VideoData {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub length_seconds: Option<i64>,
    #[serde(default)]
    pub transcript: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub view_count: Option<i64>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub wdbs: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct VideoLinkData {
    pub video_id: String,
    pub wdbs: String,
}

/// One video's place in one Drive's sequence. `drive` is the display path (":CS-DSA"), matching
/// what `wdbs` items are keyed by; `position` only has to be in the right relative order among a
/// drive's items, not contiguous or gap-free — see db/sequences.rs's own module comment.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SequenceData {
    pub drive: String,
    pub video_id: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct GlossaryData {
    #[serde(default)]
    pub definition: Option<String>,
    /// Top-level Drives (":CRYPTO") a Standard Glossary Tag is filed under. `Some` is the complete
    /// set (an empty list uncategorizes the term); `None` means the sender doesn't know about drive
    /// assignments at all (an older server or pack), and the receiver leaves its own untouched.
    #[serde(default)]
    pub drives: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct BiographyData {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub wikipedia: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub twitter: Option<String>,
    #[serde(default)]
    pub instagram: Option<String>,
    #[serde(default)]
    pub facebook: Option<String>,
    #[serde(default)]
    pub threads: Option<String>,
    #[serde(default)]
    pub youtube: Option<String>,
    #[serde(default)]
    pub tiktok: Option<String>,
    #[serde(default)]
    pub twitch: Option<String>,
    #[serde(default)]
    pub reddit: Option<String>,
    #[serde(default)]
    pub discord: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub subscriber_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CustomPromptData {
    #[serde(default)]
    pub local_prompt_text: Option<String>,
    #[serde(default)]
    pub cloud_prompt_text: Option<String>,
}

/// Composite key for `video_link` items: `video_id|wdbs`. `|` cannot appear in a YouTube id, so
/// splitting on the first one is unambiguous.
pub fn link_key(video_id: &str, wdbs: &str) -> String {
    format!("{video_id}|{wdbs}")
}

pub fn split_link_key(key: &str) -> Option<(&str, &str)> {
    key.split_once('|').filter(|(v, w)| !v.is_empty() && !w.is_empty())
}

/// Composite key for `drive_sequence` items: `drive|video_id`. A Drive path can't contain `|`
/// (normalize_drive restricts it to `:`, letters, digits and `-`), so splitting on the first one
/// is unambiguous even though a video id can contain other punctuation.
pub fn sequence_key(drive: &str, video_id: &str) -> String {
    format!("{drive}|{video_id}")
}

pub fn split_sequence_key(key: &str) -> Option<(&str, &str)> {
    key.split_once('|').filter(|(d, v)| !d.is_empty() && !v.is_empty())
}

/// Rejects keys that are empty, oversized or contain control characters.
pub fn validate_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("empty key".into());
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!("key longer than {MAX_KEY_LEN} bytes"));
    }
    if key.chars().any(|c| c.is_control()) {
        return Err("key contains control characters".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trips_and_orders() {
        for k in Kind::APPLY_ORDER {
            assert_eq!(Kind::parse(k.as_str()), Some(k));
        }
        assert_eq!(Kind::parse("nope"), None);
        assert!(Kind::Wdbs.order() < Kind::Video.order());
        assert!(Kind::Video.order() < Kind::VideoLink.order());
    }

    #[test]
    fn link_key_round_trips() {
        let k = link_key("abc123", ":UAP-GERB");
        assert_eq!(split_link_key(&k), Some(("abc123", ":UAP-GERB")));
        assert_eq!(split_link_key("nopipe"), None);
        assert_eq!(split_link_key("|x"), None);
    }

    #[test]
    fn sequence_key_round_trips() {
        let k = sequence_key(":CS-DSA", "abc123");
        assert_eq!(k, ":CS-DSA|abc123");
        assert_eq!(split_sequence_key(&k), Some((":CS-DSA", "abc123")));
        assert_eq!(split_sequence_key("nopipe"), None);
        assert_eq!(split_sequence_key("|x"), None);
        assert_eq!(split_sequence_key("x|"), None);
    }

    #[test]
    fn key_validation() {
        assert!(validate_key("abc").is_ok());
        assert!(validate_key("").is_err());
        assert!(validate_key("a\nb").is_err());
        assert!(validate_key(&"x".repeat(MAX_KEY_LEN + 1)).is_err());
    }

    #[test]
    fn payloads_tolerate_missing_fields() {
        let v: VideoData = serde_json::from_str(r#"{"title":"t"}"#).unwrap();
        assert_eq!(v.title.as_deref(), Some("t"));
        assert!(v.transcript.is_none());
    }
}
