//! Deterministic, I/O-free task reconciliation primitives.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const RECONCILER_VERSION: &str = "anvil-reconcile-v1";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct LogicalTime(pub i64);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControllerMode { Legacy, Shadow, Reconciler }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle { Open, Terminal }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttemptLifecycle { Queued, Provisioning, Running, Ended }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckState { Pending, Passing, Failing, Unknown }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationKind { Head, TestMerge, MergeGroup }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionClass { Idempotent, Observable, Irreversible }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind { CreateAttempt, ChecksFailed, MergeConflict, ObserveDelivery }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionState { Pending, Executing, Succeeded, Failed, UnknownOutcome, Superseded }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequiredCheck { pub context: String, pub source: String, pub state: CheckState, pub evaluation_sha: String }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Delivery {
    pub work_branch: Option<String>, pub base_revision: Option<String>,
    pub pr_head_sha: Option<String>, pub evaluation_sha: Option<String>,
    pub evaluation_kind: Option<EvaluationKind>, pub pr_state: Option<String>,
    #[serde(default)] pub pr_merged: bool, #[serde(default)] pub required_checks: Vec<RequiredCheck>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Attempt {
    pub attempt_id: String, pub ordinal: u32, pub role: String, pub lifecycle: AttemptLifecycle,
    pub turn_state: Option<String>, pub session_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PriorAction { pub action_kind: ActionKind, pub attempt_id: Option<String>, pub cause_fingerprint: String, pub idempotency_key: String, pub state: ActionState }
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BudgetUsage { pub attempts: u32, #[serde(default)] pub continuations_by_reason: std::collections::BTreeMap<String, u32>, pub ci_retries: u32, pub verifier_cycles: u32, pub execution_ms: u64 }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskSnapshot {
    pub schema_version: u32, pub task_id: String, pub task_version: u64, pub reconcile_generation: u64,
    pub controller_mode: ControllerMode, pub operator_hold: bool, pub lifecycle: Lifecycle,
    #[serde(default)] pub completion_satisfied: bool, pub phase: Option<String>,
    #[serde(default)] pub dependencies_all_completed: bool, #[serde(default)] pub child_count: u32,
    #[serde(default)] pub children_completed: u32, #[serde(default)] pub children_terminal_noncompleted: u32,
    pub delivery: Option<Delivery>, #[serde(default)] pub attempts: Vec<Attempt>,
    #[serde(default)] pub unresolved_blocker: bool, #[serde(default)] pub action_history: Vec<PriorAction>,
    #[serde(default)] pub budget_usage: BudgetUsage, pub max_attempts: Option<u32>,
    pub retry_due_at_ms: Option<i64>, pub merge_wait_due_at_ms: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposedAction { pub kind: ActionKind, pub task_id: String, pub attempt_id: Option<String>, pub cause_fingerprint: String, pub idempotency_key: String, pub class: ActionClass, pub payload: Value }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Decision { pub rule_id: String, pub desired_actions: Vec<ProposedAction>, pub attention: Vec<String> }

fn digest(s: &str) -> String { format!("{:x}", Sha256::digest(s.as_bytes())) }
fn make_action(task: &str, attempt: Option<&str>, kind: ActionKind, cause: String, payload: Value) -> ProposedAction {
    let key_material = if kind == ActionKind::CreateAttempt { format!("{task}:implementation:{}", payload["ordinal"].as_u64().unwrap_or_default()) } else { format!("{task}:{}:{kind:?}:{cause}", attempt.unwrap_or("-").to_owned()) };
    ProposedAction { kind, task_id: task.to_owned(), attempt_id: attempt.map(str::to_owned), cause_fingerprint: cause, idempotency_key: digest(&key_material), class: ActionClass::Observable, payload }
}
fn has_action(s: &TaskSnapshot, kind: ActionKind, attempt: Option<&str>, cause: &str) -> bool {
    s.action_history.iter().any(|a| a.action_kind == kind && a.attempt_id.as_deref() == attempt && a.cause_fingerprint == cause && matches!(a.state, ActionState::Succeeded | ActionState::UnknownOutcome | ActionState::Executing))
}

/// Reduce a frozen snapshot and explicit logical time into a stable decision.
pub fn reconcile(s: &TaskSnapshot, now: LogicalTime) -> Decision {
    let mut d = Decision { rule_id: String::new(), desired_actions: Vec::new(), attention: Vec::new() };
    if s.lifecycle == Lifecycle::Terminal { d.rule_id = "already_terminal"; return d; }
    if s.completion_satisfied || (s.child_count > 0 && s.children_completed == s.child_count && s.children_terminal_noncompleted == 0) { d.rule_id = "completion_satisfied"; return d; }
    if s.controller_mode != ControllerMode::Reconciler { d.rule_id = "controller_not_authorized"; return d; }
    if s.operator_hold { d.rule_id = "operator_hold"; d.attention.push("operator_hold".into()); return d; }
    if s.unresolved_blocker { d.rule_id = "unresolved_blocker"; d.attention.push("unresolved_blocker".into()); return d; }
    let delivery = s.delivery.as_ref();
    if delivery.is_some_and(|x| x.pr_state.as_deref() == Some("closed") && !x.pr_merged) { d.rule_id = "closed_unmerged"; d.attention.push("closed_unmerged".into()); return d; }
    if s.max_attempts.is_some_and(|max| s.budget_usage.attempts >= max) { d.rule_id = "budget_exhausted"; d.attention.push("needs_budget".into()); return d; }
    if s.retry_due_at_ms.is_some_and(|due| now.0 < due) { d.rule_id = "retry_backoff"; return d; }
    if delivery.is_some_and(|x| x.work_branch.is_none()) { d.rule_id = "branch_missing"; d.attention.push("branch_deleted".into()); return d; }
    if let Some(a) = s.attempts.iter().find(|a| a.lifecycle == AttemptLifecycle::Running || a.turn_state.as_deref() == Some("submitted")) { d.rule_id = "active_turn"; return d; }
    if let Some(x) = delivery {
        let sha = x.evaluation_sha.as_deref().unwrap_or("");
        let failing: Vec<_> = x.required_checks.iter().filter(|c| c.evaluation_sha == sha && c.state == CheckState::Failing).map(|c| c.context.clone()).collect();
        if !failing.is_empty() {
            let cause = digest(&format!("{}:{}", x.pr_head_sha.as_deref().unwrap_or(""), failing.join(",")));
            let running = s.attempts.iter().find(|a| a.lifecycle == AttemptLifecycle::Running || a.lifecycle == AttemptLifecycle::Ended && a.session_id.is_some());
            if let Some(a) = running {
                if has_action(s, ActionKind::ChecksFailed, Some(&a.attempt_id), &cause) { d.rule_id = "no_progress"; d.attention.push("no_progress".into()); }
                else { d.rule_id = "required_checks_failing"; d.desired_actions.push(make_action(&s.task_id, Some(&a.attempt_id), ActionKind::ChecksFailed, cause, json!({"checks": failing, "head_sha": x.pr_head_sha, "evaluation_sha": sha}))); }
                return d;
            }
        }
        if x.pr_merged { d.rule_id = "delivery_observed"; return d; }
        if x.required_checks.iter().any(|c| c.evaluation_sha == sha && c.state == CheckState::Unknown || c.evaluation_sha == sha && c.state == CheckState::Pending) { d.rule_id = "required_checks_pending"; return d; }
        if s.merge_wait_due_at_ms.is_some_and(|due| now.0 >= due) { d.rule_id = "waiting_for_merge_too_long"; d.attention.push("waiting_for_merge_too_long".into()); return d; }
    }
    if !s.dependencies_all_completed { d.rule_id = "dependencies_incomplete"; if s.phase.as_deref() == Some("blocked") { d.attention.push("terminal_predecessor_blocks_dependency".into()); } return d; }
    if s.attempts.iter().any(|a| matches!(a.lifecycle, AttemptLifecycle::Queued | AttemptLifecycle::Provisioning)) { d.rule_id = "attempt_starting"; return d; }
    d.rule_id = "task_runnable";
    let ordinal = s.budget_usage.attempts + 1;
    d.desired_actions.push(make_action(&s.task_id, None, ActionKind::CreateAttempt, format!("implementation:{ordinal}"), json!({"role":"implementation","ordinal":ordinal})));
    d
}

/// Canonical JSON for a snapshot, excluding polling time and collection churn.
pub fn canonical_snapshot(snapshot: &Value) -> Value {
    fn clean(v: &Value) -> Value { match v { Value::Object(m) => Value::Object(m.iter().filter(|(k,_)| !matches!(k.as_str(), "logical_time_ms"|"recorded_at"|"collection_sequence"|"poll_timestamp"|"decision_audit")).map(|(k,v)|(k.clone(),clean(v))).collect(), Value::Array(a) => Value::Array(a.iter().map(clean).collect()), _ => v.clone() } }
    clean(snapshot)
}
pub fn snapshot_hash(snapshot: &Value) -> String { digest(&serde_json::to_string(&canonical_snapshot(snapshot)).expect("JSON value serializes")) }
pub fn actions_hash(actions: &[ProposedAction]) -> String { digest(&serde_json::to_string(actions).expect("actions serialize")) }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecisionRecord { pub schema_version: u32, pub reconciler_version: String, pub task_version: u64, pub logical_time_ms: i64, pub snapshot_hash: String, pub actions_hash: String, pub rule_id: String, pub canonical_snapshot_json: Value, pub canonical_actions_json: Value }
impl DecisionRecord { pub fn new(s: &TaskSnapshot, now: LogicalTime, source: &Value, d: &Decision) -> Self { let snapshot = canonical_snapshot(source); let actions = serde_json::to_value(&d.desired_actions).expect("actions serialize"); Self { schema_version: 1, reconciler_version: RECONCILER_VERSION.into(), task_version: s.task_version, logical_time_ms: now.0, snapshot_hash: snapshot_hash(source), actions_hash: actions_hash(&d.desired_actions), rule_id: d.rule_id.clone(), canonical_snapshot_json: snapshot, canonical_actions_json: actions } } }

/// Minimal transaction contract for an isolated durable-outbox implementation.
pub mod outbox {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};
    #[derive(Clone, Debug, PartialEq, Eq)] pub struct ActionRecord { pub action: ProposedAction, pub generation: u64, pub state: ActionState }
    #[derive(Clone, Debug, PartialEq, Eq)] pub enum CommitResult { Applied { generation: u64, inserted: usize }, Unchanged { generation: u64 }, Conflict { actual_generation: u64 } }
    #[derive(Default)] pub struct MemoryDecisionStore { generation: u64, keys: BTreeSet<String>, actions: BTreeMap<String, ActionRecord>, decisions: Vec<DecisionRecord> }
    impl MemoryDecisionStore {
        /// Compare desired keys and generation atomically. No-op wakes preserve executing rows and audit count.
        pub fn commit(&mut self, expected_generation:u64, decision:DecisionRecord, desired:&[ProposedAction]) -> CommitResult {
            if expected_generation != self.generation { return CommitResult::Conflict { actual_generation:self.generation }; }
            let next:BTreeSet<_>=desired.iter().map(|a|a.idempotency_key.clone()).collect();
            if next == self.keys { return CommitResult::Unchanged { generation:self.generation }; }
            let generation=self.generation+1;
            for (key,row) in self.actions.iter_mut() { if !next.contains(key) && row.state == ActionState::Pending { row.state=ActionState::Superseded; } }
            let mut inserted=0;
            for action in desired { if !self.actions.contains_key(&action.idempotency_key) { self.actions.insert(action.idempotency_key.clone(), ActionRecord{action:action.clone(),generation,state:ActionState::Pending}); inserted+=1; } }
            self.keys=next; self.generation=generation; self.decisions.push(decision); CommitResult::Applied{generation,inserted}
        }
        pub fn claim(&mut self,key:&str,generation:u64,authorized:bool,controller:ControllerMode,held:bool)->bool {
            if generation!=self.generation || !authorized || controller!=ControllerMode::Reconciler || held || !self.keys.contains(key) { return false; }
            if let Some(row)=self.actions.get_mut(key) { if row.state==ActionState::Pending { row.state=ActionState::Executing; return true; } } false
        }
        pub fn mark_unknown_outcome(&mut self,key:&str) { if let Some(row)=self.actions.get_mut(key) { if row.state==ActionState::Executing { row.state=ActionState::UnknownOutcome; } } }
        /// Uncertain effects are observed and classified, never automatically replayed.
        pub fn recover_unknown(&mut self,key:&str,observed_applied:Option<bool>) { if let Some(row)=self.actions.get_mut(key) { if row.state==ActionState::UnknownOutcome { row.state=match observed_applied {Some(true)=>ActionState::Succeeded,Some(false)=>ActionState::Failed,None=>ActionState::UnknownOutcome}; } } }
        pub fn generation(&self)->u64 { self.generation }
        pub fn decision_count(&self)->usize { self.decisions.len() }
        pub fn action(&self,key:&str)->Option<&ActionRecord> { self.actions.get(key) }
    }
}

/// GitHub check normalization keeps policy separate from provider records and binds each result to its exact evaluation SHA.
pub mod github {
    use super::*;
    #[derive(Clone,Debug,PartialEq,Eq)] pub struct RequiredContext { pub context:String, pub source:String }
    #[derive(Clone,Debug,PartialEq,Eq)] pub struct CheckRun { pub name:String, pub sha:String, pub conclusion:Option<String>, pub status:String }
    #[derive(Clone,Debug,PartialEq,Eq)] pub struct CommitStatus { pub context:String, pub sha:String, pub state:String }
    #[derive(Clone,Debug,PartialEq,Eq)] pub enum Policy { Known(Vec<RequiredContext>), Unavailable }
    #[derive(Clone,Debug,PartialEq,Eq)] pub struct Evaluation { pub pr_head_sha:String, pub evaluation_sha:String, pub evaluation_kind:EvaluationKind, pub checks:Vec<RequiredCheck>, pub policy_known:bool }
    pub fn evaluate(policy:Policy, head:&str, evaluation:&str, kind:EvaluationKind, runs:&[CheckRun], statuses:&[CommitStatus])->Evaluation {
        let contexts=match &policy { Policy::Known(c)=>c.clone(),Policy::Unavailable=>vec![] };
        let checks=contexts.into_iter().map(|required| {
            let mut states=Vec::new();
            if required.source=="check_run" { for run in runs.iter().filter(|r|r.name==required.context && r.sha==evaluation) { states.push(match (run.status.as_str(),run.conclusion.as_deref()) { ("completed",Some("success"|"neutral"|"skipped"))=>CheckState::Passing,("completed",Some(_))=>CheckState::Failing,("completed",None)=>CheckState::Unknown,_=>CheckState::Pending }); } }
            if required.source=="status" { for st in statuses.iter().filter(|s|s.context==required.context && s.sha==evaluation) { states.push(match st.state.as_str() { "success"=>CheckState::Passing,"failure"|"error"=>CheckState::Failing,"pending"=>CheckState::Pending,_=>CheckState::Unknown }); } }
            let state=if states.is_empty(){CheckState::Pending}else if states.iter().any(|s|*s==CheckState::Failing){CheckState::Failing}else if states.iter().all(|s|*s==CheckState::Passing){CheckState::Passing}else if states.iter().any(|s|*s==CheckState::Pending){CheckState::Pending}else{CheckState::Unknown};
            RequiredCheck{context:required.context,source:required.source,state,evaluation_sha:evaluation.into()}
        }).collect();
        Evaluation{pr_head_sha:head.into(),evaluation_sha:evaluation.into(),evaluation_kind:kind,checks,policy_known:matches!(policy,Policy::Known(_))}
    }
    #[cfg(test)] mod tests { use super::*; #[test] fn binds_checks_to_evaluation_sha_and_maps_statuses(){let p=Policy::Known(vec![RequiredContext{context:"ci".into(),source:"check_run".into()},RequiredContext{context:"legacy".into(),source:"status".into()}]);let runs=[CheckRun{name:"ci".into(),sha:"head".into(),conclusion:Some("failure".into()),status:"completed".into()},CheckRun{name:"ci".into(),sha:"merge".into(),conclusion:Some("neutral".into()),status:"completed".into()}];let sts=[CommitStatus{context:"legacy".into(),sha:"merge".into(),state:"success".into()}];let e=evaluate(p,"head","merge",EvaluationKind::TestMerge,&runs,&sts);assert_eq!(e.pr_head_sha,"head");assert_eq!(e.checks[0].state,CheckState::Passing);assert_eq!(e.checks[1].state,CheckState::Passing);} #[test] fn unknown_policy_never_claims_green(){let e=evaluate(Policy::Unavailable,"h","h",EvaluationKind::Head,&[],&[]);assert!(!e.policy_known);assert!(e.checks.is_empty());} }
}

#[cfg(test)] mod tests {
 use super::*;
 fn snap() -> TaskSnapshot { TaskSnapshot { schema_version:1, task_id:"task_demo".into(), task_version:8, reconcile_generation:2, controller_mode:ControllerMode::Reconciler, operator_hold:false, lifecycle:Lifecycle::Open, completion_satisfied:false, phase:Some("runnable".into()), dependencies_all_completed:true, child_count:0, children_completed:0, children_terminal_noncompleted:0, delivery:None, attempts:vec![], unresolved_blocker:false, action_history:vec![], budget_usage:BudgetUsage::default(), max_attempts:Some(4), retry_due_at_ms:None, merge_wait_due_at_ms:None } }
 #[test] fn create_attempt_key_uses_ordinal_not_task_version() { let a=reconcile(&snap(),LogicalTime(0)); let mut s=snap(); s.task_version+=10; assert_eq!(a,reconcile(&s,LogicalTime(99))); }
 #[test] fn completion_precedes_hold_and_stale_red_checks() { let mut s=snap(); s.operator_hold=true; s.completion_satisfied=true; s.delivery=Some(Delivery{work_branch:Some("b".into()),base_revision:None,pr_head_sha:Some("head".into()),evaluation_sha:Some("old".into()),evaluation_kind:Some(EvaluationKind::Head),pr_state:Some("open".into()),pr_merged:true,required_checks:vec![RequiredCheck{context:"ci".into(),source:"check_run".into(),state:CheckState::Failing,evaluation_sha:"old".into()}]}); assert_eq!(reconcile(&s,LogicalTime(0)).rule_id,"completion_satisfied"); }
 #[test] fn operator_hold_and_blocker_suppress_attempt() { let mut s=snap(); s.operator_hold=true; assert!(reconcile(&s,LogicalTime(0)).desired_actions.is_empty()); s.operator_hold=false; s.unresolved_blocker=true; assert!(reconcile(&s,LogicalTime(0)).desired_actions.is_empty()); }
 #[test] fn retry_deadline_uses_logical_time() { let mut s=snap(); s.retry_due_at_ms=Some(10); assert_eq!(reconcile(&s,LogicalTime(9)).rule_id,"retry_backoff"); assert_eq!(reconcile(&s,LogicalTime(10)).rule_id,"task_runnable"); }
 #[test] fn canonical_hash_ignores_poll_churn() { let a=json!({"logical_time_ms":1,"delivery":{"collection_sequence":2,"sha":"a"}}); let b=json!({"logical_time_ms":8,"delivery":{"collection_sequence":99,"sha":"a"}}); assert_eq!(snapshot_hash(&a),snapshot_hash(&b)); }
}
