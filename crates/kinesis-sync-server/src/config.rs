use std::path::{Path, PathBuf};

use kinesis_sync_proto::is_syncable_setting;
use serde::Deserialize;

pub const PROVIDERS: [&str; 3] = ["venice", "youtube", "pixabay"];

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default = "default_name")]
    pub server_name: String,
    /// The admin's Kinesis database. Opened read-only; curate it with the Kinesis app itself.
    pub master_db: PathBuf,
    /// This server's own bookkeeping (revision log). Created on first run.
    #[serde(default = "default_state_db")]
    pub state_db: PathBuf,
    /// Seconds between rescans of the master database. 0 = scan only at startup.
    #[serde(default = "default_scan_interval")]
    pub scan_interval_secs: u64,
    /// Deletions are remembered for this many revisions; clients further behind do a full resync.
    #[serde(default = "default_retention")]
    pub retention_revisions: u64,
    #[serde(default = "default_page_max")]
    pub page_max: usize,
    /// Oldest client app version allowed to sync ("" = any).
    #[serde(default)]
    pub min_client_version: String,
    /// "fallback" (a user's own provider key wins) or "enforce" (always use this server's proxy).
    #[serde(default = "default_license_mode")]
    pub license_mode: String,
    /// Requests per token per minute across the proxy. 0 = unlimited.
    #[serde(default)]
    pub proxy_rate_limit_per_minute: u32,
    /// Permit a scan that would remove most of the catalogue (guards against a wrong master_db).
    #[serde(default)]
    pub allow_mass_removal: bool,
    /// Allow requests with no token (they get content and policy, never a license).
    #[serde(default)]
    pub allow_anonymous: bool,
    #[serde(default)]
    pub policy: PolicyConfig,
    #[serde(default)]
    pub tokens: Vec<TokenConfig>,
    #[serde(default)]
    pub providers: Providers,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PolicyConfig {
    /// Settings every client must follow. Values are read from the master database's `settings`
    /// table; only keys on the sync allowlist are accepted.
    #[serde(default)]
    pub enforced: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenConfig {
    pub name: String,
    pub token: String,
    /// Providers this token may use through the proxy: "venice", "youtube", "pixabay".
    #[serde(default)]
    pub licenses: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProviderConfig {
    /// Literal key. Prefer `api_key_env` so the secret stays out of the config file.
    pub api_key: Option<String>,
    /// Environment variable holding the key (defaults to VENICE_API_KEY, YOUTUBE_API_KEY, PIXABAY_API_KEY).
    pub api_key_env: Option<String>,
    /// Upstream base URL override (testing, or a regional endpoint).
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Providers {
    #[serde(default)]
    pub venice: ProviderConfig,
    #[serde(default)]
    pub youtube: ProviderConfig,
    #[serde(default)]
    pub pixabay: ProviderConfig,
}

impl Providers {
    pub fn get(&self, provider: &str) -> Option<&ProviderConfig> {
        match provider {
            "venice" => Some(&self.venice),
            "youtube" => Some(&self.youtube),
            "pixabay" => Some(&self.pixabay),
            _ => None,
        }
    }
}

impl ProviderConfig {
    fn default_env(provider: &str) -> &'static str {
        match provider {
            "venice" => "VENICE_API_KEY",
            "youtube" => "YOUTUBE_API_KEY",
            _ => "PIXABAY_API_KEY",
        }
    }

    pub fn resolve_key(&self, provider: &str) -> Option<String> {
        self.api_key
            .clone()
            .filter(|k| !k.trim().is_empty())
            .or_else(|| {
                let var = self.api_key_env.as_deref().unwrap_or(Self::default_env(provider));
                std::env::var(var).ok().filter(|k| !k.trim().is_empty())
            })
    }

    pub fn base_url(&self, provider: &str) -> String {
        let default = match provider {
            "venice" => "https://api.venice.ai/api/v1",
            "youtube" => "https://youtube.googleapis.com",
            _ => "https://pixabay.com",
        };
        self.base_url.clone().unwrap_or_else(|| default.to_string()).trim_end_matches('/').to_string()
    }
}

fn default_bind() -> String {
    "127.0.0.1:8787".into()
}
fn default_name() -> String {
    "Kinesis Sync Server".into()
}
fn default_state_db() -> PathBuf {
    PathBuf::from("sync_server_state.db")
}
fn default_scan_interval() -> u64 {
    30
}
fn default_retention() -> u64 {
    100_000
}
fn default_page_max() -> usize {
    500
}
fn default_license_mode() -> String {
    "fallback".into()
}

impl Config {
    pub fn load(path: &Path) -> Result<Config, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("can't read {}: {e}", path.display()))?;
        let config: Config = toml::from_str(&text).map_err(|e| format!("invalid config: {e}"))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.tokens.is_empty() && !self.allow_anonymous {
            return Err("configure at least one [[tokens]] entry, or set allow_anonymous = true".into());
        }
        for t in &self.tokens {
            if t.token.trim().len() < 16 {
                return Err(format!("token for '{}' is too short (use at least 16 characters)", t.name));
            }
            for l in &t.licenses {
                if !PROVIDERS.contains(&l.as_str()) {
                    return Err(format!("token '{}' has unknown license '{l}' (expected one of {PROVIDERS:?})", t.name));
                }
            }
        }
        let mut names: Vec<&str> = self.tokens.iter().map(|t| t.name.as_str()).collect();
        names.sort();
        if names.windows(2).any(|w| w[0] == w[1]) {
            return Err("token names must be unique".into());
        }
        let bad: Vec<&str> = self.policy.enforced.iter().map(String::as_str).filter(|k| !is_syncable_setting(k)).collect();
        if !bad.is_empty() {
            return Err(format!("policy.enforced contains settings that can't be managed remotely: {}", bad.join(", ")));
        }
        if self.license_mode != "fallback" && self.license_mode != "enforce" {
            return Err("license_mode must be \"fallback\" or \"enforce\"".into());
        }
        if self.page_max == 0 {
            return Err("page_max must be at least 1".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(extra: &str) -> Result<Config, String> {
        let config: Config = toml::from_str(&format!("master_db = \"m.db\"\n{extra}")).map_err(|e| e.to_string())?;
        config.validate()?;
        Ok(config)
    }

    #[test]
    fn needs_a_token_or_explicit_anonymous_access() {
        assert!(parse("").is_err());
        assert!(parse("allow_anonymous = true").is_ok());
        assert!(parse("[[tokens]]\nname = \"a\"\ntoken = \"0123456789abcdef\"").is_ok());
    }

    #[test]
    fn weak_tokens_and_bad_licenses_are_rejected() {
        assert!(parse("[[tokens]]\nname = \"a\"\ntoken = \"short\"").unwrap_err().contains("too short"));
        let err = parse("[[tokens]]\nname = \"a\"\ntoken = \"0123456789abcdef\"\nlicenses = [\"openai\"]").unwrap_err();
        assert!(err.contains("unknown license"), "{err}");
    }

    #[test]
    fn policy_cannot_enforce_secrets() {
        let err = parse("allow_anonymous = true\n[policy]\nenforced = [\"showDrive\", \"venice_api_key\"]").unwrap_err();
        assert!(err.contains("venice_api_key"), "{err}");
        assert!(parse("allow_anonymous = true\n[policy]\nenforced = [\"showDrive\"]").is_ok());
    }

    #[test]
    fn provider_keys_come_from_config_or_environment() {
        let p = ProviderConfig { api_key: Some("literal".into()), ..Default::default() };
        assert_eq!(p.resolve_key("venice").as_deref(), Some("literal"));
        let none = ProviderConfig { api_key_env: Some("KINESIS_TEST_DEFINITELY_UNSET".into()), ..Default::default() };
        assert!(none.resolve_key("venice").is_none());
        assert_eq!(ProviderConfig::default().base_url("venice"), "https://api.venice.ai/api/v1");
    }
}
