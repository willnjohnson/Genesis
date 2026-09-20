//! Which `settings` rows may travel through sync, export/import and admin policy.
//!
//! The local `settings` table mixes harmless UI config with secrets (API keys) and machine-local
//! state (DB path, export folder, migration flags). Everything crossing a trust boundary goes
//! through this module: a key must be on the allowlist AND not on the denylist.

/// Every feature flag: `(key, default)`. A flag is a row in the `settings` table that a DB owner
/// (editing the database, or a sync server's policy) sets to shape the app for their users. Yes/no
/// flags hold `true`/`false` (`1`/`0`, `yes`/`no`, `on`/`off` also work); a missing or unreadable
/// value means the default below. Each key is seeded into every database with its default so
/// `SELECT * FROM settings` lists what can be changed, and all of them can be enforced by a sync
/// server. The UI's copy of the defaults is `src/lib/flags.ts` (a test keeps the two in step), and
/// docs/customizing.md describes each one.
pub const FEATURE_FLAGS: &[(&str, &str)] = &[
    // ── Main views
    ("showSearch", "true"),
    ("showLibrary", "true"),
    ("showGlossary", "true"),
    ("showBiography", "true"),
    ("showDrive", "true"),
    // Which view opens first: search, library, glossary or biography (a hidden view falls back).
    ("defaultView", "search"),
    // ── Library and search results
    ("showSortControls", "true"),
    ("showFilterControls", "true"),
    ("showListModeToggle", "true"),
    ("hideShortsInSearch", "true"),
    ("showSearchHistory", "true"),
    ("saveSearchHistory", "true"),
    ("allowClearHistory", "true"),
    // ── Saving, deleting, bulk actions
    ("allowSaveToLibrary", "true"),
    ("allowSaveAll", "true"),
    ("allowDeletionLibrary", "true"),
    ("allowSummarizeAll", "true"),
    // ── Video detail panel
    ("showVideoPlayer", "true"),
    ("showOpenInYouTube", "true"),
    ("showVideoTags", "true"),
    ("showSimilarVideos", "true"),
    ("showAttachments", "true"),
    ("editAttachments", "true"),
    ("allowEditTags", "true"),
    ("allowEditSummary", "true"),
    ("allowEditTranscript", "true"),
    ("allowEditTranscriptOnNA", "true"),
    ("allowEditWDBS", "false"),
    ("showCustomPrompt", "true"),
    ("setTranscriptAfterSummarizeToNA", "false"),
    // ── AI summarize and image tools
    ("showSummarizeButton", "false"),
    ("showSummarizeOllama", "true"),
    ("showSummarizeVenice", "true"),
    ("showSynthesizeVenice", "true"),
    ("showSynthesizePixabay", "true"),
    ("showSynthesizeUpload", "true"),
    // ── Glossary and biographies
    ("allowModificationGlossary", "true"),
    ("showQuickTags", "true"),
    ("showGlossaryDriveFilter", "true"),
    ("showGlossarySearchByTag", "true"),
    ("showGlossarySearchInLibrary", "true"),
    ("allowEditBio", "true"),
    // ── Workspace names (the names themselves live in the `WorkspaceLabels` table)
    // Off hides the Advanced section where Search, Library, Drive, ... can be renamed.
    ("showWorkspaceAdvanced", "true"),
    // Off locks the workspace name once one has been set.
    ("allowWorkspaceRename", "true"),
    // ── Settings window: the whole thing, each tab, and controls inside them
    ("showSettings", "true"),
    ("showTabApiKey", "true"),
    ("showTabDatabase", "true"),
    ("showTabDisplay", "true"),
    ("showTabTheme", "true"),
    ("showTabHistory", "true"),
    ("showTabPlugins", "true"),
    ("showTabSync", "true"),
    ("showTabExport", "true"),
    ("showExportObsidian", "true"),
    // Also needs showTabSync: a pack is part of the sync feature.
    ("showExportSyncData", "true"),
    ("allowSyncImport", "true"),
    ("allowSyncDisconnect", "true"),
    ("allowChangeDbLocation", "true"),
    ("allowOpenDbFolder", "true"),
    ("allowOllamaSetup", "true"),
    ("allowEditPrompts", "true"),
    ("allowCustomThemes", "true"),
];

