use anvil_api::{CheckConclusion, ExternalState, TurnContext, Verdict};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const DEFAULT_NAME: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionContinuity {
    Fresh,
    Continuous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultStrategy {
    pub session: SessionContinuity,
    pub verify_cmd: Option<String>,
    pub turn_timeout_secs: Option<u64>,
    pub session_tokens: i64,
    pub ignore_checks: Vec<String>,
}

pub const DEFAULT_SESSION_TOKENS: i64 = 400_000;

impl Default for DefaultStrategy {
    fn default() -> Self {
        Self {
            session: SessionContinuity::Continuous,
            verify_cmd: None,
            turn_timeout_secs: None,
            session_tokens: DEFAULT_SESSION_TOKENS,
            ignore_checks: Vec::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StrategyError {
    #[error("unknown strategy: {name}")]
    Unknown { name: String },
    #[error("invalid strategy field {field}: {value}")]
    Invalid { field: &'static str, value: String },
    #[error("strategy config must be a JSON object or null, got: {value}")]
    Malformed { value: String },
}

pub fn parse(config: &Value) -> Result<DefaultStrategy, StrategyError> {
    let Value::Object(fields) = config else {
        if config.is_null() {
            return Ok(DefaultStrategy::default());
        }
        return Err(StrategyError::Malformed {
            value: config.to_string(),
        });
    };
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_NAME);
    if name != DEFAULT_NAME {
        return Err(StrategyError::Unknown {
            name: name.to_owned(),
        });
    }
    let session = match fields.get("session").and_then(Value::as_str) {
        None | Some("continuous") => SessionContinuity::Continuous,
        Some("fresh") => SessionContinuity::Fresh,
        Some(other) => {
            return Err(StrategyError::Invalid {
                field: "session",
                value: other.to_owned(),
            })
        }
    };
    let verify_cmd = match fields.get("verify_cmd") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) if !raw.is_empty() => Some(raw.clone()),
        Some(other) => {
            return Err(StrategyError::Invalid {
                field: "verify_cmd",
                value: other.to_string(),
            })
        }
    };
    let turn_timeout_secs = match fields.get("turn_timeout_secs") {
        None | Some(Value::Null) => None,
        Some(Value::Number(raw)) if raw.as_u64().is_some_and(|n| n > 0) => raw.as_u64(),
        Some(other) => {
            return Err(StrategyError::Invalid {
                field: "turn_timeout_secs",
                value: other.to_string(),
            })
        }
    };
    let session_tokens = match fields.get("session_tokens") {
        None | Some(Value::Null) => DEFAULT_SESSION_TOKENS,
        Some(Value::Number(raw)) if raw.as_i64().is_some_and(|n| n > 0) => {
            raw.as_i64().unwrap_or(DEFAULT_SESSION_TOKENS)
        }
        Some(other) => {
            return Err(StrategyError::Invalid {
                field: "session_tokens",
                value: other.to_string(),
            })
        }
    };
    let ignore_checks = match fields.get("ignore_checks") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(raw)) => raw
            .iter()
            .map(|entry| entry.as_str().unwrap_or_default().to_owned())
            .filter(|entry| !entry.is_empty())
            .collect(),
        Some(other) => {
            return Err(StrategyError::Invalid {
                field: "ignore_checks",
                value: other.to_string(),
            })
        }
    };
    Ok(DefaultStrategy {
        session,
        verify_cmd,
        turn_timeout_secs,
        session_tokens,
        ignore_checks,
    })
}

pub fn resolve(campaign: &Value, commission: &Value) -> Value {
    let empty = |value: &Value| {
        value.is_null() || value.as_object().is_some_and(|fields| fields.is_empty())
    };
    if empty(commission) {
        campaign.clone()
    } else {
        commission.clone()
    }
}

impl DefaultStrategy {
    pub fn compose_turn(&self, ctx: &TurnContext) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();

        let _ = writeln!(out, "# Campaign: {}", ctx.campaign_name);
        let _ = writeln!(out);
        write_layer(
            &mut out,
            &ctx.campaign_context,
            "No campaign context provided.",
        );

        let _ = writeln!(out, "# Commission: {}", ctx.commission_title);
        let _ = writeln!(out);
        write_layer(
            &mut out,
            &ctx.commission_spec,
            "No commission spec provided. Infer scope from the obligations below.",
        );

