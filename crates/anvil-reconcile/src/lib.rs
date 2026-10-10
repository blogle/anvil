//! Deterministic, I/O-free task reconciliation primitives.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub mod frozen_v0;

pub const RECONCILER_VERSION: &str = "anvil-reconcile-v1";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct LogicalTime(pub i64);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControllerMode {
    Legacy,
    Shadow,
    Reconciler,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Open,
    Terminal,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompletionPolicy {
    Evidence { required_kinds: Vec<String> },
    AllChildrenCompleted,
    Manual,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservationProvenance {
    Runtime,
    Platform,
    External,
    Agent,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompletionEvidence {
    pub kind: String,
    pub provenance: ObservationProvenance,
    pub fresh: bool,
    pub trusted: bool,
    #[serde(default)]
    pub subject_sha: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttemptLifecycle {
    Queued,
    Provisioning,
    Running,
    Ended,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeHealth {
    Healthy,
    Failed,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Pending,
    Passing,
    Failing,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationKind {
    Head,
    TestMerge,
    MergeGroup,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionClass {
    Idempotent,
    Observable,
    Irreversible,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    CreateAttempt,
    RecoverRuntime,
    ChecksFailed,
    MergeConflict,
    ObserveDelivery,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStrategy {
    RetryIdempotently,
    ObserveBeforeRetry,
    NeverReplay,
}
impl ActionKind {
    pub fn recovery_strategy(&self) -> RecoveryStrategy {
        match self {
            Self::CreateAttempt | Self::ObserveDelivery => RecoveryStrategy::RetryIdempotently,
            Self::RecoverRuntime | Self::ChecksFailed | Self::MergeConflict => {
                RecoveryStrategy::ObserveBeforeRetry
            }
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionState {
    Pending,
    Executing,
    Succeeded,
    Failed,
    UnknownOutcome,
    Superseded,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequiredCheck {
    pub context: String,
    pub source: String,
    pub state: CheckState,
    pub evaluation_sha: String,
    #[serde(default)]
    pub failure_fingerprint: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Delivery {
    pub work_branch: Option<String>,
    pub base_revision: Option<String>,
    pub pr_head_sha: Option<String>,
    pub evaluation_sha: Option<String>,
    pub evaluation_kind: Option<EvaluationKind>,
    pub pr_state: Option<String>,
    #[serde(default)]
    pub check_policy_known: bool,
    #[serde(default)]
    pub unexpected_force_push: bool,
    #[serde(default)]
    pub changes_requested: bool,
    #[serde(default)]
    pub merge_conflict: bool,
    #[serde(default)]
    pub pr_merged: bool,
    #[serde(default)]
    pub required_checks: Vec<RequiredCheck>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Attempt {
    pub attempt_id: String,
    pub ordinal: u32,
    pub role: String,
    pub lifecycle: AttemptLifecycle,
    pub turn_state: Option<String>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_healthy: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PriorAction {
    pub action_kind: ActionKind,
    pub attempt_id: Option<String>,
    pub cause_fingerprint: String,
    pub idempotency_key: String,
    pub state: ActionState,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BudgetUsage {
    pub attempts: u32,
    #[serde(default)]
    pub continuations_by_reason: std::collections::BTreeMap<String, u32>,
    pub ci_retries: u32,
    pub verifier_cycles: u32,
    pub execution_ms: u64,
    #[serde(default)]
    pub runtime_recoveries: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskSnapshot {
    pub schema_version: u32,
    pub task_id: String,
    pub task_version: u64,
    pub reconcile_generation: u64,
    pub controller_mode: ControllerMode,
    pub operator_hold: bool,
    pub lifecycle: Lifecycle,
    #[serde(default)]
    pub completion_policy: Option<CompletionPolicy>,
    #[serde(default)]
    pub completion_evidence: Vec<CompletionEvidence>,
    pub phase: Option<String>,
    #[serde(default)]
    pub dependencies_all_completed: bool,
    #[serde(default)]
    pub child_count: u32,
    #[serde(default)]
    pub children_completed: u32,
    #[serde(default)]
    pub children_terminal_noncompleted: u32,
    pub delivery: Option<Delivery>,
    #[serde(default)]
    pub attempts: Vec<Attempt>,
    #[serde(default)]
    pub unresolved_blocker: bool,
    #[serde(default)]
    pub runtime_health: Option<RuntimeHealth>,
    #[serde(default)]
    pub runtime_failure_fingerprint: Option<String>,
    #[serde(default)]
    pub max_runtime_recoveries: Option<u32>,
    #[serde(default)]
    pub action_history: Vec<PriorAction>,
    #[serde(default)]
    pub budget_usage: BudgetUsage,
    pub max_attempts: Option<u32>,
    #[serde(default)]
    pub max_continuations_by_reason: std::collections::BTreeMap<String, u32>,
    #[serde(default)]
    pub max_ci_retries: Option<u32>,
    #[serde(default)]
    pub max_execution_ms: Option<u64>,
    pub retry_due_at_ms: Option<i64>,
    pub merge_wait_due_at_ms: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposedAction {
    pub kind: ActionKind,
    pub task_id: String,
    pub attempt_id: Option<String>,
    pub cause_fingerprint: String,
    pub idempotency_key: String,
    pub class: ActionClass,
    pub recovery_strategy: RecoveryStrategy,
    pub payload: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Decision {
    pub rule_id: String,
    pub desired_actions: Vec<ProposedAction>,
    pub attention: Vec<String>,
}

fn digest(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn make_action(
    task: &str,
    attempt: Option<&str>,
    kind: ActionKind,
    cause: String,
    payload: Value,
) -> ProposedAction {
    let key_material = if kind == ActionKind::CreateAttempt {
        format!(
            "{task}:implementation:{}",
            payload["ordinal"].as_u64().unwrap_or_default()
        )
    } else {
        format!(
            "{task}:{}:{kind:?}:{cause}",
            attempt.unwrap_or("-").to_owned()
        )
    };
    let class = match &kind {
        ActionKind::CreateAttempt | ActionKind::ObserveDelivery => ActionClass::Idempotent,
        ActionKind::RecoverRuntime | ActionKind::ChecksFailed | ActionKind::MergeConflict => {
            ActionClass::Observable
        }
    };
    let recovery_strategy = kind.recovery_strategy();
    ProposedAction {
        kind,
        task_id: task.to_owned(),
        attempt_id: attempt.map(str::to_owned),
        cause_fingerprint: cause,
        idempotency_key: digest(&key_material),
        class,
        recovery_strategy,
        payload,
    }
}
fn has_action(s: &TaskSnapshot, kind: ActionKind, attempt: Option<&str>, cause: &str) -> bool {
    s.action_history.iter().any(|a| {
        a.action_kind == kind
            && a.attempt_id.as_deref() == attempt
            && a.cause_fingerprint == cause
            && matches!(
                a.state,
                ActionState::Succeeded | ActionState::UnknownOutcome | ActionState::Executing
            )
    })
}

/// Reduce a frozen snapshot and explicit logical time into a stable decision.
pub fn reconcile(s: &TaskSnapshot, now: LogicalTime) -> Decision {
    let mut d = Decision {
        rule_id: String::new(),
        desired_actions: Vec::new(),
        attention: Vec::new(),
    };
    if s.lifecycle == Lifecycle::Terminal {
        d.rule_id = "already_terminal".into();
        return d;
    }
    if completion_satisfied(s) {
        d.rule_id = "completion_satisfied".into();
        return d;
    }
    if s.delivery
        .as_ref()
        .is_some_and(|delivery| delivery.pr_merged)
    {
        d.rule_id = "delivery_merged_observed".into();
        return d;
    }
    if s.controller_mode != ControllerMode::Reconciler {
        d.rule_id = "controller_not_authorized".into();
        return d;
    }
    if s.operator_hold {
        d.rule_id = "operator_hold".into();
        d.attention.push("operator_hold".into());
        return d;
    }
    if s.unresolved_blocker {
        d.rule_id = "unresolved_blocker".into();
        d.attention.push("unresolved_blocker".into());
        return d;
    }
    if s.action_history
        .iter()
        .any(|a| a.state == ActionState::UnknownOutcome)
    {
        d.rule_id = "unknown_action_outcome".into();
        d.attention.push("unknown_action_outcome".into());
        return d;
    }
    let delivery = s.delivery.as_ref();
    if delivery.is_some_and(|x| x.pr_state.as_deref() == Some("closed") && !x.pr_merged) {
        d.rule_id = "closed_unmerged".into();
        d.attention.push("closed_unmerged".into());
        return d;
    }
    if s.max_attempts
        .is_some_and(|max| s.budget_usage.attempts >= max)
        || s.max_execution_ms
            .is_some_and(|max| s.budget_usage.execution_ms >= max)
    {
        d.rule_id = "budget_exhausted".into();
        d.attention.push("needs_budget".into());
        return d;
    }
    if s.retry_due_at_ms.is_some_and(|due| now.0 < due) {
        d.rule_id = "retry_backoff".into();
        return d;
    }
    if s.runtime_health == Some(RuntimeHealth::Failed) {
        let attempt = s
            .attempts
            .iter()
            .rev()
            .find(|attempt| attempt.session_id.is_some());
        let Some(attempt) = attempt else {
            d.rule_id = "runtime_failure".into();
            d.attention.push("runtime_failure".into());
            return d;
        };
        if s.max_runtime_recoveries
            .is_some_and(|max| s.budget_usage.runtime_recoveries >= max)
        {
            d.rule_id = "runtime_recovery_exhausted".into();
            d.attention.push("runtime_failure".into());
            return d;
        }
        let cause = s
            .runtime_failure_fingerprint
            .clone()
            .unwrap_or_else(|| "runtime_failed".into());
        if has_action(
            s,
            ActionKind::RecoverRuntime,
            Some(&attempt.attempt_id),
            &cause,
        ) {
            d.rule_id = "no_progress".into();
            d.attention.push("no_progress".into());
        } else {
            d.rule_id = "runtime_failure".into();
            d.desired_actions.push(make_action(&s.task_id,Some(&attempt.attempt_id),ActionKind::RecoverRuntime,cause,json!({"session_id":attempt.session_id,"failure_fingerprint":s.runtime_failure_fingerprint})));
        }
        return d;
    }
    if delivery.is_some_and(|x| x.work_branch.is_none()) {
        d.rule_id = "branch_missing".into();
        d.attention.push("branch_deleted".into());
        return d;
    }
    if delivery.is_some_and(|x| x.unexpected_force_push) {
        d.rule_id = "unexpected_head_change".into();
        d.attention.push("ambiguous_delivery".into());
        return d;
    }
    if delivery.is_some_and(|x| x.changes_requested) {
        d.rule_id = "changes_requested_review".into();
        d.attention.push("changed_requested_review".into());
        return d;
    }
    if s.attempts.iter().any(|a| {
        (a.lifecycle == AttemptLifecycle::Running && a.turn_state.as_deref() != Some("completed"))
            || a.turn_state.as_deref() == Some("submitted")
    }) {
        d.rule_id = "active_turn".into();
        return d;
    }
    if let Some(x) = delivery {
        if x.pr_state.is_none() {
            d.rule_id = "waiting_for_pr_discovery".into();
            return d;
        }
        if !x.check_policy_known {
            d.rule_id = "required_check_policy_unknown".into();
            d.attention.push("required_check_policy_unknown".into());
            return d;
        }
        let sha = x.evaluation_sha.as_deref().unwrap_or("");
        let failing: Vec<_> = x
            .required_checks
            .iter()
            .filter(|c| c.evaluation_sha == sha && c.state == CheckState::Failing)
            .map(|c| c.context.clone())
            .collect();
        if !failing.is_empty() {
            if x.evaluation_kind == Some(EvaluationKind::MergeGroup) {
                d.rule_id = "merge_group_checks_failing".into();
                d.attention.push("integration_checks_failing".into());
                return d;
            }
            let mut failure_identity: Vec<_> = x
                .required_checks
                .iter()
                .filter(|check| check.evaluation_sha == sha && check.state == CheckState::Failing)
                .map(|check| {
                    format!(
                        "{}:{}:{}",
                        check.source,
                        check.context,
                        check.failure_fingerprint.as_deref().unwrap_or("failure")
                    )
                })
                .collect();
            failure_identity.sort();
            let cause = digest(&format!(
                "{}:{}:{:?}:{}",
                x.pr_head_sha.as_deref().unwrap_or(""),
                sha,
                x.evaluation_kind,
                failure_identity.join("|")
            ));
            let continuation_count = s
                .budget_usage
                .continuations_by_reason
                .get("checks_failed")
                .copied()
                .unwrap_or(0);
            let continuation_exhausted = s
                .max_continuations_by_reason
                .get("checks_failed")
                .is_some_and(|max| continuation_count >= *max)
                || s.max_ci_retries
                    .is_some_and(|max| s.budget_usage.ci_retries >= max);
            if continuation_exhausted {
                d.rule_id = "budget_exhausted".into();
                d.attention.push("needs_budget".into());
                return d;
            }
            let running = s.attempts.iter().find(|a| {
                a.session_healthy
                    && a.session_id.is_some()
                    && (a.lifecycle == AttemptLifecycle::Running
                        || a.lifecycle == AttemptLifecycle::Ended)
            });
            if let Some(a) = running {
                if has_action(s, ActionKind::ChecksFailed, Some(&a.attempt_id), &cause) {
                    d.rule_id = "no_progress".into();
                    d.attention.push("no_progress".into());
                } else {
                    d.rule_id = "required_checks_failing".into();
                    d.desired_actions.push(make_action(&s.task_id, Some(&a.attempt_id), ActionKind::ChecksFailed, cause, json!({"checks": failing, "head_sha": x.pr_head_sha, "evaluation_sha": sha})));
                }
                return d;
            }
        }
        if x.merge_conflict {
            let count = s
                .budget_usage
                .continuations_by_reason
                .get("merge_conflict")
                .copied()
                .unwrap_or(0);
            if s.max_continuations_by_reason
                .get("merge_conflict")
                .is_some_and(|max| count >= *max)
            {
                d.rule_id = "budget_exhausted".into();
                d.attention.push("needs_budget".into());
                return d;
            }
            if let Some(a) = s
                .attempts
                .iter()
                .find(|a| a.session_healthy && a.session_id.is_some())
            {
                let cause = digest(&format!(
                    "{}:{}:{}",
                    x.pr_head_sha.as_deref().unwrap_or(""),
                    x.base_revision.as_deref().unwrap_or(""),
                    "merge_conflict"
                ));
                if has_action(s, ActionKind::MergeConflict, Some(&a.attempt_id), &cause) {
                    d.rule_id = "no_progress".into();
                    d.attention.push("no_progress".into());
                } else {
                    d.rule_id = "merge_conflict".into();
                    d.desired_actions.push(make_action(
                        &s.task_id,
                        Some(&a.attempt_id),
                        ActionKind::MergeConflict,
                        cause,
                        json!({"head_sha":x.pr_head_sha,"base_revision":x.base_revision}),
                    ));
                }
                return d;
            }
        }
        if x.pr_merged {
            d.rule_id = "delivery_observed".into();
            return d;
        }
        if x.required_checks.iter().any(|c| {
            c.evaluation_sha != sha
                || c.state == CheckState::Unknown
                || c.state == CheckState::Pending
        }) {
            d.rule_id = "required_checks_pending".into();
            return d;
        }
        if s.merge_wait_due_at_ms.is_some_and(|due| now.0 >= due) {
            d.rule_id = "waiting_for_merge_too_long".into();
            d.attention.push("waiting_for_merge_too_long".into());
            return d;
        }
        if x.pr_state.as_deref() == Some("open") {
            d.rule_id = "waiting_for_merge".into();
            return d;
        }
    }
    if !s.dependencies_all_completed {
        d.rule_id = "dependencies_incomplete".into();
        if s.phase.as_deref() == Some("blocked") {
            d.attention
                .push("terminal_predecessor_blocks_dependency".into());
        }
        return d;
    }
    if s.attempts.iter().any(|a| {
        matches!(
            a.lifecycle,
            AttemptLifecycle::Queued | AttemptLifecycle::Provisioning
        )
    }) {
        d.rule_id = "attempt_starting".into();
        return d;
    }
    d.rule_id = "task_runnable".into();
    let ordinal = s.budget_usage.attempts + 1;
    d.desired_actions.push(make_action(
        &s.task_id,
        None,
        ActionKind::CreateAttempt,
        format!("implementation:{ordinal}"),
        json!({"role":"implementation","ordinal":ordinal}),
    ));
    d
}

fn completion_satisfied(s: &TaskSnapshot) -> bool {
    match &s.completion_policy {
        Some(CompletionPolicy::Evidence { required_kinds }) => {
            !required_kinds.is_empty()
                && required_kinds.iter().all(|kind| {
                    s.completion_evidence.iter().any(|evidence| {
                        evidence.kind == *kind
                            && evidence.fresh
                            && evidence.trusted
                            && evidence.provenance != ObservationProvenance::Agent
                            && completion_evidence_matches_binding(s, evidence)
                    })
                })
        }
        Some(CompletionPolicy::AllChildrenCompleted) => {
            s.child_count > 0
                && s.children_completed == s.child_count
                && s.children_terminal_noncompleted == 0
        }
        Some(CompletionPolicy::Manual) => s.completion_evidence.iter().any(|evidence| {
            evidence.kind == "manual_completion"
                && evidence.fresh
                && evidence.trusted
                && evidence.provenance != ObservationProvenance::Agent
                && completion_evidence_matches_binding(s, evidence)
        }),
        None => false,
    }
}

fn completion_evidence_matches_binding(
    snapshot: &TaskSnapshot,
    evidence: &CompletionEvidence,
) -> bool {
    if evidence.kind == "delivery_complete"
        && snapshot
            .delivery
            .as_ref()
            .is_some_and(|delivery| delivery.pr_state.is_some() && !delivery.pr_merged)
    {
        return false;
    }
    match snapshot
        .delivery
        .as_ref()
        .and_then(|delivery| delivery.pr_head_sha.as_deref())
    {
        Some(expected_head) => evidence.subject_sha.as_deref() == Some(expected_head),
        None => true,
    }
}

/// Canonical JSON for a snapshot, excluding polling time and collection churn.
pub fn canonical_snapshot(snapshot: &Value) -> Value {
    fn clean(v: &Value, key: Option<&str>) -> Value {
        match v {
            Value::Object(m) => Value::Object(
                m.iter()
                    .filter(|(k, _)| {
                        !matches!(
                            k.as_str(),
                            "logical_time_ms"
                                | "recorded_at"
                                | "collection_sequence"
                                | "poll_timestamp"
                                | "decision_audit"
                        )
                    })
                    .map(|(k, v)| (k.clone(), clean(v, Some(k))))
                    .collect(),
            ),
            Value::Array(a) => {
                let mut values: Vec<_> = a.iter().map(|value| clean(value, None)).collect();
                if matches!(
                    key,
                    Some(
                        "predecessors"
                            | "relevant"
                            | "continuation_fingerprints_sent"
                            | "required_checks"
                            | "grants"
                    )
                ) {
                    values.sort_by_key(|value| {
                        serde_json::to_string(value).expect("JSON value serializes")
                    });
                }
                Value::Array(values)
            }
            _ => v.clone(),
        }
    }
    clean(snapshot, None)
}
pub fn snapshot_hash(snapshot: &Value) -> String {
    digest(&serde_json::to_string(&canonical_snapshot(snapshot)).expect("JSON value serializes"))
}
pub fn actions_hash(actions: &[ProposedAction]) -> String {
    digest(&serde_json::to_string(actions).expect("actions serialize"))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecisionRecord {
    pub schema_version: u32,
    pub reconciler_version: String,
    pub task_id: String,
    pub task_version: u64,
    pub snapshot_reconcile_generation: u64,
    pub decision_sequence: u64,
    pub generation: u64,
    pub logical_time_ms: i64,
    pub snapshot_hash: String,
    pub actions_hash: String,
    pub rule_id: String,
    pub canonical_snapshot_json: Value,
    pub canonical_actions_json: Value,
}
impl DecisionRecord {
    pub fn new(s: &TaskSnapshot, now: LogicalTime, source: &Value, d: &Decision) -> Self {
        let snapshot = canonical_snapshot(source);
        let actions = serde_json::to_value(&d.desired_actions).expect("actions serialize");
        Self {
            schema_version: 1,
            reconciler_version: RECONCILER_VERSION.into(),
            task_id: s.task_id.clone(),
            task_version: s.task_version,
            snapshot_reconcile_generation: s.reconcile_generation,
            decision_sequence: 0,
            generation: 0,
            logical_time_ms: now.0,
            snapshot_hash: snapshot_hash(source),
            actions_hash: actions_hash(&d.desired_actions),
            rule_id: d.rule_id.clone(),
            canonical_snapshot_json: snapshot,
            canonical_actions_json: actions,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayError {
    UnsupportedVersion(String),
}
pub fn replay(
    snapshot: &TaskSnapshot,
    now: LogicalTime,
    evaluator_version: &str,
) -> Result<Decision, ReplayError> {
    if evaluator_version != RECONCILER_VERSION {
        return Err(ReplayError::UnsupportedVersion(evaluator_version.into()));
    }
    Ok(reconcile(snapshot, now))
}

/// Minimal transaction contract for an isolated durable-outbox implementation.
pub mod outbox {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};
    #[cfg(test)]
    pub mod failpoints {
        use std::cell::Cell;
        thread_local! { static ARMED: Cell<Option<&'static str>> = const { Cell::new(None) }; }
        pub const ALL: &[&str] = &[
            "reconcile.before_decision_commit",
            "reconcile.after_decision_commit",
            "outbox.before_claim",
            "outbox.after_claim_before_dispatch",
            "outbox.after_side_effect_before_result_commit",
            "observer.after_observation_commit_before_wake",
            "task.before_terminal_commit",
            "gc.after_schedule_before_cleanup",
        ];
        pub const INTEGRATION_GATED: &[&str] = &[
            "task.before_terminal_commit",
            "gc.after_schedule_before_cleanup",
        ];
        pub fn arm(name: &'static str) {
            assert!(ALL.contains(&name));
            ARMED.with(|armed| armed.set(Some(name)));
        }
        pub fn hit(name: &str) -> bool {
            ARMED.with(|armed| {
                if armed.get() == Some(name) {
                    armed.set(None);
                    true
                } else {
                    false
                }
            })
        }
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct ActionRecord {
        pub action: ProposedAction,
        pub generation: u64,
        pub state: ActionState,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum CommitResult {
        Applied { generation: u64, inserted: usize },
        Unchanged { generation: u64 },
        Conflict { actual_generation: u64 },
    }
    #[derive(Default)]
    pub struct MemoryDecisionStore {
        generation: u64,
        keys: BTreeSet<String>,
        actions: BTreeMap<String, ActionRecord>,
        decisions: Vec<DecisionRecord>,
    }
    impl MemoryDecisionStore {
        /// Compare desired keys and generation atomically. No-op wakes preserve executing rows and audit count.
        pub fn commit(
            &mut self,
            expected_generation: u64,
            decision: DecisionRecord,
            desired: &[ProposedAction],
        ) -> CommitResult {
            if expected_generation != self.generation {
                return CommitResult::Conflict {
                    actual_generation: self.generation,
                };
            }
            let next: BTreeSet<_> = desired.iter().map(|a| a.idempotency_key.clone()).collect();
            if next == self.keys {
                return CommitResult::Unchanged {
                    generation: self.generation,
                };
            }
            let generation = self.generation + 1;
            for (key, row) in self.actions.iter_mut() {
                if !next.contains(key) && row.state == ActionState::Pending {
                    row.state = ActionState::Superseded;
                }
            }
            let mut inserted = 0;
            for action in desired {
                if !self.actions.contains_key(&action.idempotency_key) {
                    self.actions.insert(
                        action.idempotency_key.clone(),
                        ActionRecord {
                            action: action.clone(),
                            generation,
                            state: ActionState::Pending,
                        },
                    );
                    inserted += 1;
                }
            }
            self.keys = next;
            self.generation = generation;
            let mut decision = decision;
            decision.generation = generation;
            decision.decision_sequence = self.decisions.len() as u64 + 1;
            self.decisions.push(decision);
            CommitResult::Applied {
                generation,
                inserted,
            }
        }
        pub fn claim(
            &mut self,
            key: &str,
            generation: u64,
            authorized: bool,
            controller: ControllerMode,
            held: bool,
        ) -> bool {
            if generation != self.generation
                || !authorized
                || controller != ControllerMode::Reconciler
                || held
                || !self.keys.contains(key)
            {
                return false;
            }
            if let Some(row) = self.actions.get_mut(key) {
                if row.state == ActionState::Pending {
                    row.state = ActionState::Executing;
                    return true;
                }
            }
            false
        }
        pub fn mark_unknown_outcome(&mut self, key: &str) {
            if let Some(row) = self.actions.get_mut(key) {
                if row.state == ActionState::Executing {
                    row.state = ActionState::UnknownOutcome;
                }
            }
        }
        /// Uncertain effects are observed and classified, never automatically replayed.
        pub fn recover_unknown(&mut self, key: &str, observed_applied: Option<bool>) {
            if let Some(row) = self.actions.get_mut(key) {
                if row.state == ActionState::UnknownOutcome {
                    row.state = match observed_applied {
                        Some(true) => ActionState::Succeeded,
                        Some(false) => ActionState::Failed,
                        None => ActionState::UnknownOutcome,
                    };
                }
            }
        }
        pub fn generation(&self) -> u64 {
            self.generation
        }
        pub fn decision_count(&self) -> usize {
            self.decisions.len()
        }
        pub fn action(&self, key: &str) -> Option<&ActionRecord> {
            self.actions.get(key)
        }
    }

    /// SQLite implementation of the isolated decision/action outbox contract.
    /// It owns only reconciler tables and never stores canonical Task state.
    pub struct SqliteDecisionStore {
        connection: rusqlite::Connection,
    }
    impl SqliteDecisionStore {
        pub fn open(path: impl AsRef<std::path::Path>) -> rusqlite::Result<Self> {
            let connection = rusqlite::Connection::open(path)?;
            Self::initialize(connection)
        }
        pub fn in_memory() -> rusqlite::Result<Self> {
            Self::initialize(rusqlite::Connection::open_in_memory()?)
        }
        fn initialize(connection: rusqlite::Connection) -> rusqlite::Result<Self> {
            connection.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS reconcile_control (
                   task_id TEXT PRIMARY KEY, generation INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS reconcile_decisions (
                   task_id TEXT NOT NULL, sequence INTEGER NOT NULL, generation INTEGER NOT NULL,
                   record_json TEXT NOT NULL, PRIMARY KEY(task_id, sequence)
                 );
                 CREATE TABLE IF NOT EXISTS reconcile_actions (
                   task_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, generation INTEGER NOT NULL,
                   action_json TEXT NOT NULL, state TEXT NOT NULL,
                   PRIMARY KEY(task_id, idempotency_key)
                 );
                 CREATE TABLE IF NOT EXISTS reconcile_desired_actions (
                   task_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, generation INTEGER NOT NULL,
                   PRIMARY KEY(task_id, idempotency_key)
                 );",
            )?;
            Ok(Self { connection })
        }
        pub fn commit(
            &mut self,
            task_id: &str,
            expected_generation: u64,
            decision: &DecisionRecord,
            desired: &[ProposedAction],
        ) -> rusqlite::Result<CommitResult> {
            use rusqlite::{params, TransactionBehavior};
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT OR IGNORE INTO reconcile_control(task_id,generation) VALUES(?1,0)",
                [task_id],
            )?;
            let actual: u64 = tx.query_row(
                "SELECT generation FROM reconcile_control WHERE task_id=?1",
                [task_id],
                |r| r.get(0),
            )?;
            if actual != expected_generation {
                return Ok(CommitResult::Conflict {
                    actual_generation: actual,
                });
            }
            let mut statement = tx.prepare("SELECT idempotency_key FROM reconcile_desired_actions WHERE task_id=?1 ORDER BY idempotency_key")?;
            let previous: BTreeSet<String> = statement
                .query_map([task_id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            drop(statement);
            let next: BTreeSet<String> =
                desired.iter().map(|a| a.idempotency_key.clone()).collect();
            if previous == next {
                return Ok(CommitResult::Unchanged { generation: actual });
            }
            let generation = actual + 1;
            let mut statement = tx.prepare("SELECT idempotency_key FROM reconcile_actions WHERE task_id=?1 AND state='pending'")?;
            let pending: Vec<String> = statement
                .query_map([task_id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            drop(statement);
            for key in pending {
                if !next.contains(&key) {
                    tx.execute("UPDATE reconcile_actions SET state='superseded' WHERE task_id=?1 AND idempotency_key=?2 AND state='pending'", params![task_id,key])?;
                }
            }
            let mut inserted = 0;
            for action in desired {
                let changed = tx.execute(
                    "INSERT OR IGNORE INTO reconcile_actions(task_id,idempotency_key,generation,action_json,state) VALUES(?1,?2,?3,?4,'pending')",
                    params![task_id, action.idempotency_key, generation, serde_json::to_string(action).expect("action serializes")],
                )?;
                inserted += changed;
            }
            tx.execute(
                "DELETE FROM reconcile_desired_actions WHERE task_id=?1",
                [task_id],
            )?;
            for key in &next {
                tx.execute("INSERT INTO reconcile_desired_actions(task_id,idempotency_key,generation) VALUES(?1,?2,?3)", params![task_id,key,generation])?;
            }
            tx.execute(
                "UPDATE reconcile_control SET generation=?2 WHERE task_id=?1",
                params![task_id, generation],
            )?;
            let sequence: u64 = tx.query_row(
                "SELECT COALESCE(MAX(sequence),0)+1 FROM reconcile_decisions WHERE task_id=?1",
                [task_id],
                |r| r.get(0),
            )?;
            let mut committed_decision = decision.clone();
            committed_decision.generation = generation;
            committed_decision.decision_sequence = sequence;
            tx.execute("INSERT INTO reconcile_decisions(task_id,sequence,generation,record_json) VALUES(?1,?2,?3,?4)", params![task_id,sequence,generation,serde_json::to_string(&committed_decision).expect("decision serializes")])?;
            #[cfg(test)]
            if failpoints::hit("reconcile.before_decision_commit") {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.commit()?;
            #[cfg(test)]
            if failpoints::hit("reconcile.after_decision_commit") {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(CommitResult::Applied {
                generation,
                inserted,
            })
        }
        pub fn claim(
            &mut self,
            task_id: &str,
            key: &str,
            generation: u64,
            mode: ControllerMode,
            held: bool,
        ) -> rusqlite::Result<bool> {
            use rusqlite::{params, OptionalExtension, TransactionBehavior};
            #[cfg(test)]
            if failpoints::hit("outbox.before_claim") {
                return Err(rusqlite::Error::InvalidQuery);
            }
            if mode != ControllerMode::Reconciler || held {
                return Ok(false);
            }
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current: Option<u64> = tx
                .query_row(
                    "SELECT generation FROM reconcile_control WHERE task_id=?1",
                    [task_id],
                    |r| r.get(0),
                )
                .optional()?;
            let authorized:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM reconcile_desired_actions WHERE task_id=?1 AND idempotency_key=?2)",params![task_id,key],|r|r.get(0))?;
            if current != Some(generation) || !authorized {
                tx.rollback()?;
                return Ok(false);
            }
            let changed=tx.execute("UPDATE reconcile_actions SET state='executing' WHERE task_id=?1 AND idempotency_key=?2 AND state='pending'",params![task_id,key])?;
            tx.commit()?;
            #[cfg(test)]
            if changed == 1 && failpoints::hit("outbox.after_claim_before_dispatch") {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(changed == 1)
        }
        pub fn record_result_after_side_effect(
            &mut self,
            task_id: &str,
            key: &str,
            state: ActionState,
        ) -> rusqlite::Result<bool> {
            use rusqlite::{params, TransactionBehavior};
            let state = serde_json::to_value(state)
                .expect("state serializes")
                .as_str()
                .expect("snake case state")
                .to_owned();
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let changed=tx.execute("UPDATE reconcile_actions SET state=?3 WHERE task_id=?1 AND idempotency_key=?2 AND state='executing'",params![task_id,key,state])?;
            #[cfg(test)]
            if changed == 1 && failpoints::hit("outbox.after_side_effect_before_result_commit") {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.commit()?;
            Ok(changed == 1)
        }
        pub fn mark_unknown_outcome(&mut self, task_id: &str, key: &str) -> rusqlite::Result<bool> {
            Ok(self.connection.execute("UPDATE reconcile_actions SET state='unknown_outcome' WHERE task_id=?1 AND idempotency_key=?2 AND state='executing'",rusqlite::params![task_id,key])?==1)
        }
        pub fn observe_unknown(
            &mut self,
            task_id: &str,
            key: &str,
            applied: Option<bool>,
        ) -> rusqlite::Result<bool> {
            let Some(applied) = applied else {
                return Ok(false);
            };
            let state = if applied { "succeeded" } else { "failed" };
            Ok(self.connection.execute("UPDATE reconcile_actions SET state=?3 WHERE task_id=?1 AND idempotency_key=?2 AND state='unknown_outcome'",rusqlite::params![task_id,key,state])?==1)
        }
        pub fn action_state(
            &self,
            task_id: &str,
            key: &str,
        ) -> rusqlite::Result<Option<ActionState>> {
            use rusqlite::OptionalExtension;
            self.connection
                .query_row(
                    "SELECT state FROM reconcile_actions WHERE task_id=?1 AND idempotency_key=?2",
                    rusqlite::params![task_id, key],
                    |r| {
                        let state: String = r.get(0)?;
                        serde_json::from_value(json!(state)).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })
                    },
                )
                .optional()
        }
        pub fn generation(&self, task_id: &str) -> rusqlite::Result<Option<u64>> {
            use rusqlite::OptionalExtension;
            self.connection
                .query_row(
                    "SELECT generation FROM reconcile_control WHERE task_id=?1",
                    [task_id],
                    |r| r.get(0),
                )
                .optional()
        }
        pub fn decision_count(&self, task_id: &str) -> rusqlite::Result<u64> {
            self.connection.query_row(
                "SELECT COUNT(*) FROM reconcile_decisions WHERE task_id=?1",
                [task_id],
                |r| r.get(0),
            )
        }
        pub fn decision_record(
            &self,
            task_id: &str,
            sequence: u64,
        ) -> rusqlite::Result<Option<DecisionRecord>> {
            use rusqlite::OptionalExtension;
            self.connection
                .query_row(
                    "SELECT record_json FROM reconcile_decisions WHERE task_id=?1 AND sequence=?2",
                    rusqlite::params![task_id, sequence],
                    |row| {
                        let raw: String = row.get(0)?;
                        serde_json::from_str(&raw).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    },
                )
                .optional()
        }
    }
}

/// GitHub check normalization keeps policy separate from provider records and binds each result to its exact evaluation SHA.
pub mod github {
    use super::*;
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct RequiredContext {
        pub context: String,
        pub source: String,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct CheckRun {
        pub run_id: u64,
        pub name: String,
        pub sha: String,
        pub conclusion: Option<String>,
        pub status: String,
        pub updated_at: Option<String>,
        pub details_fingerprint: Option<String>,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct CommitStatus {
        pub context: String,
        pub sha: String,
        pub state: String,
        pub updated_at: Option<String>,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Policy {
        Known(Vec<RequiredContext>),
        Unavailable,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Evaluation {
        pub pr_head_sha: String,
        pub evaluation_sha: String,
        pub evaluation_kind: EvaluationKind,
        pub checks: Vec<RequiredCheck>,
        pub policy_known: bool,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct PullRequestFacts {
        pub number: u64,
        pub head_sha: String,
        pub evaluation_sha: String,
        pub evaluation_kind: EvaluationKind,
        pub state: String,
        pub merged: bool,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum ProviderError {
        Unavailable,
        RateLimited,
        PermissionDenied,
        InvalidResponse,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct ObservationRequest {
        pub repository: String,
        pub base_ref: String,
        pub work_branch: String,
        pub bound_pr_number: Option<u64>,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct DeliveryObservation {
        pub repository: String,
        pub work_branch: String,
        pub branch_exists: bool,
        pub pull_request: Option<PullRequestFacts>,
        pub required_checks: Vec<RequiredCheck>,
        pub required_policy_known: bool,
    }
    impl DeliveryObservation {
        pub fn into_reducer_delivery(&self, base_revision: Option<String>) -> Delivery {
            let pr = self.pull_request.as_ref();
            Delivery {
                work_branch: self.branch_exists.then(|| self.work_branch.clone()),
                base_revision,
                pr_head_sha: pr.map(|facts| facts.head_sha.clone()),
                evaluation_sha: pr.map(|facts| facts.evaluation_sha.clone()),
                evaluation_kind: pr.map(|facts| facts.evaluation_kind.clone()),
                pr_state: pr.map(|facts| facts.state.clone()),
                check_policy_known: self.required_policy_known,
                unexpected_force_push: false,
                changes_requested: false,
                merge_conflict: false,
                pr_merged: pr.is_some_and(|facts| facts.merged),
                required_checks: self.required_checks.clone(),
            }
        }
    }
    /// Read-only provider boundary. Implementations must query the Task's known branch/PR only.
    pub trait GitHubReadPort {
        fn branch_exists(&self, repository: &str, branch: &str) -> Result<bool, ProviderError>;
        fn pull_request(
            &self,
            repository: &str,
            branch: &str,
            bound_number: Option<u64>,
        ) -> Result<Option<PullRequestFacts>, ProviderError>;
        fn required_policy(
            &self,
            repository: &str,
            base_ref: &str,
        ) -> Result<Policy, ProviderError>;
        fn check_runs(
            &self,
            repository: &str,
            evaluation_sha: &str,
        ) -> Result<Vec<CheckRun>, ProviderError>;
        fn commit_statuses(
            &self,
            repository: &str,
            evaluation_sha: &str,
        ) -> Result<Vec<CommitStatus>, ProviderError>;
    }
    pub struct GitHubCodeHost<P> {
        port: P,
    }
    impl<P: GitHubReadPort> GitHubCodeHost<P> {
        pub fn new(port: P) -> Self {
            Self { port }
        }
        pub fn observe(
            &self,
            request: &ObservationRequest,
        ) -> Result<DeliveryObservation, ProviderError> {
            let branch_exists = self
                .port
                .branch_exists(&request.repository, &request.work_branch)?;
            if !branch_exists {
                return Ok(DeliveryObservation {
                    repository: request.repository.clone(),
                    work_branch: request.work_branch.clone(),
                    branch_exists: false,
                    pull_request: None,
                    required_checks: vec![],
                    required_policy_known: false,
                });
            }
            let pr = self.port.pull_request(
                &request.repository,
                &request.work_branch,
                request.bound_pr_number,
            )?;
            let Some(pr) = pr else {
                return Ok(DeliveryObservation {
                    repository: request.repository.clone(),
                    work_branch: request.work_branch.clone(),
                    branch_exists: true,
                    pull_request: None,
                    required_checks: vec![],
                    required_policy_known: true,
                });
            };
            let policy = self
                .port
                .required_policy(&request.repository, &request.base_ref)
                .unwrap_or(Policy::Unavailable);
            let policy_known = matches!(&policy, Policy::Known(_));
            let runs = self
                .port
                .check_runs(&request.repository, &pr.evaluation_sha);
            let statuses = self
                .port
                .commit_statuses(&request.repository, &pr.evaluation_sha);
            let mut evaluation = evaluate(
                policy,
                &pr.head_sha,
                &pr.evaluation_sha,
                pr.evaluation_kind.clone(),
                runs.as_ref().map(Vec::as_slice).unwrap_or(&[]),
                statuses.as_ref().map(Vec::as_slice).unwrap_or(&[]),
            );
            if runs.is_err() || statuses.is_err() {
                for check in &mut evaluation.checks {
                    let failed_api = if check.source == "check_run" {
                        runs.is_err()
                    } else {
                        statuses.is_err()
                    };
                    if failed_api {
                        check.state = CheckState::Unknown;
                    }
                }
            }
            for check in &mut evaluation.checks {
                if check.state == CheckState::Failing {
                    let mut identities: Vec<_> = runs
                        .as_ref()
                        .ok()
                        .into_iter()
                        .flatten()
                        .filter(|run| run.sha == pr.evaluation_sha && run.name == check.context)
                        .map(|run| {
                            format!(
                                "{}:{}:{}",
                                run.status,
                                run.conclusion.as_deref().unwrap_or("unknown"),
                                run.details_fingerprint.as_deref().unwrap_or("")
                            )
                        })
                        .collect();
                    identities.extend(
                        statuses
                            .as_ref()
                            .ok()
                            .into_iter()
                            .flatten()
                            .filter(|status| {
                                status.sha == pr.evaluation_sha && status.context == check.context
                            })
                            .map(|status| status.state.clone()),
                    );
                    identities.sort();
                    check.failure_fingerprint = Some(digest(&identities.join("|")));
                }
            }
            // An inaccessible ruleset must not erase other observed PR facts or claim green.
            Ok(DeliveryObservation {
                repository: request.repository.clone(),
                work_branch: request.work_branch.clone(),
                branch_exists: true,
                pull_request: Some(pr),
                required_checks: evaluation.checks,
                required_policy_known: policy_known,
            })
        }
    }
    pub fn evaluate(
        policy: Policy,
        head: &str,
        evaluation: &str,
        kind: EvaluationKind,
        runs: &[CheckRun],
        statuses: &[CommitStatus],
    ) -> Evaluation {
        let contexts = match &policy {
            Policy::Known(c) => c.clone(),
            Policy::Unavailable => vec![],
        };
        let checks = contexts
            .into_iter()
            .map(|required| {
                let mut states = Vec::new();
                if required.source == "check_run" {
                    if let Some(run)=runs
                        .iter()
                        .filter(|r| r.name == required.context && r.sha == evaluation)
                        .max_by_key(|run|(run.updated_at.as_deref().unwrap_or(""),run.run_id)) {
                        states.push(match (run.status.as_str(), run.conclusion.as_deref()) {
                            ("completed", Some("success" | "neutral" | "skipped")) => {
                                CheckState::Passing
                            }
                            ("completed", Some(_)) => CheckState::Failing,
                            ("completed", None) => CheckState::Unknown,
                            _ => CheckState::Pending,
                        });
                    }
                }
                if required.source == "status" {
                    if let Some(st)=statuses
                        .iter()
                        .filter(|s| s.context == required.context && s.sha == evaluation)
                        .max_by_key(|status|status.updated_at.as_deref().unwrap_or("")) {
                        states.push(match st.state.as_str() {
                            "success" => CheckState::Passing,
                            "failure" | "error" => CheckState::Failing,
                            "pending" => CheckState::Pending,
                            _ => CheckState::Unknown,
                        });
                    }
                }
                let state = if states.is_empty() {
                    CheckState::Pending
                } else if states.contains(&CheckState::Failing) {
                    CheckState::Failing
                } else if states.iter().all(|s| *s == CheckState::Passing) {
                    CheckState::Passing
                } else if states.contains(&CheckState::Pending) {
                    CheckState::Pending
                } else {
                    CheckState::Unknown
                };
                RequiredCheck {
                    context: required.context,
                    source: required.source,
                    state,
                    evaluation_sha: evaluation.into(),
                    failure_fingerprint: None,
                }
            })
            .collect();
        Evaluation {
            pr_head_sha: head.into(),
            evaluation_sha: evaluation.into(),
            evaluation_kind: kind,
            checks,
            policy_known: matches!(policy, Policy::Known(_)),
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn binds_checks_to_evaluation_sha_and_maps_statuses() {
            let p = Policy::Known(vec![
                RequiredContext {
                    context: "ci".into(),
                    source: "check_run".into(),
                },
                RequiredContext {
                    context: "legacy".into(),
                    source: "status".into(),
                },
            ]);
            let runs = [
                CheckRun {
                    run_id:1,
                    name: "ci".into(),
                    sha: "head".into(),
                    conclusion: Some("failure".into()),
                    status: "completed".into(),
                    updated_at:None,
                    details_fingerprint: None,
                },
                CheckRun {
                    run_id:2,
                    name: "ci".into(),
                    sha: "merge".into(),
                    conclusion: Some("neutral".into()),
                    status: "completed".into(),
                    updated_at:None,
                    details_fingerprint: None,
                },
            ];
            let sts = [CommitStatus {
                context: "legacy".into(),
                sha: "merge".into(),
                state: "success".into(),
                updated_at:None,
            }];
            let e = evaluate(p, "head", "merge", EvaluationKind::TestMerge, &runs, &sts);
            assert_eq!(e.pr_head_sha, "head");
            assert_eq!(e.checks[0].state, CheckState::Passing);
            assert_eq!(e.checks[1].state, CheckState::Passing);
        }
        #[test]
        fn unknown_policy_never_claims_green() {
            let e = evaluate(
                Policy::Unavailable,
                "h",
                "h",
                EvaluationKind::Head,
                &[],
                &[],
            );
            assert!(!e.policy_known);
            assert!(e.checks.is_empty());
        }
    }
    #[cfg(test)]
    mod adapter_tests {
        use super::*;
        #[derive(Clone)]
        struct FakePort {
            branch: Result<bool, ProviderError>,
            pr: Result<Option<PullRequestFacts>, ProviderError>,
            policy: Result<Policy, ProviderError>,
            runs: Result<Vec<CheckRun>, ProviderError>,
            statuses: Result<Vec<CommitStatus>, ProviderError>,
        }
        impl GitHubReadPort for FakePort {
            fn branch_exists(&self, _: &str, _: &str) -> Result<bool, ProviderError> {
                self.branch.clone()
            }
            fn pull_request(
                &self,
                _: &str,
                _: &str,
                _: Option<u64>,
            ) -> Result<Option<PullRequestFacts>, ProviderError> {
                self.pr.clone()
            }
            fn required_policy(&self, _: &str, _: &str) -> Result<Policy, ProviderError> {
                self.policy.clone()
            }
            fn check_runs(&self, _: &str, _: &str) -> Result<Vec<CheckRun>, ProviderError> {
                self.runs.clone()
            }
            fn commit_statuses(
                &self,
                _: &str,
                _: &str,
            ) -> Result<Vec<CommitStatus>, ProviderError> {
                self.statuses.clone()
            }
        }
        fn request() -> ObservationRequest {
            ObservationRequest {
                repository: "org/repo".into(),
                base_ref: "main".into(),
                work_branch: "anvil/task_x".into(),
                bound_pr_number: None,
            }
        }
        fn pull() -> PullRequestFacts {
            PullRequestFacts {
                number: 42,
                head_sha: "head".into(),
                evaluation_sha: "merge".into(),
                evaluation_kind: EvaluationKind::TestMerge,
                state: "open".into(),
                merged: false,
            }
        }
        fn port() -> FakePort {
            FakePort {
                branch: Ok(true),
                pr: Ok(Some(pull())),
                policy: Ok(Policy::Known(vec![RequiredContext {
                    context: "CI".into(),
                    source: "check_run".into(),
                }])),
                runs: Ok(vec![CheckRun {
                    run_id:1,
                    name: "CI".into(),
                    sha: "merge".into(),
                    conclusion: Some("success".into()),
                    status: "completed".into(),
                    updated_at:None,
                    details_fingerprint: None,
                }]),
                statuses: Ok(vec![]),
            }
        }
        #[test]
        fn observer_discovers_branch_pr_and_preserves_head_evaluation_identity() {
            let observation = GitHubCodeHost::new(port()).observe(&request()).unwrap();
            let pr = observation.pull_request.unwrap();
            assert_eq!(pr.number, 42);
            assert_eq!(pr.head_sha, "head");
            assert_eq!(pr.evaluation_sha, "merge");
            assert_eq!(pr.evaluation_kind, EvaluationKind::TestMerge);
            assert!(observation.required_policy_known);
            assert_eq!(observation.required_checks[0].state, CheckState::Passing);
        }
        #[test]
        fn provider_errors_cannot_become_passing_checks_or_clear_delivery_facts() {
            let mut unavailable = port();
            unavailable.policy = Err(ProviderError::PermissionDenied);
            let unknown = GitHubCodeHost::new(unavailable)
                .observe(&request())
                .unwrap();
            assert!(!unknown.required_policy_known);
            let mut checks_down = port();
            checks_down.runs = Err(ProviderError::Unavailable);
            let observed = GitHubCodeHost::new(checks_down)
                .observe(&request())
                .unwrap();
            assert_eq!(observed.required_checks[0].state, CheckState::Unknown);
            let mut pr_down = port();
            pr_down.pr = Err(ProviderError::Unavailable);
            assert_eq!(
                GitHubCodeHost::new(pr_down).observe(&request()),
                Err(ProviderError::Unavailable)
            );
        }
        #[test]
        fn missing_task_branch_is_observed_without_global_pr_search() {
            let mut absent = port();
            absent.branch = Ok(false);
            let observed = GitHubCodeHost::new(absent).observe(&request()).unwrap();
            assert!(!observed.branch_exists);
            assert!(observed.pull_request.is_none());
            assert!(observed.required_checks.is_empty());
        }
    }
}

/// Durable poll scheduling contract. A collection sequence and next due time are reserved
/// before the provider call; finishing a stale reservation cannot replace newer facts.
pub mod observer {
    use rusqlite::{params, OptionalExtension, TransactionBehavior};
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct PollReservation {
        pub task_id: String,
        pub collection_sequence: u64,
    }
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct PollState {
        pub collection_sequence: u64,
        pub next_due_at_ms: i64,
        pub consecutive_failures: u32,
        pub last_success_at_ms: Option<i64>,
        pub last_error_class: Option<String>,
    }
    pub struct SqliteObserverSchedule {
        connection: rusqlite::Connection,
    }
    impl SqliteObserverSchedule {
        pub fn open(path: impl AsRef<std::path::Path>) -> rusqlite::Result<Self> {
            let connection = rusqlite::Connection::open(path)?;
            connection.execute_batch("CREATE TABLE IF NOT EXISTS reconcile_observer_schedule(task_id TEXT PRIMARY KEY, collection_sequence INTEGER NOT NULL, next_due_at_ms INTEGER NOT NULL, consecutive_failures INTEGER NOT NULL, last_success_at_ms INTEGER, last_error_class TEXT)")?;
            Ok(Self { connection })
        }
        pub fn reserve(
            &mut self,
            task_id: &str,
            now_ms: i64,
            base_interval_ms: i64,
        ) -> rusqlite::Result<Option<PollReservation>> {
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute("INSERT OR IGNORE INTO reconcile_observer_schedule(task_id,collection_sequence,next_due_at_ms,consecutive_failures) VALUES(?1,0,0,0)",[task_id])?;
            let (sequence,due):(u64,i64)=tx.query_row("SELECT collection_sequence,next_due_at_ms FROM reconcile_observer_schedule WHERE task_id=?1",[task_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
            if now_ms < due {
                tx.commit()?;
                return Ok(None);
            }
            let next = sequence + 1;
            tx.execute("UPDATE reconcile_observer_schedule SET collection_sequence=?2,next_due_at_ms=?3 WHERE task_id=?1",params![task_id,next,now_ms.saturating_add(base_interval_ms.max(0))])?;
            tx.commit()?;
            Ok(Some(PollReservation {
                task_id: task_id.into(),
                collection_sequence: next,
            }))
        }
        pub fn finish(
            &mut self,
            reservation: &PollReservation,
            now_ms: i64,
            base_interval_ms: i64,
            max_backoff_ms: i64,
            result: Result<(), &str>,
        ) -> rusqlite::Result<bool> {
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current:Option<(u64,u32)>=tx.query_row("SELECT collection_sequence,consecutive_failures FROM reconcile_observer_schedule WHERE task_id=?1",[&reservation.task_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let Some((sequence, failures)) = current else {
                tx.rollback()?;
                return Ok(false);
            };
            if sequence != reservation.collection_sequence {
                tx.rollback()?;
                return Ok(false);
            }
            let (next_due, next_failures, last_success, error_class) = match result {
                Ok(()) => (
                    now_ms.saturating_add(base_interval_ms.max(0)),
                    0,
                    Some(now_ms),
                    None,
                ),
                Err(class) => {
                    let next_failures = failures.saturating_add(1);
                    let factor = 1_i64
                        .checked_shl(next_failures.saturating_sub(1).min(62))
                        .unwrap_or(i64::MAX);
                    let delay = base_interval_ms
                        .max(0)
                        .saturating_mul(factor)
                        .min(max_backoff_ms.max(0));
                    (
                        now_ms.saturating_add(delay),
                        next_failures,
                        None,
                        Some(class),
                    )
                }
            };
            tx.execute("UPDATE reconcile_observer_schedule SET next_due_at_ms=?2,consecutive_failures=?3,last_success_at_ms=COALESCE(?4,last_success_at_ms),last_error_class=?5 WHERE task_id=?1",params![reservation.task_id,next_due,next_failures,last_success,error_class])?;
            tx.commit()?;
            #[cfg(test)]
            if super::outbox::failpoints::hit("observer.after_observation_commit_before_wake") {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(true)
        }
        pub fn state(&self, task_id: &str) -> rusqlite::Result<Option<PollState>> {
            self.connection.query_row("SELECT collection_sequence,next_due_at_ms,consecutive_failures,last_success_at_ms,last_error_class FROM reconcile_observer_schedule WHERE task_id=?1",[task_id],|r|Ok(PollState{collection_sequence:r.get(0)?,next_due_at_ms:r.get(1)?,consecutive_failures:r.get(2)?,last_success_at_ms:r.get(3)?,last_error_class:r.get(4)?})).optional()
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn reservation_sequence_backoff_and_stale_finish_are_durable() {
            let file = tempfile::NamedTempFile::new().unwrap();
            let mut store = SqliteObserverSchedule::open(file.path()).unwrap();
            let first = store.reserve("t", 100, 10).unwrap().unwrap();
            assert_eq!(store.reserve("t", 105, 10).unwrap(), None);
            assert!(store
                .finish(&first, 110, 10, 100, Err("rate_limited"))
                .unwrap());
            assert_eq!(store.reserve("t", 119, 10).unwrap(), None);
            let second = store.reserve("t", 120, 10).unwrap().unwrap();
            assert_eq!(second.collection_sequence, 2);
            assert!(!store.finish(&first, 121, 10, 100, Ok(())).unwrap());
            assert!(store.finish(&second, 122, 10, 100, Ok(())).unwrap());
            let state = store.state("t").unwrap().unwrap();
            assert_eq!(state.collection_sequence, 2);
            assert_eq!(state.last_success_at_ms, Some(122));
            assert_eq!(state.consecutive_failures, 0);
        }
        #[test]
        fn post_observation_crash_keeps_committed_sequence_and_facts() {
            let file = tempfile::NamedTempFile::new().unwrap();
            let mut store = SqliteObserverSchedule::open(file.path()).unwrap();
            let reservation = store.reserve("t", 0, 10).unwrap().unwrap();
            super::super::outbox::failpoints::arm("observer.after_observation_commit_before_wake");
            assert!(store.finish(&reservation, 1, 10, 100, Ok(())).is_err());
            assert_eq!(
                store.state("t").unwrap().unwrap().last_success_at_ms,
                Some(1)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snap() -> TaskSnapshot {
        TaskSnapshot {
            schema_version: 1,
            task_id: "task_demo".into(),
            task_version: 8,
            reconcile_generation: 2,
            controller_mode: ControllerMode::Reconciler,
            operator_hold: false,
            lifecycle: Lifecycle::Open,
            completion_policy: Some(CompletionPolicy::Evidence {
                required_kinds: vec!["delivery_complete".into()],
            }),
            completion_evidence: vec![],
            phase: Some("runnable".into()),
            dependencies_all_completed: true,
            child_count: 0,
            children_completed: 0,
            children_terminal_noncompleted: 0,
            delivery: None,
            attempts: vec![],
            unresolved_blocker: false,
            runtime_health: None,
            runtime_failure_fingerprint: None,
            max_runtime_recoveries: Some(2),
            action_history: vec![],
            budget_usage: BudgetUsage::default(),
            max_attempts: Some(4),
            max_continuations_by_reason: Default::default(),
            max_ci_retries: None,
            max_execution_ms: None,
            retry_due_at_ms: None,
            merge_wait_due_at_ms: None,
        }
    }
    #[test]
    fn create_attempt_key_uses_ordinal_not_task_version() {
        let a = reconcile(&snap(), LogicalTime(0));
        let mut s = snap();
        s.task_version += 10;
        assert_eq!(a, reconcile(&s, LogicalTime(99)));
    }
    #[test]
    fn completion_precedes_hold_and_stale_red_checks() {
        let mut s = snap();
        s.operator_hold = true;
        s.completion_evidence.push(CompletionEvidence {
            kind: "delivery_complete".into(),
            provenance: ObservationProvenance::External,
            fresh: true,
            trusted: true,
            subject_sha: Some("head".into()),
        });
        s.delivery = Some(Delivery {
            work_branch: Some("b".into()),
            base_revision: None,
            pr_head_sha: Some("head".into()),
            evaluation_sha: Some("old".into()),
            evaluation_kind: Some(EvaluationKind::Head),
            pr_state: Some("open".into()),
            check_policy_known: true,
            unexpected_force_push: false,
            changes_requested: false,
            merge_conflict: false,
            pr_merged: true,
            required_checks: vec![RequiredCheck {
                context: "ci".into(),
                source: "check_run".into(),
                state: CheckState::Failing,
                evaluation_sha: "old".into(),
                failure_fingerprint: None,
            }],
        });
        assert_eq!(
            reconcile(&s, LogicalTime(0)).rule_id,
            "completion_satisfied"
        );
    }
    #[test]
    fn operator_hold_and_blocker_suppress_attempt() {
        let mut s = snap();
        s.operator_hold = true;
        assert!(reconcile(&s, LogicalTime(0)).desired_actions.is_empty());
        s.operator_hold = false;
        s.unresolved_blocker = true;
        assert!(reconcile(&s, LogicalTime(0)).desired_actions.is_empty());
    }
    #[test]
    fn agent_claims_and_stale_evidence_never_complete() {
        let mut s = snap();
        s.completion_evidence = vec![CompletionEvidence {
            kind: "delivery_complete".into(),
            provenance: ObservationProvenance::Agent,
            fresh: true,
            trusted: true,
            subject_sha: None,
        }];
        assert_ne!(
            reconcile(&s, LogicalTime(0)).rule_id,
            "completion_satisfied"
        );
        s.completion_evidence[0].provenance = ObservationProvenance::Platform;
        s.completion_evidence[0].fresh = false;
        assert_ne!(
            reconcile(&s, LogicalTime(0)).rule_id,
            "completion_satisfied"
        );
    }
    #[test]
    fn delivery_evidence_is_invalidated_when_submitted_head_changes() {
        let mut s = snap();
        s.delivery = Some(Delivery {
            work_branch: Some("anvil/task_demo".into()),
            base_revision: Some("base".into()),
            pr_head_sha: Some("head-1".into()),
            evaluation_sha: Some("head-1".into()),
            evaluation_kind: Some(EvaluationKind::Head),
            pr_state: Some("closed".into()),
            check_policy_known: true,
            unexpected_force_push: false,
            changes_requested: false,
            merge_conflict: false,
            pr_merged: true,
            required_checks: vec![],
        });
        s.completion_evidence.push(CompletionEvidence {
            kind: "delivery_complete".into(),
            provenance: ObservationProvenance::External,
            fresh: true,
            trusted: true,
            subject_sha: Some("head-1".into()),
        });
        assert_eq!(
            reconcile(&s, LogicalTime(0)).rule_id,
            "completion_satisfied"
        );
        s.delivery.as_mut().unwrap().pr_head_sha = Some("head-2".into());
        assert_ne!(
            reconcile(&s, LogicalTime(1)).rule_id,
            "completion_satisfied"
        );
    }
    #[test]
    fn unmerged_pull_request_cannot_satisfy_delivery_complete() {
        let mut s = snap();
        s.delivery = Some(Delivery {
            work_branch: Some("anvil/task_demo".into()),
            base_revision: Some("base".into()),
            pr_head_sha: Some("head".into()),
            evaluation_sha: Some("head".into()),
            evaluation_kind: Some(EvaluationKind::Head),
            pr_state: Some("open".into()),
            check_policy_known: true,
            unexpected_force_push: false,
            changes_requested: false,
            merge_conflict: false,
            pr_merged: false,
            required_checks: vec![],
        });
        s.completion_evidence.push(CompletionEvidence {
            kind: "delivery_complete".into(),
            provenance: ObservationProvenance::External,
            fresh: true,
            trusted: true,
            subject_sha: Some("head".into()),
        });
        assert_ne!(
            reconcile(&s, LogicalTime(0)).rule_id,
            "completion_satisfied"
        );
    }
    #[test]
    fn empty_aggregate_is_not_vacuously_complete() {
        let mut s = snap();
        s.completion_policy = Some(CompletionPolicy::AllChildrenCompleted);
        assert_ne!(
            reconcile(&s, LogicalTime(0)).rule_id,
            "completion_satisfied"
        );
        s.child_count = 2;
        s.children_completed = 2;
        assert_eq!(
            reconcile(&s, LogicalTime(0)).rule_id,
            "completion_satisfied"
        );
    }
    #[test]
    fn retry_deadline_uses_logical_time() {
        let mut s = snap();
        s.retry_due_at_ms = Some(10);
        assert_eq!(reconcile(&s, LogicalTime(9)).rule_id, "retry_backoff");
        assert_eq!(reconcile(&s, LogicalTime(10)).rule_id, "task_runnable");
    }
    #[test]
    fn checks_failure_continues_only_healthy_attempt_within_budget() {
        let mut s = snap();
        s.delivery = Some(Delivery {
            work_branch: Some("task/demo".into()),
            base_revision: Some("base".into()),
            pr_head_sha: Some("head".into()),
            evaluation_sha: Some("head".into()),
            evaluation_kind: Some(EvaluationKind::Head),
            pr_state: Some("open".into()),
            check_policy_known: true,
            unexpected_force_push: false,
            changes_requested: false,
            merge_conflict: false,
            pr_merged: false,
            required_checks: vec![RequiredCheck {
                context: "CI".into(),
                source: "check_run".into(),
                state: CheckState::Failing,
                evaluation_sha: "head".into(),
                failure_fingerprint: Some("lint:E123".into()),
            }],
        });
        s.attempts.push(Attempt {
            attempt_id: "a1".into(),
            ordinal: 1,
            role: "implementation".into(),
            lifecycle: AttemptLifecycle::Ended,
            turn_state: Some("completed".into()),
            session_id: Some("session".into()),
            session_healthy: true,
        });
        let decision = reconcile(&s, LogicalTime(0));
        assert_eq!(decision.rule_id, "required_checks_failing");
        assert_eq!(
            decision.desired_actions[0].attempt_id.as_deref(),
            Some("a1")
        );
        s.max_continuations_by_reason
            .insert("checks_failed".into(), 0);
        let exhausted = reconcile(&s, LogicalTime(0));
        assert_eq!(exhausted.rule_id, "budget_exhausted");
        assert!(exhausted.desired_actions.is_empty());
    }
    #[test]
    fn runtime_failure_is_recovered_only_from_factual_health_and_is_bounded() {
        let mut s = snap();
        s.runtime_health = Some(RuntimeHealth::Failed);
        s.runtime_failure_fingerprint = Some("sandbox_exit:137".into());
        s.attempts.push(Attempt {
            attempt_id: "attempt_1".into(),
            ordinal: 1,
            role: "implementation".into(),
            lifecycle: AttemptLifecycle::Running,
            turn_state: Some("running".into()),
            session_id: Some("session".into()),
            session_healthy: false,
        });
        let recovery = reconcile(&s, LogicalTime(0));
        assert_eq!(recovery.rule_id, "runtime_failure");
        assert_eq!(recovery.desired_actions[0].kind, ActionKind::RecoverRuntime);
        assert_eq!(
            recovery.desired_actions[0].attempt_id.as_deref(),
            Some("attempt_1")
        );
        s.budget_usage.runtime_recoveries = 2;
        assert_eq!(
            reconcile(&s, LogicalTime(1)).rule_id,
            "runtime_recovery_exhausted"
        );
        s.runtime_health = Some(RuntimeHealth::Unknown);
        s.budget_usage.runtime_recoveries = 0;
        assert_ne!(reconcile(&s, LogicalTime(2)).rule_id, "runtime_failure");
    }
    #[test]
    fn repeated_checks_failure_is_suppressed_but_new_sha_is_new_cause() {
        let mut s = snap();
        s.delivery = Some(Delivery {
            work_branch: Some("task/demo".into()),
            base_revision: Some("base".into()),
            pr_head_sha: Some("head".into()),
            evaluation_sha: Some("head".into()),
            evaluation_kind: Some(EvaluationKind::Head),
            pr_state: Some("open".into()),
            check_policy_known: true,
            unexpected_force_push: false,
            changes_requested: false,
            merge_conflict: false,
            pr_merged: false,
            required_checks: vec![RequiredCheck {
                context: "CI".into(),
                source: "check_run".into(),
                state: CheckState::Failing,
                evaluation_sha: "head".into(),
                failure_fingerprint: Some("lint:E1".into()),
            }],
        });
        s.attempts.push(Attempt {
            attempt_id: "a1".into(),
            ordinal: 1,
            role: "implementation".into(),
            lifecycle: AttemptLifecycle::Ended,
            turn_state: Some("completed".into()),
            session_id: Some("ses1".into()),
            session_healthy: true,
        });
        let first = reconcile(&s, LogicalTime(0));
        let action = &first.desired_actions[0];
        s.action_history.push(PriorAction {
            action_kind: ActionKind::ChecksFailed,
            attempt_id: action.attempt_id.clone(),
            cause_fingerprint: action.cause_fingerprint.clone(),
            idempotency_key: action.idempotency_key.clone(),
            state: ActionState::Succeeded,
        });
        assert_eq!(reconcile(&s, LogicalTime(1)).rule_id, "no_progress");
        let delivery = s.delivery.as_mut().unwrap();
        delivery.evaluation_sha = Some("new-evaluation".into());
        for check in &mut delivery.required_checks {
            check.evaluation_sha = "new-evaluation".into();
        }
        assert_eq!(
            reconcile(&s, LogicalTime(2)).rule_id,
            "required_checks_failing"
        );
    }

    #[test]
    fn merge_group_only_regression_does_not_prompt_worker() {
        let mut s = snap();
        s.delivery = Some(Delivery {
            work_branch: Some("task/demo".into()),
            base_revision: None,
            pr_head_sha: Some("head".into()),
            evaluation_sha: Some("group".into()),
            evaluation_kind: Some(EvaluationKind::MergeGroup),
            pr_state: Some("open".into()),
            check_policy_known: true,
            unexpected_force_push: false,
            changes_requested: false,
            merge_conflict: false,
            pr_merged: false,
            required_checks: vec![RequiredCheck {
                context: "CI".into(),
                source: "check_run".into(),
                state: CheckState::Failing,
                evaluation_sha: "group".into(),
                failure_fingerprint: None,
            }],
        });
        let decision = reconcile(&s, LogicalTime(0));
        assert_eq!(decision.rule_id, "merge_group_checks_failing");
        assert!(decision.desired_actions.is_empty());
        assert_eq!(decision.attention, ["integration_checks_failing"]);
    }

    #[test]
    fn inaccessible_required_check_policy_is_not_green() {
        let mut s = snap();
        s.delivery = Some(Delivery {
            work_branch: Some("task/demo".into()),
            base_revision: None,
            pr_head_sha: Some("head".into()),
            evaluation_sha: Some("head".into()),
            evaluation_kind: Some(EvaluationKind::Head),
            pr_state: Some("open".into()),
            check_policy_known: false,
            unexpected_force_push: false,
            changes_requested: false,
            merge_conflict: false,
            pr_merged: false,
            required_checks: vec![],
        });
        let decision = reconcile(&s, LogicalTime(0));
        assert_eq!(decision.rule_id, "required_check_policy_unknown");
        assert!(decision.desired_actions.is_empty());
        assert_eq!(decision.attention, ["required_check_policy_unknown"]);
    }
    #[test]
    fn canonical_hash_ignores_poll_churn() {
        let a = json!({"logical_time_ms":1,"delivery":{"collection_sequence":2,"sha":"a"}});
        let b = json!({"logical_time_ms":8,"delivery":{"collection_sequence":99,"sha":"a"}});
        assert_eq!(snapshot_hash(&a), snapshot_hash(&b));
    }

    #[test]
    fn fixture_replays_with_versioned_rule_and_action_identity() {
        let fixture: TaskSnapshot =
            serde_json::from_str(include_str!("../fixtures/fresh-runnable.json")).unwrap();
        let expected = reconcile(&fixture, LogicalTime(1_791_600_000_000));
        assert_eq!(expected.rule_id, "task_runnable");
        assert_eq!(expected.desired_actions.len(), 1);
        let golden: Value =
            serde_json::from_str(include_str!("../fixtures/fresh-runnable.expected.json")).unwrap();
        assert_eq!(
            serde_json::to_value(&expected.desired_actions).unwrap(),
            golden["actions"]
        );
        assert_eq!(expected.rule_id, golden["rule_id"]);
        assert_eq!(
            serde_json::to_value(&expected.attention).unwrap(),
            golden["attention"]
        );
        let replayed =
            replay(&fixture, LogicalTime(1_791_600_000_000), RECONCILER_VERSION).unwrap();
        assert_eq!(replayed, expected);
        assert_eq!(
            replay(&fixture, LogicalTime(0), "unknown-version"),
            Err(ReplayError::UnsupportedVersion("unknown-version".into()))
        );
    }
    #[test]
    fn frozen_v0_wire_snapshot_decodes_and_matches_golden_action_intent() {
        let source: Value =
            serde_json::from_str(include_str!("../fixtures/frozen-v0-fresh-runnable.json"))
                .unwrap();
        let (snapshot, now) = frozen_v0::decode_snapshot(&source).unwrap();
        assert_eq!(now, LogicalTime(1_791_600_000_000));
        let decision = reconcile(&snapshot, now);
        let golden: Value =
            serde_json::from_str(include_str!("../fixtures/fresh-runnable.expected.json")).unwrap();
        assert_eq!(decision.rule_id, golden["rule_id"]);
        assert_eq!(
            serde_json::to_value(decision.desired_actions).unwrap(),
            golden["actions"]
        );
    }

    #[test]
    fn frozen_rule_fixture_matrix_matches_ordered_rules() {
        fn overlay(base: &mut Value, patch: Value) {
            match (base, patch) {
                (Value::Object(base), Value::Object(patch)) => {
                    for (key, value) in patch {
                        overlay(base.entry(key).or_insert(Value::Null), value);
                    }
                }
                (base, patch) => *base = patch,
            }
        }
        let base: Value =
            serde_json::from_str(include_str!("../fixtures/fresh-runnable.json")).unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../fixtures/rule-cases.json")).unwrap();
        assert!(cases.len() >= 20);
        for case in cases {
            let mut input = base.clone();
            overlay(&mut input, case["changes"].clone());
            let snapshot: TaskSnapshot = serde_json::from_value(input)
                .unwrap_or_else(|error| panic!("fixture {} invalid: {error}", case["name"]));
            let decision = reconcile(&snapshot, LogicalTime(case["now"].as_i64().unwrap()));
            assert_eq!(
                decision.rule_id,
                case["rule"].as_str().unwrap(),
                "fixture {}",
                case["name"]
            );
            let replayed = replay(
                &snapshot,
                LogicalTime(case["now"].as_i64().unwrap()),
                RECONCILER_VERSION,
            )
            .unwrap();
            assert_eq!(decision, replayed, "fixture {} replay", case["name"]);
        }
    }

    #[test]
    fn canonical_hash_sorts_set_like_collections() {
        let a = json!({"dependencies":{"predecessors":["b","a"]}});
        let b = json!({"dependencies":{"predecessors":["a","b"]}});
        assert_eq!(snapshot_hash(&a), snapshot_hash(&b));
    }
}

#[cfg(test)]
mod outbox_tests {
    use super::outbox::*;
    use super::*;
    use serde_json::json;

    fn desired(key: &str) -> ProposedAction {
        ProposedAction {
            kind: ActionKind::ChecksFailed,
            task_id: "t".into(),
            attempt_id: Some("a".into()),
            cause_fingerprint: "cause".into(),
            idempotency_key: key.into(),
            class: ActionClass::Observable,
            recovery_strategy: RecoveryStrategy::ObserveBeforeRetry,
            payload: json!({}),
        }
    }
    fn record() -> DecisionRecord {
        DecisionRecord {
            schema_version: 1,
            reconciler_version: RECONCILER_VERSION.into(),
            task_id: "t".into(),
            task_version: 1,
            snapshot_reconcile_generation: 1,
            decision_sequence: 0,
            generation: 1,
            logical_time_ms: 0,
            snapshot_hash: "s".into(),
            actions_hash: "a".into(),
            rule_id: "test".into(),
            canonical_snapshot_json: json!({}),
            canonical_actions_json: json!([]),
        }
    }
    #[test]
    fn no_op_sweep_does_not_advance_or_revoke_executing_action() {
        let mut store = MemoryDecisionStore::default();
        let action = desired("key");
        assert_eq!(
            store.commit(0, record(), std::slice::from_ref(&action)),
            CommitResult::Applied {
                generation: 1,
                inserted: 1
            }
        );
        assert!(store.claim("key", 1, true, ControllerMode::Reconciler, false));
        assert_eq!(
            store.commit(1, record(), &[action]),
            CommitResult::Unchanged { generation: 1 }
        );
        assert_eq!(store.generation(), 1);
        assert_eq!(store.decision_count(), 1);
        assert_eq!(store.action("key").unwrap().state, ActionState::Executing);
    }
    #[test]
    fn unknown_outcome_is_only_resolved_by_observation() {
        let mut store = MemoryDecisionStore::default();
        store.commit(0, record(), &[desired("key")]);
        assert!(store.claim("key", 1, true, ControllerMode::Reconciler, false));
        store.mark_unknown_outcome("key");
        store.recover_unknown("key", None);
        assert_eq!(
            store.action("key").unwrap().state,
            ActionState::UnknownOutcome
        );
        store.recover_unknown("key", Some(true));
        assert_eq!(store.action("key").unwrap().state, ActionState::Succeeded);
    }

    #[test]
    fn sqlite_outbox_recovers_unknown_action_and_keeps_noop_generation_stable() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let action = desired("durable-key");
        {
            let mut store = SqliteDecisionStore::open(file.path()).unwrap();
            assert_eq!(
                store
                    .commit("t", 0, &record(), std::slice::from_ref(&action))
                    .unwrap(),
                CommitResult::Applied {
                    generation: 1,
                    inserted: 1
                }
            );
            assert!(store
                .claim("t", "durable-key", 1, ControllerMode::Reconciler, false)
                .unwrap());
            assert!(store.mark_unknown_outcome("t", "durable-key").unwrap());
        }
        let mut store = SqliteDecisionStore::open(file.path()).unwrap();
        assert_eq!(
            store.action_state("t", "durable-key").unwrap(),
            Some(ActionState::UnknownOutcome)
        );
        assert_eq!(
            store.commit("t", 1, &record(), &[action]).unwrap(),
            CommitResult::Unchanged { generation: 1 }
        );
        assert_eq!(store.decision_count("t").unwrap(), 1);
        let decision = store.decision_record("t", 1).unwrap().unwrap();
        assert_eq!(decision.decision_sequence, 1);
        assert_eq!(decision.generation, 1);
        assert_eq!(store.generation("t").unwrap(), Some(1));
        assert!(store
            .observe_unknown("t", "durable-key", Some(true))
            .unwrap());
        assert_eq!(
            store.action_state("t", "durable-key").unwrap(),
            Some(ActionState::Succeeded)
        );
    }

    #[test]
    fn sqlite_failpoints_cover_decision_claim_and_result_crash_boundaries() {
        use super::outbox::failpoints;
        let file = tempfile::NamedTempFile::new().unwrap();
        let action = desired("crash-key");
        let mut store = SqliteDecisionStore::open(file.path()).unwrap();
        failpoints::arm("reconcile.before_decision_commit");
        assert!(store
            .commit("t", 0, &record(), std::slice::from_ref(&action))
            .is_err());
        assert_eq!(store.generation("t").unwrap(), None);
        failpoints::arm("reconcile.after_decision_commit");
        assert!(store
            .commit("t", 0, &record(), std::slice::from_ref(&action))
            .is_err());
        assert_eq!(store.generation("t").unwrap(), Some(1));
        assert_eq!(store.decision_count("t").unwrap(), 1);
        failpoints::arm("outbox.before_claim");
        assert!(store
            .claim("t", "crash-key", 1, ControllerMode::Reconciler, false)
            .is_err());
        assert_eq!(
            store.action_state("t", "crash-key").unwrap(),
            Some(ActionState::Pending)
        );
        failpoints::arm("outbox.after_claim_before_dispatch");
        assert!(store
            .claim("t", "crash-key", 1, ControllerMode::Reconciler, false)
            .is_err());
        assert_eq!(
            store.action_state("t", "crash-key").unwrap(),
            Some(ActionState::Executing)
        );
        failpoints::arm("outbox.after_side_effect_before_result_commit");
        assert!(store
            .record_result_after_side_effect("t", "crash-key", ActionState::Succeeded)
            .is_err());
        assert_eq!(
            store.action_state("t", "crash-key").unwrap(),
            Some(ActionState::Executing)
        );
        assert!(store
            .record_result_after_side_effect("t", "crash-key", ActionState::Succeeded)
            .unwrap());
        assert_eq!(
            store.action_state("t", "crash-key").unwrap(),
            Some(ActionState::Succeeded)
        );
        assert_eq!(failpoints::ALL.len(), 8);
        assert_eq!(failpoints::INTEGRATION_GATED.len(), 2);
    }

    #[test]
    fn stale_cas_conflicts_and_only_pending_undesired_rows_are_superseded() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut store = SqliteDecisionStore::open(file.path()).unwrap();
        let executing = desired("executing");
        let pending = desired("pending");
        let replacement = desired("replacement");
        assert_eq!(
            store
                .commit("t", 0, &record(), &[executing.clone(), pending.clone()])
                .unwrap(),
            CommitResult::Applied {
                generation: 1,
                inserted: 2
            }
        );
        assert!(store
            .claim("t", "executing", 1, ControllerMode::Reconciler, false)
            .unwrap());
        assert_eq!(
            store
                .commit("t", 0, &record(), std::slice::from_ref(&replacement))
                .unwrap(),
            CommitResult::Conflict {
                actual_generation: 1
            }
        );
        assert_eq!(
            store.action_state("t", "pending").unwrap(),
            Some(ActionState::Pending)
        );
        assert_eq!(
            store
                .commit("t", 1, &record(), std::slice::from_ref(&replacement))
                .unwrap(),
            CommitResult::Applied {
                generation: 2,
                inserted: 1
            }
        );
        assert_eq!(
            store.action_state("t", "pending").unwrap(),
            Some(ActionState::Superseded)
        );
        assert_eq!(
            store.action_state("t", "executing").unwrap(),
            Some(ActionState::Executing)
        );
        assert!(!store
            .claim("t", "executing", 2, ControllerMode::Reconciler, false)
            .unwrap());
        assert_eq!(
            store.action_state("t", "executing").unwrap(),
            Some(ActionState::Executing)
        );
    }
}