/// Other settings an admin may enforce and a pack may carry (the feature flags above are always
/// included as well).
pub const SYNCABLE_SETTINGS: &[&str] = &[
    // Feature / visibility flags (seeded in db/schema.rs)
    "showSearch",
    "allowDeletionLibrary",
    "allowModificationGlossary",
    "showSummarizeButton",
    "showSummarizeOllama",
    "showSummarizeVenice",
    "showSynthesizeVenice",
    "showSynthesizePixabay",
    "showSynthesizeUpload",
    "showGlossarySearchByTag",
    "showGlossarySearchInLibrary",
    "showBiography",
    "showDrive",
    "showCustomPrompt",
    "allowEditBio",
    "allowEditTranscriptOnNA",
    "allowEditWDBS",
    // Behaviour
    "hideShortsInSearch",
    "setTranscriptAfterSummarizeToNA",
    // Display / theme (resolution and fullscreen are machine specific and intentionally absent)
    "theme",
    "customThemes",
    "video_list_mode",
    "navigation_orientation",
    // AI behaviour (never the keys)
    "summarize_provider",
    "ollama_model",
    "ollama_prompt",
    "chunk_enabled",
    "chunk_size",
    "chunk_overlap",
    "max_chunks",
    "venice_model",
    "venice_prompt",
    // Search history: how long entries are kept ("never", "6m", "3m", "1m")
    "searchHistoryClearAfter",
    // Plugins
    "plugin_summarize_enabled",
    "plugin_photosynthesis_enabled",
];

/// Keys that must never cross the boundary, even if someone adds them to the allowlist by mistake.
pub fn is_denied_setting(key: &str) -> bool {
    let k = key.trim();
    k.eq_ignore_ascii_case("api_key")
        || k.to_ascii_lowercase().ends_with("_api_key")
        || k.to_ascii_lowercase().contains("token")
        || k.to_ascii_lowercase().contains("secret")
        || k.starts_with("sync_")
        || k.starts_with("migrated")
        || k == "obsidianExportPath"
        || k == "db_path"
        || k == "sidebarSplitPercent"
}

/// True when `key` may be exported, imported, or set by server policy.
pub fn is_syncable_setting(key: &str) -> bool {
    !is_denied_setting(key) && (SYNCABLE_SETTINGS.contains(&key) || FEATURE_FLAGS.iter().any(|(k, _)| *k == key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_never_syncable() {
        for k in ["api_key", "venice_api_key", "pixabay_api_key", "sync_token", "sync_server_url", "migratedWdbsPlaceholder", "obsidianExportPath"] {
            assert!(is_denied_setting(k), "{k} should be denied");
            assert!(!is_syncable_setting(k), "{k} should not be syncable");
        }
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert!(!is_syncable_setting("some_new_setting"));
        assert!(!is_syncable_setting(""));
    }

    #[test]
    fn known_flags_are_syncable() {
        for k in ["showBiography", "plugin_summarize_enabled", "venice_model", "customThemes"] {
            assert!(is_syncable_setting(k), "{k} should be syncable");
        }
    }

    #[test]
    fn every_feature_flag_is_syncable_seeded_sanely_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for (key, default) in FEATURE_FLAGS {
            assert!(seen.insert(*key), "duplicate flag {key}");
            assert!(is_syncable_setting(key), "{key} must be enforceable by a sync server");
            assert!(!is_denied_setting(key), "{key}");
            let ok = matches!(*default, "true" | "false") || (*key == "defaultView" && *default == "search");
            assert!(ok, "{key} has an unexpected default {default:?}");
        }
        assert!(FEATURE_FLAGS.len() > 50);
    }

    #[test]
    fn allowlist_contains_nothing_denied() {
        for k in SYNCABLE_SETTINGS {
            assert!(!is_denied_setting(k), "allowlist entry {k} is on the denylist");
        }
    }
}
