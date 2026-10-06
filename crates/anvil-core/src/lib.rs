//! Shared domain types and validation for Anvil.

use serde::{Deserialize, Serialize};
use std::{fmt, net::IpAddr};
use thiserror::Error;
use url::Url;

/// Immutable completion contract attached to an accepted durable Task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum CompletionPolicy {
    Evidence { required_kinds: Vec<EvidenceKind> },
    AllChildrenCompleted,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    LegacySchedulerExit,
    DeliveryComplete,
    DeterministicVerification,
    ManualCompletion,
}

/// Provenance is carried at the type boundary so agent claims cannot be promoted
/// to completion evidence by callers of the completion evaluator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationProvenance {
    Runtime,
    Platform,
    External,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservationRef {
    pub id: String,
    pub version: u64,
    pub kind: EvidenceKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrustedEvidence(ObservationRef);

impl TrustedEvidence {
    pub fn from_observation(
        reference: ObservationRef,
        provenance: ObservationProvenance,
    ) -> Result<Self, ValidationError> {
        if provenance == ObservationProvenance::Agent {
            return Err(ValidationError::Invalid {
                field: "completion_evidence",
                reason: "agent-provenance observations are not trusted completion evidence".into(),
            });
        }
        Ok(Self(reference))
    }

    pub fn observation(&self) -> &ObservationRef {
        &self.0
    }
}

pub fn completion_policy_satisfied(
    policy: &CompletionPolicy,
    evidence: &[TrustedEvidence],
    children: &[TaskTerminal],
) -> bool {
    match policy {
        CompletionPolicy::Evidence { required_kinds } => {
            !required_kinds.is_empty()
                && required_kinds.iter().all(|required| {
                    evidence
                        .iter()
                        .any(|trusted| trusted.observation().kind == *required)
                })
        }
        CompletionPolicy::AllChildrenCompleted => {
            !children.is_empty()
                && children
                    .iter()
                    .all(|child| matches!(child, TaskTerminal::Completed { .. }))
        }
        CompletionPolicy::Manual => evidence
            .iter()
            .any(|trusted| trusted.observation().kind == EvidenceKind::ManualCompletion),
    }
}

pub fn validate_completion_policy(policy: &CompletionPolicy) -> Result<(), ValidationError> {
    if let CompletionPolicy::Evidence { required_kinds } = policy {
        if required_kinds.is_empty() {
            return Err(ValidationError::Invalid {
                field: "completion_policy.required_kinds",
                reason: "must contain at least one trusted evidence kind".into(),
            });
        }
        let mut unique = std::collections::BTreeSet::new();
        if required_kinds.iter().any(|kind| !unique.insert(*kind)) {
            return Err(ValidationError::Invalid {
                field: "completion_policy.required_kinds",
                reason: "must not contain duplicate evidence kinds".into(),
            });
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TaskTerminal {
    Completed {
        evidence: Vec<ObservationRef>,
    },
    Canceled {
        actor: String,
        reason: String,
    },
    Obviated {
        reason: String,
    },
    Superseded {
        by_task_id: String,
    },
    FailedExhausted {
        attempt_budget: u32,
        last_failure: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControllerMode {
    Legacy,
    Shadow,
    Reconciler,
}

/// Whether the returned action list is authoritative. Missing metadata (`None`)
/// and `Unavailable` must never be treated as a known-empty action ledger.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptRole {
    #[default]
    Implementation,
    Verification,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptLifecycle {
    #[default]
    Queued,
    Provisioning,
    Running,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptExitReason {
    CompletedTurn,
    RuntimeLost,
    Orphaned,
    Canceled,
    Abandoned,
    Failed,
    Replaced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureDomain {
    Work,
    Agent,
    Sandbox,
    Platform,
    Dependency,
    Orchestrator,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    pub domain: FailureDomain,
    pub code: String,
    pub summary: String,
    pub artifact_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub id: String,
    pub version: u64,
    pub task_id: String,
    pub ordinal: u32,
    pub role: AttemptRole,
    pub session_id: Option<String>,
    pub start_revision: Option<String>,
    pub lifecycle: AttemptLifecycle,
    pub exit_reason: Option<AttemptExitReason>,
    pub failure: Option<Failure>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskBudget {
    pub max_attempts: u32,
    pub max_continuations_per_reason: u32,
    pub max_verifier_cycles: u32,
    pub max_ci_retries: u32,
    pub max_execution_seconds: u64,
    #[serde(default)]
    pub max_model_cost: Option<String>,
}

impl Default for TaskBudget {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            max_continuations_per_reason: 2,
            max_verifier_cycles: 0,
            max_ci_retries: 2,
            max_execution_seconds: 14_400,
            max_model_cost: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum TaskLifecycle {
    Open,
    Terminal { terminal: TaskTerminal },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPhase {
    Terminal,
    Blocked,
    Running,
    Runnable,
    Waiting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDependencySummary {
    pub all_completed: bool,
    pub predecessors: Vec<TaskDependencyRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDependencyRef {
    pub task_id: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskAttemptSummary {
    #[serde(default)]
    pub attempt_id: String,
    #[serde(default)]
    pub ordinal: u32,
    #[serde(default)]
    pub role: AttemptRole,
    #[serde(default)]
    pub lifecycle: AttemptLifecycle,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub start_revision: Option<String>,
    #[serde(default)]
    pub turn: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskObservationSummary {
    #[serde(default)]
    pub id: Option<String>,
    pub key: String,
    pub value: serde_json::Value,
    pub provenance: ObservationProvenance,
    #[serde(default)]
    pub observed_at: Option<String>,
    #[serde(default)]
    pub recorded_at: Option<String>,
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub collection_seq: u64,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskBlockerSummary {
    pub id: String,
    pub attempt_id: String,
    pub question: String,
    pub context: String,
    pub version: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskChildSummary {
    pub total: u32,
    pub completed: u32,
    pub terminal_noncompleted: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionHistorySummary {
    #[serde(default)]
    pub availability: Option<ActionHistoryAvailability>,
    pub relevant: Vec<ActionHistoryEntry>,
    pub continuation_fingerprints_sent: Vec<String>,
    #[serde(default)]
    pub last_consumed_evidence: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionHistoryAvailability {
    #[default]
    Unavailable,
    Authoritative,
}

/// Shared read boundary for action history owned by the reconciler/outbox lane.
/// Implementations should return `Unavailable` when their authoritative ledger
/// cannot be read; they must not convert read failure into an authoritative empty set.
pub trait TaskActionHistoryReadPort {
    fn read_action_history(&self, task_id: &str, limit: usize) -> ActionHistorySummary;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionHistoryEntry {
    pub action_kind: String,
    pub attempt_id: Option<String>,
    pub cause_fingerprint: String,
    pub idempotency_key: String,
    pub state: ActionState,
    pub turn_id: Option<String>,
    #[serde(default)]
    pub generation: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionState {
    Pending,
    Executing,
    Succeeded,
    Failed,
    UnknownOutcome,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionClass {
    Idempotent,
    Observable,
    Irreversible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetUsage {
    #[serde(default)]
    pub limits: TaskBudget,
    pub attempts: u32,
    pub continuations_by_reason: std::collections::BTreeMap<String, u32>,
    pub ci_retries: u32,
    pub verifier_cycles: u32,
    pub execution_ms: u64,
    pub grants: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrySchedule {
    pub due_at_ms: Option<i64>,
    pub cause: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryKind {
    PullRequest,
    LocalBranch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TaskExecutionTarget {
    GitRepository {
        #[serde(default)]
        project: Option<String>,
        repository: String,
        base_ref: String,
        delivery: DeliveryKind,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerificationSpec {
    #[serde(default)]
    pub holdout_scenarios: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedTaskSpec {
    pub outcome: String,
    pub acceptance_criteria: Vec<String>,
    pub completion_policy: CompletionPolicy,
    pub verification_spec: VerificationSpec,
    pub budget: TaskBudget,
    pub execution_target: Option<TaskExecutionTarget>,
}

/// Parse and validate immutable Task intent before any storage transaction is
/// opened. This is shared by service/API code and the Task repository so graph
/// and singleton acceptance cannot silently diverge.
pub fn validate_task_spec(
    specification: &serde_json::Value,
) -> Result<ValidatedTaskSpec, ValidationError> {
    let outcome = specification
        .get("outcome")
        .and_then(serde_json::Value::as_str)
        .filter(|outcome| !outcome.trim().is_empty())
        .ok_or(ValidationError::Empty { field: "outcome" })?
        .to_owned();
    if outcome.len() > 32_768 {
        return Err(ValidationError::Invalid {
            field: "outcome",
            reason: "must be at most 32768 bytes".into(),
        });
    }
    let acceptance_criteria = match specification.get("acceptance_criteria") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(value) => value
            .as_array()
            .ok_or_else(|| ValidationError::Invalid {
                field: "acceptance_criteria",
                reason: "must be an array of non-empty strings".into(),
            })?
            .iter()
            .map(|criterion| {
                criterion
                    .as_str()
                    .filter(|criterion| !criterion.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| ValidationError::Invalid {
                        field: "acceptance_criteria",
                        reason: "must contain only non-empty strings".into(),
                    })
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    if acceptance_criteria.len() > 256
        || acceptance_criteria
            .iter()
            .any(|criterion| criterion.len() > 4096)
    {
        return Err(ValidationError::Invalid {
            field: "acceptance_criteria",
            reason: "must contain at most 256 criteria of at most 4096 bytes each".into(),
        });
    }
    let execution_target = match specification
        .get("execution_target")
        .filter(|value| !value.is_null())
    {
        None => None,
        Some(value) => {
            let mut normalized = value.clone();
            if let Some(delivery) = normalized
                .get("delivery")
                .and_then(|item| item.get("kind"))
                .and_then(serde_json::Value::as_str)
            {
                normalized["delivery"] = serde_json::json!(delivery);
            }
            if normalized["kind"] != "git_repository" {
                return Err(ValidationError::Invalid {
                    field: "execution_target.kind",
                    reason: "only git_repository is supported".into(),
                });
            }
            if let Some(project) = normalized
                .get("project")
                .and_then(serde_json::Value::as_str)
            {
                Project::new(project)?;
            }
            Repository::new(normalized["repository"].as_str().unwrap_or_default())?;
            GitRef::new(normalized["base_ref"].as_str().unwrap_or_default())?;
            Some(
                serde_json::from_value(normalized).map_err(|error| ValidationError::Invalid {
                    field: "execution_target",
                    reason: error.to_string(),
                })?,
            )
        }
    };
    let completion_policy = match specification.get("completion_policy") {
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|error| ValidationError::Invalid {
                field: "completion_policy",
                reason: error.to_string(),
            })?
        }
        None => match &execution_target {
            None => CompletionPolicy::AllChildrenCompleted,
            Some(_) => CompletionPolicy::Evidence {
                required_kinds: vec![EvidenceKind::DeliveryComplete],
            },
        },
    };
    validate_completion_policy(&completion_policy)?;
    let verification_spec = match specification.get("verification_spec") {
        None | Some(serde_json::Value::Null) => VerificationSpec {
            holdout_scenarios: Vec::new(),
        },
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|error| ValidationError::Invalid {
                field: "verification_spec",
                reason: error.to_string(),
            })?
        }
    };
    if verification_spec.holdout_scenarios.len() > 256
        || verification_spec
            .holdout_scenarios
            .iter()
            .any(|scenario| scenario.to_string().len() > 65_536)
    {
        return Err(ValidationError::Invalid {
            field: "verification_spec.holdout_scenarios",
            reason: "must contain at most 256 scenarios of at most 65536 bytes each".into(),
        });
    }
    let budget = match specification.get("budget") {
        None | Some(serde_json::Value::Null) => TaskBudget::default(),
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|error| ValidationError::Invalid {
                field: "budget",
                reason: error.to_string(),
            })?
        }
    };
    if budget.max_attempts == 0
        || budget.max_attempts > 1_000
        || budget.max_continuations_per_reason > 1_000
        || budget.max_verifier_cycles > 100
        || budget.max_ci_retries > 1_000
        || budget.max_execution_seconds == 0
        || budget.max_execution_seconds > 31_536_000
        || budget.max_model_cost.as_deref().is_some_and(|cost| {
            cost.len() > 64
                || cost
                    .parse::<f64>()
                    .map_or(true, |value| !value.is_finite() || value < 0.0)
        })
    {
        return Err(ValidationError::Invalid {
            field: "budget",
            reason: "allocation is outside supported positive bounds".into(),
        });
    }
    Ok(ValidatedTaskSpec {
        outcome,
        acceptance_criteria,
        completion_policy,
        verification_spec,
        budget,
        execution_target,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckEvaluationKind {
    Head,
    TestMerge,
    MergeGroup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Pending,
    Passing,
    Failing,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskPullRequestBinding {
    pub provider: String,
    pub repository: String,
    pub number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRequiredCheck {
    pub context: String,
    pub source: String,
    pub state: CheckState,
    pub evaluation_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDeliverySummary {
    #[serde(default)]
    pub work_branch: Option<String>,
    #[serde(default)]
    pub base_revision: Option<String>,
    #[serde(default)]
    pub pull_request: Option<TaskPullRequestBinding>,
    #[serde(default)]
    pub pr_head_sha: Option<String>,
    #[serde(default)]
    pub evaluation_sha: Option<String>,
    #[serde(default)]
    pub evaluation_kind: Option<CheckEvaluationKind>,
    #[serde(default)]
    pub pr_state: Option<String>,
    #[serde(default)]
    pub required_checks: Vec<TaskRequiredCheck>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub schema_version: u32,
    pub task_id: String,
    pub task_version: u64,
    pub logical_time_ms: i64,
    pub lifecycle: TaskLifecycle,
    pub completion_policy: CompletionPolicy,
    pub operator_hold: bool,
    pub controller_mode: ControllerMode,
    pub reconcile_generation: u64,
    pub execution_target: Option<TaskExecutionTarget>,
    pub delivery: Option<TaskDeliverySummary>,
    pub dependencies: TaskDependencySummary,
    pub children: TaskChildSummary,
    pub attempts: Vec<TaskAttemptSummary>,
    pub blocker: Option<TaskBlockerSummary>,
    pub observations: Vec<TaskObservationSummary>,
    pub action_history: ActionHistorySummary,
    pub budget_usage: BudgetUsage,
    pub retry_schedule: RetrySchedule,
    pub phase: TaskPhase,
    pub merge_wait_due_at_ms: Option<i64>,
}

impl TaskSnapshot {
    /// Project the ANVIL-56-owned action read port into this canonical snapshot.
    /// The unavailable state is preserved when that port is not yet wired.
    pub fn with_action_history(
        mut self,
        reader: &impl TaskActionHistoryReadPort,
        limit: usize,
    ) -> Self {
        let limit = limit.clamp(1, 128);
        self.action_history = reader.read_action_history(&self.task_id, limit);
        self.action_history.relevant.truncate(limit);
        self.action_history
            .continuation_fingerprints_sent
            .truncate(limit);
        self
    }
}

/// Coarse snapshot phase. This function deliberately performs no I/O.
pub fn derive_task_phase(
    lifecycle: &str,
    has_blocker: bool,
    has_active_attempt: bool,
    has_execution_target: bool,
) -> &'static str {
    if matches!(
        lifecycle,
        "completed" | "canceled" | "obviated" | "superseded" | "failed_exhausted"
    ) {
        "terminal"
    } else if has_blocker {
        "blocked"
    } else if has_active_attempt {
        "running"
    } else if lifecycle == "queued" || (lifecycle == "open" && has_execution_target) {
        "runnable"
    } else {
        "waiting"
    }
}

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

// ── HTTP API contracts ───────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub sandbox: String,
    pub service: String,
    pub namespace: String,
    pub opencode_port: u16,
    pub phase: Option<String>,
    pub project: String,
    pub repository: String,
    #[serde(rename = "ref")]
    pub base_ref: String,
    /// Exact commit checked out for this worker's initial workspace. Legacy
    /// sessions have no value because their original checkout cannot be proven.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    pub work_branch: String,
    #[serde(default)]
    pub current_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<PullRequest>,
    pub model: Option<String>,
    pub opencode_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_at: Option<String>,
    #[serde(default)]
    pub environment_state: String,
    #[serde(default)]
    pub execution_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_run: Option<Run>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<Run>,
    #[serde(default)]
    pub session_binding_state: String,
    #[serde(default)]
    pub session_binding_continuity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_binding_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_binding_checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_opencode_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_binding_recovery_event: Option<String>,
}

impl Session {
    /// Apply authoritative runtime Git metadata, dropping stale PR state when
    /// the checked-out branch changes or HEAD becomes detached.
    pub fn update_git_metadata(
        &mut self,
        branch: Option<String>,
        pull_request: Option<PullRequest>,
    ) {
        if branch.is_none() {
            self.pull_request = None;
        } else {
            self.pull_request = pull_request;
        }
        self.current_branch = branch;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, alias = "isDraft", skip_serializing_if = "Option::is_none")]
    pub draft: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(pub String);

impl fmt::Display for RunId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OpenCodeMessageId(pub String);

impl fmt::Display for OpenCodeMessageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Submitted,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub id: RunId,
    pub state: RunState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<OpenCodeMessageId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_message_id: Option<OpenCodeMessageId>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRequest {
    pub id: String,
    pub number: u32,
    pub origin: String,
    pub prompt: String,
    pub state: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleEvent {
    #[serde(default)]
    pub id: String,
    pub kind: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionActivity {
    pub session: Session,
    pub current_operation: Option<String>,
    pub last_activity_at: Option<String>,
    pub requests: Vec<SessionRequest>,
    pub lifecycle: Vec<LifecycleEvent>,
    #[serde(default)]
    pub events: Vec<ActivityEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_window: Option<ActivityEventWindow>,
    pub preview_url: Option<String>,
    pub opencode_url: Option<String>,
    pub attach_command: String,
    pub environment_state: String,
    pub environment_error: Option<String>,
    pub execution_state: String,
    #[serde(default)]
    pub telemetry: SessionTelemetry,
    pub current_run: Option<Run>,
    pub last_run: Option<Run>,
    pub session_binding_state: String,
    pub session_binding_continuity: String,
    pub session_binding_error: Option<String>,
    pub session_binding_checked_at: Option<String>,
    pub previous_opencode_session_id: Option<String>,
    pub session_binding_recovery_event: Option<String>,
}

/// Bounded, user-visible projection of an OpenCode conversation event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEvent {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// Describes the bounded, newest-message window used to reconstruct activity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEventWindow {
    pub message_limit: u32,
    pub returned_messages: u32,
    #[serde(default)]
    pub loaded_messages: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// True when the bounded 500-event projection omitted entries.
    pub truncated: bool,
}

/// Anvil-owned, versioned projection of OpenCode execution telemetry.
/// Upstream event payloads are adapted before entering this snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionTelemetry {
    pub schema_version: u32,
    pub execution: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_error: Option<String>,
    #[serde(default)]
    pub observer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observer_changed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_operation: Option<OperationTelemetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_operation: Option<OperationTelemetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default)]
    pub requests: Vec<SessionRequest>,
    /// Agent-authored planning data only; never interpreted as completion percent.
    #[serde(default)]
    pub todos: Vec<serde_json::Value>,
    #[serde(default)]
    pub waits: Vec<serde_json::Value>,
}

impl Default for SessionTelemetry {
    fn default() -> Self {
        Self {
            schema_version: 1,
            execution: "unknown".into(),
            execution_error: None,
            observer: "recovering".into(),
            observer_changed_at: None,
            current_operation: None,
            last_operation: None,
            last_activity_at: None,
            requests: Vec::new(),
            todos: Vec::new(),
            waits: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationTelemetry {
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderAuthMethod {
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
    pub authenticated: bool,
    pub auth_methods: Vec<ProviderAuthMethod>,
    #[serde(default)]
    pub api_key_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderListResponse {
    pub providers: Vec<ProviderSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginFlow {
    pub login_id: String,
    pub provider: String,
    pub state: String,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
    pub method: String,
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub provider: String,
    pub authenticated: bool,
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

    #[test]
    fn aggregate_completion_requires_declared_children_and_all_completed() {
        let policy = CompletionPolicy::AllChildrenCompleted;
        assert!(!completion_policy_satisfied(&policy, &[], &[]));
        assert!(!completion_policy_satisfied(
            &policy,
            &[],
            &[TaskTerminal::Canceled {
                actor: "operator".into(),
                reason: "not complete".into(),
            }]
        ));
        assert!(completion_policy_satisfied(
            &policy,
            &[],
            &[TaskTerminal::Completed { evidence: vec![] }]
        ));
        let vacuous_evidence = CompletionPolicy::Evidence {
            required_kinds: Vec::new(),
        };
        let fabricated_trust = TrustedEvidence::from_observation(
            ObservationRef {
                id: "not-authorized".into(),
                version: 1,
                kind: EvidenceKind::DeliveryComplete,
            },
            ObservationProvenance::External,
        )
        .unwrap();
        assert!(!completion_policy_satisfied(
            &vacuous_evidence,
            &[fabricated_trust],
            &[]
        ));
        assert!(validate_completion_policy(&vacuous_evidence).is_err());
    }

    #[test]
    fn task_snapshot_v0_fixture_deserializes_and_round_trips() {
        let fixtures = [
            include_str!("../tests/fixtures/task-snapshot-v1/fresh-open-executable.json"),
            include_str!(
                "../tests/fixtures/task-snapshot-v1/failed-checks-prior-continuation.json"
            ),
            include_str!("../tests/fixtures/task-snapshot-v1/merged-pr-stale-red-checks.json"),
            include_str!("../tests/fixtures/task-snapshot-v1/operator-hold.json"),
            include_str!("../tests/fixtures/task-snapshot-v1/unresolved-blocker.json"),
            include_str!("../tests/fixtures/task-snapshot-v1/budget-exhaustion.json"),
            include_str!(
                "../tests/fixtures/task-snapshot-v1/dependency-terminal-noncompleted.json"
            ),
            include_str!("../tests/fixtures/task-snapshot-v1/missing-pr-branch.json"),
            include_str!("../tests/fixtures/task-snapshot-v1/shadow-inflight-attempt.json"),
            include_str!("../tests/fixtures/task-snapshot-v1/empty-aggregate-root.json"),
            include_str!("../tests/fixtures/task-snapshot-v1/merge-group-sha-mismatch.json"),
        ];
        for fixture in fixtures {
            let snapshot: TaskSnapshot = serde_json::from_str(fixture).unwrap();
            assert_eq!(snapshot.schema_version, 1);
            let encoded = serde_json::to_value(&snapshot).unwrap();
            for required in [
                "logical_time_ms",
                "lifecycle",
                "dependencies",
                "children",
                "attempts",
                "observations",
                "action_history",
                "budget_usage",
                "retry_schedule",
                "delivery",
                "merge_wait_due_at_ms",
            ] {
                assert!(encoded.get(required).is_some(), "missing {required}");
            }
            let decoded: TaskSnapshot = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded, snapshot);
        }
    }

    #[test]
    fn action_history_read_port_projects_exact_history_and_fails_closed_when_unavailable() {
        struct FakeActionHistory {
            summary: ActionHistorySummary,
        }
        impl TaskActionHistoryReadPort for FakeActionHistory {
            fn read_action_history(&self, task_id: &str, _limit: usize) -> ActionHistorySummary {
                assert_eq!(task_id, "task_demo");
                self.summary.clone()
            }
        }
        struct UnavailableActionHistory;
        impl TaskActionHistoryReadPort for UnavailableActionHistory {
            fn read_action_history(&self, _task_id: &str, _limit: usize) -> ActionHistorySummary {
                ActionHistorySummary {
                    availability: Some(ActionHistoryAvailability::Unavailable),
                    relevant: Vec::new(),
                    continuation_fingerprints_sent: Vec::new(),
                    last_consumed_evidence: None,
                }
            }
        }

        let fixture = include_str!("../tests/fixtures/task-snapshot-v1/fresh-open-executable.json");
        let snapshot: TaskSnapshot = serde_json::from_str(fixture).unwrap();
        assert_eq!(
            snapshot.action_history.availability, None,
            "missing provider metadata must not masquerade as an authoritative empty ledger"
        );
        assert_eq!(snapshot.controller_mode, ControllerMode::Reconciler);
        let unavailable = snapshot
            .clone()
            .with_action_history(&UnavailableActionHistory, 10);
        assert_eq!(
            unavailable.action_history.availability,
            Some(ActionHistoryAvailability::Unavailable)
        );
        assert!(unavailable.action_history.relevant.is_empty());

        let first_entry = ActionHistoryEntry {
            action_kind: "send_turn".into(),
            attempt_id: Some("attempt_1".into()),
            cause_fingerprint: "checks-failed:abc".into(),
            idempotency_key: "send-turn-key".into(),
            state: ActionState::UnknownOutcome,
            turn_id: Some("turn_1".into()),
            generation: Some(7),
        };
        let provider = FakeActionHistory {
            summary: ActionHistorySummary {
                availability: Some(ActionHistoryAvailability::Authoritative),
                relevant: vec![
                    first_entry,
                    ActionHistoryEntry {
                        action_kind: "send_turn".into(),
                        attempt_id: Some("attempt_1".into()),
                        cause_fingerprint: "checks-failed:def".into(),
                        idempotency_key: "send-turn-key-2".into(),
                        state: ActionState::Succeeded,
                        turn_id: Some("turn_2".into()),
                        generation: Some(8),
                    },
                ],
                continuation_fingerprints_sent: vec![
                    "checks-failed:abc".into(),
                    "checks-failed:def".into(),
                ],
                last_consumed_evidence: Some("observation_9".into()),
            },
        };
        let projected = snapshot.with_action_history(&provider, 1);
        assert_eq!(
            projected.action_history.availability,
            Some(ActionHistoryAvailability::Authoritative)
        );
        assert_eq!(
            projected.action_history.relevant[0].cause_fingerprint,
            "checks-failed:abc"
        );
        assert_eq!(
            projected.action_history.relevant[0].idempotency_key,
            "send-turn-key"
        );
        assert_eq!(
            projected.action_history.relevant[0].turn_id.as_deref(),
            Some("turn_1")
        );
        assert_eq!(projected.action_history.relevant[0].generation, Some(7));
        assert_eq!(projected.action_history.relevant.len(), 1);
        assert_eq!(
            projected
                .action_history
                .continuation_fingerprints_sent
                .len(),
            1
        );
        assert_eq!(
            projected.action_history.relevant[0].state,
            ActionState::UnknownOutcome
        );
        assert_eq!(
            projected.action_history.last_consumed_evidence.as_deref(),
            Some("observation_9")
        );
    }

    #[test]
    fn agent_observations_cannot_become_trusted_completion_evidence() {
        let reference = ObservationRef {
            id: "observation-1".into(),
            version: 1,
            kind: EvidenceKind::DeliveryComplete,
        };
        assert!(
            TrustedEvidence::from_observation(reference.clone(), ObservationProvenance::Agent)
                .is_err()
        );
        assert_eq!(
            TrustedEvidence::from_observation(reference.clone(), ObservationProvenance::External)
                .unwrap()
                .observation(),
            &reference
        );
    }

    #[test]
    fn task_phase_derivation_is_coarse_and_pure() {
        assert_eq!(
            derive_task_phase("completed", false, false, false),
            "terminal"
        );
        assert_eq!(derive_task_phase("open", true, true, true), "blocked");
        assert_eq!(derive_task_phase("open", false, true, true), "running");
        assert_eq!(derive_task_phase("queued", false, false, true), "runnable");
        assert_eq!(derive_task_phase("open", false, false, false), "waiting");
        assert_eq!(
            derive_task_phase("retry_wait", false, false, true),
            "waiting"
        );
    }

    #[test]
    fn git_metadata_clears_pr_on_branch_change_and_detached_head() {
        let mut session: Session = serde_json::from_value(serde_json::json!({
            "id":"session-1", "sandbox":"sandbox", "service":"service", "namespace":"anvil",
            "opencode_port":4096, "phase":null, "project":"demo", "repository":"https://github.com/acme/repo",
            "ref":"main", "work_branch":"anvil/session-1", "model":null, "opencode_session_id":null
        })).unwrap();
        let pr = PullRequest {
            number: 1,
            title: "PR".into(),
            url: "https://github.com/acme/repo/pull/1".into(),
            state: Some("open".into()),
            draft: Some(false),
        };
        session.update_git_metadata(Some("agent/one".into()), Some(pr.clone()));
        assert_eq!(session.pull_request, Some(pr));
        session.update_git_metadata(Some("agent/two".into()), None);
        assert_eq!(session.pull_request, None);
        session.update_git_metadata(None, None);
        assert_eq!(session.current_branch, None);
        assert_eq!(session.pull_request, None);
    }

    #[test]
    fn legacy_session_without_base_revision_remains_explicitly_unknown() {
        let legacy = serde_json::json!({
            "id": "demo-12345678",
            "sandbox": "anvil-demo-12345678",
            "service": "",
            "namespace": "local",
            "opencode_port": 4096,
            "phase": null,
            "project": "demo",
            "repository": "https://example.com/demo.git",
            "ref": "main",
            "work_branch": "anvil/demo-12345678",
            "model": null,
            "opencode_session_id": null
        });
        let session: Session = serde_json::from_value(legacy).unwrap();
        assert_eq!(session.base_revision, None);
    }

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
