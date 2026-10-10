//! Adapter from the pinned v0 TaskSnapshot JSON contract into the isolated reducer mirror.
//! Keep this at the boundary until ANVIL-55's serializer is merged and compatibility-tested.
use crate::*;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

fn object<'a>(value: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    value.get(key).and_then(Value::as_object)
}
fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(ToOwned::to_owned)
}
fn number(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or_default()
}
fn bool_value(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}
fn decode<T: DeserializeOwned>(value: Option<&Value>) -> Option<T> {
    value
        .cloned()
        .and_then(|raw| serde_json::from_value(raw).ok())
}

/// Convert the exact pinned TaskSnapshot shape. Provider collection time and sequence remain in
/// the source JSON for audit, while the kernel receives only semantic normalized facts.
pub fn decode_snapshot(source: &Value) -> Result<(TaskSnapshot, LogicalTime), String> {
    let required = |key: &str| {
        source
            .get(key)
            .ok_or_else(|| format!("snapshot missing {key}"))
    };
    let task_id = string(Some(required("task_id")?)).ok_or("task_id must be a string")?;
    let task_version = number(Some(required("task_version")?));
    let logical_time = required("logical_time_ms")?
        .as_i64()
        .ok_or("logical_time_ms must be i64")?;
    let schema_version = number(Some(required("schema_version")?)) as u32;
    let reconcile_generation = number(source.get("reconcile_generation"));
    let mode =
        decode::<ControllerMode>(source.get("controller_mode")).ok_or("invalid controller_mode")?;
    let lifecycle_state = string(object(source, "lifecycle").and_then(|l| l.get("state")))
        .ok_or("lifecycle.state is required")?;
    let lifecycle = if lifecycle_state == "open" {
        Lifecycle::Open
    } else {
        Lifecycle::Terminal
    };
    let completion_policy = decode::<CompletionPolicy>(source.get("completion_policy"));
    let delivery = decode_delivery(source)?;
    let attempts = decode_attempts(source)?;
    let children = object(source, "children");
    let dependencies = object(source, "dependencies");
    let blocker = source.get("blocker").filter(|v| !v.is_null());
    let action_history = decode_actions(source);
    let budget_usage = decode_budget_usage(source);
    let budget = source.get("budget");
    let max_attempts = budget
        .and_then(|b| b.get("max_attempts"))
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    let max_continuation = budget
        .and_then(|b| b.get("max_continuations_per_reason"))
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    let max_ci_retries = budget
        .and_then(|b| b.get("max_ci_retries"))
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    let max_execution_ms = budget
        .and_then(|b| b.get("max_execution_seconds"))
        .and_then(Value::as_u64)
        .map(|n| n.saturating_mul(1000));
    let mut max_continuations_by_reason = std::collections::BTreeMap::new();
    if let Some(limit) = max_continuation {
        max_continuations_by_reason.insert("checks_failed".into(), limit);
        max_continuations_by_reason.insert("merge_conflict".into(), limit);
    }
    let retry = object(source, "retry_schedule");
    let retry_due_at_ms = retry
        .and_then(|r| r.get("due_at_ms"))
        .and_then(Value::as_i64);
    let merge_wait_due_at_ms = source.get("merge_wait_due_at_ms").and_then(Value::as_i64);
    let runtime = decode_runtime_health(source);
    let completion_evidence = decode_evidence(source);
    let snapshot = TaskSnapshot {
        schema_version,
        task_id,
        task_version,
        reconcile_generation,
        controller_mode: mode,
        operator_hold: bool_value(source.get("operator_hold")),
        lifecycle,
        completion_policy,
        completion_evidence,
        phase: string(source.get("phase")),
        dependencies_all_completed: dependencies
            .and_then(|d| d.get("all_completed"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        child_count: children
            .and_then(|c| c.get("total"))
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        children_completed: children
            .and_then(|c| c.get("completed"))
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        children_terminal_noncompleted: children
            .and_then(|c| c.get("terminal_noncompleted"))
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        delivery,
        attempts,
        unresolved_blocker: blocker.is_some_and(|b| !bool_value(b.get("resolved"))),
        runtime_health: runtime.0,
        runtime_failure_fingerprint: runtime.1,
        max_runtime_recoveries: budget
            .and_then(|b| b.get("max_runtime_recoveries"))
            .and_then(Value::as_u64)
            .map(|n| n as u32),
        action_history,
        budget_usage,
        max_attempts,
        max_continuations_by_reason,
        max_ci_retries,
        max_execution_ms,
        retry_due_at_ms,
        merge_wait_due_at_ms,
    };
    Ok((snapshot, LogicalTime(logical_time)))
}

fn decode_delivery(source: &Value) -> Result<Option<Delivery>, String> {
    let Some(raw) = source.get("delivery") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let checks_value = raw.get("required_checks");
    let required_checks = decode::<Vec<RequiredCheck>>(checks_value).unwrap_or_default();
    let check_policy_known = raw
        .get("required_check_policy_known")
        .and_then(Value::as_bool)
        .unwrap_or(checks_value.is_some());
    let pr_state = string(raw.get("pr_state"));
    Ok(Some(Delivery {
        work_branch: string(raw.get("work_branch")),
        base_revision: string(raw.get("base_revision")),
        pr_head_sha: string(raw.get("pr_head_sha")),
        evaluation_sha: string(raw.get("evaluation_sha")),
        evaluation_kind: decode(raw.get("evaluation_kind")),
        pr_merged: bool_value(raw.get("pr_merged")) || pr_state.as_deref() == Some("merged"),
        pr_state,
        check_policy_known,
        unexpected_force_push: bool_value(raw.get("unexpected_force_push")),
        changes_requested: bool_value(raw.get("changes_requested")),
        merge_conflict: bool_value(raw.get("merge_conflict")),
        required_checks,
    }))
}

fn decode_attempts(source: &Value) -> Result<Vec<Attempt>, String> {
    let Some(values) = source.get("attempts").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let observations = source
        .get("observations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    values
        .iter()
        .map(|raw| {
            let attempt_id = string(raw.get("attempt_id")).ok_or("attempt_id missing")?;
            let attempt_observations: Vec<_> = observations
                .iter()
                .filter(|observation| {
                    string(observation.get("attempt_id")).as_deref() == Some(&attempt_id)
                })
                .collect();
            let session_healthy = attempt_observations.iter().any(|observation| {
                string(observation.get("runtime_health")).as_deref() == Some("healthy")
            });
            let turn_state = string(raw.pointer("/turn/state"));
            Ok(Attempt {
                attempt_id,
                ordinal: number(raw.get("ordinal")) as u32,
                role: string(raw.get("role")).unwrap_or_else(|| "implementation".into()),
                lifecycle: decode(raw.get("lifecycle")).ok_or("invalid attempt lifecycle")?,
                turn_state,
                session_id: string(raw.get("session_id")),
                session_healthy,
            })
        })
        .collect()
}

fn decode_actions(source: &Value) -> Vec<PriorAction> {
    source
        .pointer("/action_history/relevant")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|raw| {
            Some(PriorAction {
                action_kind: decode(raw.get("action_kind"))?,
                attempt_id: string(raw.get("attempt_id")),
                cause_fingerprint: string(raw.get("cause_fingerprint"))?,
                idempotency_key: string(raw.get("idempotency_key"))?,
                state: decode(raw.get("state"))?,
            })
        })
        .collect()
}

fn decode_budget_usage(source: &Value) -> BudgetUsage {
    let raw = source.get("budget_usage");
    BudgetUsage {
        attempts: number(raw.and_then(|v| v.get("attempts"))) as u32,
        continuations_by_reason: decode(raw.and_then(|v| v.get("continuations_by_reason")))
            .unwrap_or_default(),
        ci_retries: number(raw.and_then(|v| v.get("ci_retries"))) as u32,
        verifier_cycles: number(raw.and_then(|v| v.get("verifier_cycles"))) as u32,
        execution_ms: number(raw.and_then(|v| v.get("execution_ms"))),
        runtime_recoveries: number(raw.and_then(|v| v.get("runtime_recoveries"))) as u32,
    }
}

fn decode_runtime_health(source: &Value) -> (Option<RuntimeHealth>, Option<String>) {
    let observations = source
        .get("observations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let latest = observations
        .iter()
        .rev()
        .find(|observation| string(observation.get("kind")).as_deref() == Some("runtime_health"));
    latest.map_or((None, None), |observation| {
        (
            decode(observation.get("state")),
            string(observation.get("failure_fingerprint")),
        )
    })
}

fn decode_evidence(source: &Value) -> Vec<CompletionEvidence> {
    source
        .get("observations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|observation| {
            let kind = string(observation.get("evidence_kind"))?;
            let provenance: ObservationProvenance = decode(observation.get("provenance"))?;
            let fresh = bool_value(observation.get("fresh"))
                || string(observation.get("freshness")).as_deref() == Some("fresh");
            Some(CompletionEvidence {
                kind,
                provenance: provenance.clone(),
                fresh,
                trusted: bool_value(observation.get("trusted"))
                    && provenance != ObservationProvenance::Agent,
                subject_sha: string(observation.get("subject_sha")),
            })
        })
        .collect()
}
