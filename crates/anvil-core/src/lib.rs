//! Shared domain types and validation for Anvil.

use serde::{Deserialize, Serialize};
use std::{fmt, net::IpAddr};
use thiserror::Error;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ValidationError {
    #[error("{field} must not be empty")]
    Empty { field: &'static str },
    #[error("{field} is invalid: {reason}")]
    Invalid { field: &'static str, reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AnvilError {
    #[error("validation failed: {0}")]
    Validation(#[from] ValidationError),
    #[error("serialization failed: {0}")]
    Serialization(String),
    #[error("operation failed: {0}")]
    Operation(String),
}

// ── Project ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
}

impl Project {
    /// Validates: 1–64 chars, ASCII alphanumeric / `-` / `_` / `.`, no `/`, no `..`.
    /// Stored lowercase for DNS safety.
    pub fn new(name: impl AsRef<str>) -> Result<Self, ValidationError> {
        let raw = name.as_ref();
        if raw.is_empty() {
            return Err(ValidationError::Empty { field: "project" });
        }
        if raw.len() > 64 {
            return Err(ValidationError::Invalid {
                field: "project",
                reason: "must be at most 64 characters".into(),
            });
        }
        if !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        {
            return Err(ValidationError::Invalid {
                field: "project",
                reason: "only ASCII letters, digits, '-', '_', '.' allowed".into(),
            });
        }
        if raw.contains('/') {
            return Err(ValidationError::Invalid {
                field: "project",
                reason: "must not contain '/'".into(),
            });
        }
        if raw.contains("..") {
            return Err(ValidationError::Invalid {
                field: "project",
                reason: "must not contain '..'".into(),
            });
        }
        Ok(Self {
            name: raw.to_ascii_lowercase(),
        })
    }
}

// ── Repository (HTTPS-only public URL) ───────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repository {
    pub url: Url,
}

impl Repository {
    /// Validates: HTTPS scheme, host present, no credentials, no query, no fragment.
    pub fn new(url: impl AsRef<str>) -> Result<Self, ValidationError> {
        let url = Url::parse(url.as_ref()).map_err(|e| ValidationError::Invalid {
            field: "repository",
            reason: e.to_string(),
        })?;
        if url.scheme() != "https" {
            return Err(ValidationError::Invalid {
                field: "repository",
                reason: "must use HTTPS".into(),
            });
        }
        if url.host_str().is_none() {
            return Err(ValidationError::Invalid {
                field: "repository",
                reason: "must have a host".into(),
            });
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(ValidationError::Invalid {
                field: "repository",
                reason: "must not contain credentials".into(),
            });
        }
        if url.query().is_some() {
            return Err(ValidationError::Invalid {
                field: "repository",
                reason: "must not contain a query string".into(),
            });
        }
        if url.fragment().is_some() {
            return Err(ValidationError::Invalid {
                field: "repository",
                reason: "must not contain a fragment".into(),
            });
        }
        Ok(Self { url })
    }
}

// ── GitRef ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRef(String);

impl GitRef {
    pub fn new(value: impl AsRef<str>) -> Result<Self, ValidationError> {
        let value = value.as_ref();
        if value.is_empty()
            || value.starts_with('-')
            || value.contains("..")
            || value.ends_with('.')
            || value.ends_with('/')
            || value.contains("@{")
            || value.bytes().any(|b| {
                b.is_ascii_whitespace()
                    || b == b'~'
                    || b == b'^'
                    || b == b':'
                    || b == b'?'
                    || b == b'*'
                    || b == b'['
                    || b == b'\\'
            })
        {
            return Err(ValidationError::Invalid {
                field: "ref",
                reason: "not a valid Git ref".into(),
            });
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for GitRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// ── Prompt ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prompt(String);

impl Prompt {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(ValidationError::Empty { field: "prompt" });
        }
        if value.len() > 32_768 {
            return Err(ValidationError::Invalid {
                field: "prompt",
                reason: "must be at most 32768 bytes".into(),
            });
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// ── Port ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Port(u16);

impl Port {
    pub fn new(value: u16) -> Result<Self, ValidationError> {
        if value == 0 {
            return Err(ValidationError::Invalid {
                field: "port",
                reason: "must be between 1 and 65535".into(),
            });
        }
        Ok(Self(value))
    }
    pub fn get(self) -> u16 {
        self.0
    }
}

// ── SessionId ────────────────────────────────────────────────────────
// Format: `<normalized-project>-<8 random hex chars>`

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct SessionId(String);

impl<'de> Deserialize<'de> for SessionId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        SessionId::parse(&s).ok_or_else(|| serde::de::Error::custom("invalid session id format"))
    }
}

impl SessionId {
    /// Create a new random session ID for the given project.
    pub fn new(project: &Project) -> Self {
        let mut bytes = [0u8; 4];
        getrandom::getrandom(&mut bytes).expect("getrandom failed");
        Self(format!(
            "{}-{:08x}",
            project.name,
            u32::from_be_bytes(bytes)
        ))
    }

    /// Parse a session ID string, validating the `<project>-<8hex>` format.
    pub fn parse(s: &str) -> Option<Self> {
        let (project, hex) = s.rsplit_once('-')?;
        if hex.len() != 8 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        if project.is_empty() || project.len() > 64 {
            return None;
        }
        if !project
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        {
            return None;
        }
        Some(Self(s.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the normalized project portion (before the final `-<hex>`).
    pub fn project(&self) -> &str {
        self.0.rsplit_once('-').map(|(p, _)| p).unwrap_or(&self.0)
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// ── Branch name ──────────────────────────────────────────────────────

pub fn branch_name(session: &SessionId) -> String {
    format!("anvil/{}", session)
}

// ── Preview hostname ─────────────────────────────────────────────────
// Format: `<session>-p<port>.<base_domain>`

pub fn preview_hostname(
    session: &SessionId,
    port: Port,
    base_domain: &str,
) -> Result<String, ValidationError> {
    let domain = base_domain
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if domain.is_empty()
        || domain.parse::<IpAddr>().is_ok()
        || domain.contains('/')
        || domain.contains(':')
    {
        return Err(ValidationError::Invalid {
            field: "base_domain",
            reason: "must be a DNS domain name".into(),
        });
    }
    Ok(format!("{}-p{}.{}", session, port.get(), domain))
}

/// Parse a preview hostname: `<session>-p<port>.<base>`.
///
/// Scans for the port suffix (1–5 digits preceded by `-p`) and validates
/// the session portion with `SessionId::parse`.
pub fn parse_preview_hostname(hostname: &str, base_domain: &str) -> Option<(SessionId, Port)> {
    let suffix = format!(
        ".{}",
        base_domain
            .trim()
            .trim_end_matches('.')
            .to_ascii_lowercase()
    );
    let prefix = hostname.strip_suffix(&suffix)?;

    // Port is 1–5 decimal digits at the end, preceded by literal `-p`.
    // Try each possible port length; first valid session+port wins.
    for port_len in 1..=5 {
        if port_len + 2 > prefix.len() {
            break;
        }
        let port_str = &prefix[prefix.len() - port_len..];
        let sep_start = prefix.len() - port_len - 2;
        if &prefix[sep_start..sep_start + 2] != "-p" {
            continue;
        }
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };
        if port == 0 {
            continue;
        }
        if let Some(session) = SessionId::parse(&prefix[..sep_start]) {
            return Some((session, Port(port)));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Project ──────────────────────────────────────────────────────

    #[test]
    fn project_accepts_valid_names() {
        assert!(Project::new("demo").is_ok());
        assert!(Project::new("my-project").is_ok());
        assert!(Project::new("my_project").is_ok());
        assert!(Project::new("my.project").is_ok());
        assert!(Project::new("a").is_ok());
        assert_eq!(Project::new("A-B_C.1").unwrap().name, "a-b_c.1");
    }

    #[test]
    fn project_rejects_empty() {
        assert!(matches!(
            Project::new(""),
            Err(ValidationError::Empty { field: "project" })
        ));
    }

    #[test]
    fn project_rejects_too_long() {
        assert!(Project::new("a".repeat(65)).is_err());
        assert!(Project::new("a".repeat(64)).is_ok());
    }

    #[test]
    fn project_rejects_slash() {
        assert!(Project::new("bad/name").is_err());
    }

    #[test]
    fn project_rejects_double_dot() {
        assert!(Project::new("bad..name").is_err());
    }

    #[test]
    fn project_rejects_special_chars() {
        assert!(Project::new("bad name").is_err());
        assert!(Project::new("bad@name").is_err());
    }

    #[test]
    fn project_normalizes_to_lowercase() {
        assert_eq!(Project::new("MyProject").unwrap().name, "myproject");
    }

    // ── Repository ───────────────────────────────────────────────────

    #[test]
    fn repository_accepts_https() {
        assert!(Repository::new("https://example.com/repo.git").is_ok());
    }

    #[test]
    fn repository_rejects_http() {
        assert!(Repository::new("http://example.com/repo").is_err());
    }

    #[test]
    fn repository_rejects_ssh() {
        assert!(Repository::new("ssh://git@example.com/repo").is_err());
    }

    #[test]
    fn repository_rejects_credentials() {
        assert!(Repository::new("https://user:pass@example.com/repo").is_err());
        assert!(Repository::new("https://user@example.com/repo").is_err());
    }

    #[test]
    fn repository_rejects_query() {
        assert!(Repository::new("https://example.com/repo?branch=main").is_err());
    }

    #[test]
    fn repository_rejects_fragment() {
        assert!(Repository::new("https://example.com/repo#readme").is_err());
    }

    #[test]
    fn repository_rejects_missing_host() {
        assert!(Repository::new("https://").is_err());
    }

    // ── GitRef ───────────────────────────────────────────────────────

    #[test]
    fn git_ref_valid() {
        assert!(GitRef::new("feature/demo").is_ok());
        assert!(GitRef::new("main").is_ok());
    }

    #[test]
    fn git_ref_rejects_bad() {
        assert!(GitRef::new("bad..ref").is_err());
    }

    // ── Prompt ───────────────────────────────────────────────────────

    #[test]
    fn prompt_valid() {
        assert!(Prompt::new("do it").is_ok());
    }

    // ── Port ─────────────────────────────────────────────────────────

    #[test]
    fn port_valid() {
        assert!(Port::new(8080).is_ok());
        assert!(Port::new(0).is_err());
    }

    // ── SessionId ────────────────────────────────────────────────────

    #[test]
    fn session_id_new_and_parse_roundtrip() {
        let project = Project::new("demo").unwrap();
        let session = SessionId::new(&project);
        let s = session.to_string();
        assert!(s.starts_with("demo-"), "got: {s}");
        assert_eq!(s.len(), "demo-".len() + 8);

        let parsed = SessionId::parse(&s).expect("parse failed");
        assert_eq!(parsed, session);
        assert_eq!(parsed.project(), "demo");
    }

    #[test]
    fn session_id_project_with_dashes() {
        let project = Project::new("my-app").unwrap();
        let session = SessionId::new(&project);
        let s = session.to_string();
        assert!(s.starts_with("my-app-"));
        let parsed = SessionId::parse(&s).unwrap();
        assert_eq!(parsed.project(), "my-app");
    }

    #[test]
    fn session_id_parse_rejects_bad_hex() {
        assert!(SessionId::parse("demo-notahex").is_none());
        assert!(SessionId::parse("demo-abc").is_none()); // too short
        assert!(SessionId::parse("demo-abcdefghij").is_none()); // too long
    }

    #[test]
    fn session_id_parse_rejects_no_dash() {
        assert!(SessionId::parse("nope").is_none());
    }

    #[test]
    fn session_id_display() {
        let project = Project::new("test").unwrap();
        let session = SessionId::new(&project);
        assert_eq!(session.to_string(), session.as_str());
    }

    // ── Branch name ──────────────────────────────────────────────────

    #[test]
    fn branch_name_format() {
        let project = Project::new("demo").unwrap();
        let session = SessionId::new(&project);
        let branch = branch_name(&session);
        assert!(branch.starts_with("anvil/"));
        assert_eq!(branch, format!("anvil/{}", session));
    }

    // ── Preview hostname ─────────────────────────────────────────────

    #[test]
    fn preview_roundtrip_basic() {
        let project = Project::new("demo").unwrap();
        let session = SessionId::new(&project);
        let port = Port::new(3000).unwrap();
        let host = preview_hostname(&session, port, "preview.example.test").unwrap();
        assert_eq!(host, format!("{}-p3000.preview.example.test", session));

        let (s, p) = parse_preview_hostname(&host, "preview.example.test").unwrap();
        assert_eq!(s, session);
        assert_eq!(p, port);
    }

    #[test]
    fn preview_roundtrip_various_ports() {
        let project = Project::new("app").unwrap();
        let session = SessionId::new(&project);
        for port_val in [1, 80, 3000, 8080, 65535] {
            let port = Port::new(port_val).unwrap();
            let host = preview_hostname(&session, port, "preview.test").unwrap();
            let (s, p) = parse_preview_hostname(&host, "preview.test").unwrap();
            assert_eq!(s, session, "port {port_val} session mismatch");
            assert_eq!(p, port, "port {port_val} port mismatch");
        }
    }

    #[test]
    fn preview_rejects_ip_base_domain() {
        let project = Project::new("demo").unwrap();
        let session = SessionId::new(&project);
        assert!(preview_hostname(&session, Port::new(3000).unwrap(), "127.0.0.1").is_err());
    }

    #[test]
    fn parse_preview_rejects_wrong_base_domain() {
        let project = Project::new("demo").unwrap();
        let session = SessionId::new(&project);
        let host =
            preview_hostname(&session, Port::new(3000).unwrap(), "preview.example.test").unwrap();
        assert!(parse_preview_hostname(&host, "other.example.test").is_none());
    }

    #[test]
    fn parse_preview_rejects_garbage() {
        assert!(parse_preview_hostname("not-a-preview.test", "test").is_none());
        assert!(parse_preview_hostname("-p3000.test", "test").is_none());
        assert!(parse_preview_hostname("sess-p0.test", "test").is_none());
    }

    #[test]
    fn parse_preview_trailing_dot() {
        let project = Project::new("demo").unwrap();
        let session = SessionId::new(&project);
        let port = Port::new(8080).unwrap();
        let host = preview_hostname(&session, port, "preview.example.test").unwrap();
        // base_domain with trailing dot should still match
        let result = parse_preview_hostname(&host, "preview.example.test.");
        assert_eq!(result, Some((session, port)));
    }

    // ── Serialization ────────────────────────────────────────────────

    #[test]
    fn project_serializes() {
        let project = Project::new("demo").unwrap();
        let json = serde_json::to_string(&project).unwrap();
        assert_eq!(serde_json::from_str::<Project>(&json).unwrap(), project);
    }

    #[test]
    fn session_id_serializes_as_string() {
        let project = Project::new("demo").unwrap();
        let session = SessionId::new(&project);
        let json = serde_json::to_string(&session).unwrap();
        assert!(json.starts_with("\"demo-"), "unexpected json: {json}");
        let deserialized: SessionId = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, session);
    }

    #[test]
    fn session_id_deserialize_rejects_invalid() {
        assert!(serde_json::from_str::<SessionId>("\"not-valid\"").is_err());
    }
}
