//! Deterministic, in-process provider world used by adapter and reducer tests.
use anvil_reconcile::github::{
    CheckRun, CommitStatus, GitHubReadPort, Policy, ProviderError, PullRequestFacts,
    RequiredContext,
};
use anvil_reconcile::EvaluationKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderFailure {
    Unavailable,
    RateLimited,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullRequest {
    pub repository: String,
    pub work_branch: String,
    pub number: u64,
    pub head_sha: String,
    pub evaluation_sha: String,
    pub merged: bool,
    pub open: bool,
    pub evaluation_kind: EvaluationKind,
}
#[derive(Clone, Debug, Default)]
pub struct TestWorld {
    pub branches: Vec<(String, String)>,
    pub pull_requests: Vec<PullRequest>,
    pub check_runs: Vec<CheckRun>,
    pub statuses: Vec<CommitStatus>,
    pub failure: Option<ProviderFailure>,
    pub required_contexts: Option<Vec<RequiredContext>>,
    pub collection_sequence: u64,
}
impl GitHubReadPort for TestWorld {
    fn branch_exists(&self, repository: &str, branch: &str) -> Result<bool, ProviderError> {
        if let Some(failure) = &self.failure {
            return Err(map_failure(failure));
        }
        Ok(self
            .branches
            .iter()
            .any(|(repo, name)| repo == repository && name == branch))
    }
    fn pull_request(
        &self,
        repository: &str,
        branch: &str,
        bound_number: Option<u64>,
    ) -> Result<Option<PullRequestFacts>, ProviderError> {
        if let Some(failure) = &self.failure {
            return Err(map_failure(failure));
        }
        Ok(self
            .pull_requests
            .iter()
            .find(|pr| {
                pr.repository == repository
                    && (bound_number == Some(pr.number)
                        || bound_number.is_none() && pr.work_branch == branch)
            })
            .map(|pr| PullRequestFacts {
                number: pr.number,
                head_sha: pr.head_sha.clone(),
                evaluation_sha: pr.evaluation_sha.clone(),
                evaluation_kind: pr.evaluation_kind.clone(),
                state: if pr.open { "open" } else { "closed" }.into(),
                merged: pr.merged,
            }))
    }
    fn required_policy(&self, _: &str, _: &str) -> Result<Policy, ProviderError> {
        if let Some(failure) = &self.failure {
            return Err(map_failure(failure));
        }
        Ok(self
            .required_contexts
            .clone()
            .map(Policy::Known)
            .unwrap_or(Policy::Unavailable))
    }
    fn check_runs(&self, _: &str, _: &str) -> Result<Vec<CheckRun>, ProviderError> {
        if let Some(failure) = &self.failure {
            Err(map_failure(failure))
        } else {
            Ok(self.check_runs.clone())
        }
    }
    fn commit_statuses(&self, _: &str, _: &str) -> Result<Vec<CommitStatus>, ProviderError> {
        if let Some(failure) = &self.failure {
            Err(map_failure(failure))
        } else {
            Ok(self.statuses.clone())
        }
    }
}
fn map_failure(failure: &ProviderFailure) -> ProviderError {
    match failure {
        ProviderFailure::Unavailable => ProviderError::Unavailable,
        ProviderFailure::RateLimited => ProviderError::RateLimited,
    }
}
impl TestWorld {
    pub fn observe(
        &mut self,
        number: u64,
    ) -> Result<(PullRequest, Vec<CheckRun>, Vec<CommitStatus>, u64), ProviderFailure> {
        if let Some(e) = self.failure.clone() {
            return Err(e);
        }
        let pr = self
            .pull_requests
            .iter()
            .find(|p| p.number == number)
            .cloned()
            .expect("fixture PR exists");
        self.collection_sequence += 1;
        Ok((
            pr,
            self.check_runs.clone(),
            self.statuses.clone(),
            self.collection_sequence,
        ))
    }
    pub fn set_failure(&mut self, failure: Option<ProviderFailure>) {
        self.failure = failure;
    }
    pub fn advance_head(&mut self, number: u64, head: &str, evaluation: &str) {
        if let Some(pr) = self.pull_requests.iter_mut().find(|p| p.number == number) {
            pr.head_sha = head.into();
            pr.evaluation_sha = evaluation.into();
        }
    }
    pub fn set_merged(&mut self, number: u64) {
        if let Some(pr) = self.pull_requests.iter_mut().find(|p| p.number == number) {
            pr.merged = true;
            pr.open = false;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use anvil_reconcile::github::{GitHubCodeHost, ObservationRequest};
    use anvil_reconcile::{
        reconcile, ActionKind, ActionState, Attempt, AttemptLifecycle, BudgetUsage,
        CompletionEvidence, CompletionPolicy, ControllerMode, Delivery, LogicalTime,
        ObservationProvenance, PriorAction, TaskSnapshot,
    };
    #[test]
    fn explicit_advances_are_deterministic_and_failures_preserve_facts() {
        let mut w = TestWorld {
            pull_requests: vec![PullRequest {
                repository: "org/repo".into(),
                work_branch: "anvil/task_7".into(),
                number: 7,
                head_sha: "h1".into(),
                evaluation_sha: "m1".into(),
                merged: false,
                open: true,
                evaluation_kind: EvaluationKind::Head,
            }],
            branches: vec![("org/repo".into(), "anvil/task_7".into())],
            ..Default::default()
        };
        assert_eq!(w.observe(7).unwrap().3, 1);
        w.advance_head(7, "h2", "m2");
        assert_eq!(w.observe(7).unwrap().0.head_sha, "h2");
        w.set_failure(Some(ProviderFailure::Unavailable));
        assert_eq!(w.observe(7), Err(ProviderFailure::Unavailable));
        assert_eq!(w.pull_requests[0].head_sha, "h2");
    }

    #[test]
    fn fake_provider_ci_repair_and_merge_drive_reducer_until_trusted_completion() {
        let mut world = TestWorld {
            branches: vec![("org/repo".into(), "anvil/task_factory".into())],
            pull_requests: vec![PullRequest {
                repository: "org/repo".into(),
                work_branch: "anvil/task_factory".into(),
                number: 42,
                head_sha: "head-1".into(),
                evaluation_sha: "head-1".into(),
                merged: false,
                open: true,
                evaluation_kind: EvaluationKind::Head,
            }],
            required_contexts: Some(vec![RequiredContext {
                context: "CI".into(),
                source: "check_run".into(),
            }]),
            check_runs: vec![CheckRun {
                run_id:1,
                name: "CI".into(),
                sha: "head-1".into(),
                conclusion: Some("failure".into()),
                status: "completed".into(),
                updated_at:None,
                details_fingerprint: Some("lint:E1".into()),
            }],
            ..Default::default()
        };
        let request = ObservationRequest {
            repository: "org/repo".into(),
            base_ref: "main".into(),
            work_branch: "anvil/task_factory".into(),
            bound_pr_number: None,
        };
        let observe = |world: &TestWorld| {
            GitHubCodeHost::new(world.clone())
                .observe(&request)
                .unwrap()
        };
        let failed = observe(&world);
        assert_eq!(failed.pull_request.as_ref().unwrap().number, 42); // discovery by exact Task branch
        assert_eq!(
            failed.required_checks[0].state,
            anvil_reconcile::CheckState::Failing
        );

        let mut snapshot = TaskSnapshot {
            schema_version: 1,
            task_id: "task_factory".into(),
            task_version: 1,
            reconcile_generation: 0,
            controller_mode: ControllerMode::Reconciler,
            operator_hold: false,
            lifecycle: anvil_reconcile::Lifecycle::Open,
            completion_policy: Some(CompletionPolicy::Evidence {
                required_kinds: vec!["delivery_complete".into()],
            }),
            completion_evidence: vec![],
            phase: Some("running".into()),
            dependencies_all_completed: true,
            child_count: 0,
            children_completed: 0,
            children_terminal_noncompleted: 0,
            delivery: Some(from_observation(&failed)),
            attempts: vec![Attempt {
                attempt_id: "attempt_1".into(),
                ordinal: 1,
                role: "implementation".into(),
                lifecycle: AttemptLifecycle::Ended,
                turn_state: Some("completed".into()),
                session_id: Some("session_1".into()),
                session_healthy: true,
            }],
            unresolved_blocker: false,
            runtime_health: None,
            runtime_failure_fingerprint: None,
            max_runtime_recoveries: Some(2),
            action_history: vec![],
            budget_usage: BudgetUsage {
                attempts: 1,
                ..Default::default()
            },
            max_attempts: Some(4),
            max_continuations_by_reason: Default::default(),
            max_ci_retries: Some(2),
            max_execution_ms: Some(300_000),
            retry_due_at_ms: None,
            merge_wait_due_at_ms: Some(1_000),
        };
        let repair = reconcile(&snapshot, LogicalTime(0));
        assert_eq!(repair.rule_id, "required_checks_failing");
        assert_eq!(repair.desired_actions[0].kind, ActionKind::ChecksFailed);
        assert_eq!(
            repair.desired_actions[0].attempt_id.as_deref(),
            Some("attempt_1")
        );
        snapshot.action_history.push(PriorAction {
            action_kind: ActionKind::ChecksFailed,
            attempt_id: repair.desired_actions[0].attempt_id.clone(),
            cause_fingerprint: repair.desired_actions[0].cause_fingerprint.clone(),
            idempotency_key: repair.desired_actions[0].idempotency_key.clone(),
            state: ActionState::Succeeded,
        });
        assert_eq!(reconcile(&snapshot, LogicalTime(1)).rule_id, "no_progress");

        world.advance_head(42, "head-2", "head-2");
        world.check_runs = vec![CheckRun {
            run_id:2,
            name: "CI".into(),
            sha: "head-2".into(),
            conclusion: Some("success".into()),
            status: "completed".into(),
            updated_at:None,
            details_fingerprint: None,
        }];
        let green = observe(&world);
        snapshot.delivery = Some(from_observation(&green));
        snapshot.action_history.clear();
        assert_eq!(
            reconcile(&snapshot, LogicalTime(2)).rule_id,
            "waiting_for_merge"
        );

        world.set_merged(42);
        let merged = observe(&world);
        assert!(merged.pull_request.as_ref().unwrap().merged);
        snapshot.delivery = Some(from_observation(&merged));
        snapshot.completion_evidence.push(CompletionEvidence {
            kind: "delivery_complete".into(),
            provenance: ObservationProvenance::External,
            fresh: true,
            trusted: true,
            subject_sha: merged.pull_request.as_ref().map(|pr| pr.head_sha.clone()),
        });
        assert_eq!(
            reconcile(&snapshot, LogicalTime(3)).rule_id,
            "completion_satisfied"
        );
        // The fixture proves observer/reducer portions only: no canonical Task terminal transition or runtime GC is asserted.
    }

    fn from_observation(observation: &anvil_reconcile::github::DeliveryObservation) -> Delivery {
        observation.into_reducer_delivery(Some("base".into()))
    }
}