        let _ = writeln!(out, "# Obligations");
        let _ = writeln!(out);
        if ctx.obligations.is_empty() {
            let _ = writeln!(
                out,
                "None yet. Establish the commission scope with the operator."
            );
        } else {
            for (i, text) in ctx.obligations.iter().enumerate() {
                let _ = writeln!(out, "{}. {}", i + 1, text);
            }
            let _ = writeln!(out);
        }

        if !ctx.gaps.is_empty() {
            let _ = writeln!(out, "# Current gaps");
            let _ = writeln!(out);
            for gap in &ctx.gaps {
                let _ = writeln!(out, "- {gap}");
            }
            let _ = writeln!(out);
        }

        let _ = writeln!(out, "# Live state");
        let _ = writeln!(out);
        if ctx.external.checks.is_empty() {
            let _ = writeln!(out, "- PR checks: none reported yet");
        } else {
            for check in &ctx.external.checks {
                let state = match check.conclusion {
                    CheckConclusion::Pass => "PASS",
                    CheckConclusion::Fail => "FAIL",
                    CheckConclusion::Pending => "PENDING",
                    CheckConclusion::Inconclusive => "INCONCLUSIVE",
                };
                let _ = writeln!(out, "- check {state}: {}", check.name);
            }
        }
        let mergeable = if ctx.external.mergeable { "yes" } else { "no" };
        let _ = writeln!(out, "- mergeable: {mergeable}");
        if ctx.external.head_moved {
            let _ = writeln!(
                out,
                "- target head moved since admission: rebase onto the new head"
            );
        }
        let _ = writeln!(out, "- target: {} at {}", ctx.target_ref, ctx.target_sha);
        let _ = writeln!(out);
        let _ = writeln!(out, "# Operating instructions (attempt {})", ctx.attempt_n);
        let _ = writeln!(out);
        let _ = writeln!(out, "- repo: {}", ctx.repo);
        let _ = writeln!(out, "- work branch: {}", ctx.branch);
        let _ = writeln!(
            out,
            "- push commits to the work branch; never rewrite the target ref"
        );
        let _ = writeln!(
            out,
            "- when the obligations are met: `anvilctl done --notes <summary>`"
        );
        let _ = writeln!(
            out,
            "- when blocked or needing a human: `anvilctl attention <message>`"
        );
        let _ = writeln!(
            out,
            "- sandbox: nix flakes are available via the host store"
        );
        if let Some(verify_cmd) = &self.verify_cmd {
            let _ = writeln!(out, "- before claiming done, run: `{verify_cmd}`");
        } else {
            let _ = writeln!(
                out,
                "- the convergence gate is the PR check suite on your branch"
            );
        }
        out
    }

    pub fn evaluate(&self, external: &ExternalState) -> Verdict {
        if !external.work_present {
            return Verdict::Continue {
                gaps: vec![
                    "nothing has been committed to the work branch yet: implement the commission, commit, and push"
                        .to_owned(),
                ],
            };
        }
        let checks: Vec<&anvil_api::CheckStatus> = external
            .checks
            .iter()
            .filter(|check| !self.ignore_checks.iter().any(|name| name == &check.name))
            .collect();
        let gaps: Vec<String> = checks
            .iter()
            .filter(|check| check.conclusion == CheckConclusion::Fail)
            .map(|check| format!("check failed: {}", check.name))
            .collect();
        if !gaps.is_empty() {
            return Verdict::Continue { gaps };
        }
        if checks
            .iter()
            .any(|check| check.conclusion == CheckConclusion::Pending)
        {
            return Verdict::Pending;
        }
        if external.head_moved {
            return Verdict::Continue {
                gaps: vec![
                    "target head moved since admission: rebase the work branch onto the new head and resolve"
                        .to_owned(),
                ],
            };
        }
        if !external.mergeable {
            return Verdict::Continue {
                gaps: vec![
                    "branch is not mergeable: resolve conflicts with the target branch".to_owned(),
                ],
            };
        }
        Verdict::Converge
    }
}

fn write_layer(out: &mut String, body: &str, empty: &str) {
    let body = body.trim();
    if body.is_empty() {
        out.push_str(empty);
        out.push_str("\n\n");
    } else {
        out.push_str(body);
        out.push_str("\n\n");
    }
}

pub fn prompt_hash(prompt: &str) -> String {
    let digest = Sha256::digest(prompt.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}
