use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anvil_api::{
    Attempt, AttentionKind, Campaign, Commission, CommissionState, EventKind, ExternalState,
    NewAttention, NewEvent, TurnContext, Verdict,
};
use serde_json::json;
use serde_json::Value;
use time::OffsetDateTime;
use tokio::sync::watch;

use crate::github::{pr_body, GithubClient, GithubError};
use crate::harness::{materialize_provider_config, Harness};
use crate::sandbox::{SandboxProvider, SandboxSpec};
use crate::store::{Store, StoreError};
use crate::strategy::{self, SessionContinuity};

#[derive(Debug, thiserror::Error)]
#[error("illegal transition {transition:?} from {from}")]
pub struct IllegalTransition {
    pub from: CommissionState,
    pub transition: Transition,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Transition {
    Admit,
    Pause,
    Resume,
    Converge,
    Reopen,
    Merge,
    Retry,
    Escalate { reason: String },
    Fail { cause: String },
    Cancel,
}

pub fn apply(
    state: &CommissionState,
    transition: Transition,
) -> Result<CommissionState, IllegalTransition> {
    use CommissionState as S;
    use Transition as T;
    let to = match (state, transition) {
        (S::Pending, T::Admit) => S::Active,
        (S::Pending, T::Fail { cause }) => S::Failed { cause },
        (S::Pending, T::Cancel) => S::Cancelled,
        (S::Active, T::Converge) => S::NeedsReview,
        (S::Active, T::Pause) => S::Interactive,
        (S::Active, T::Escalate { reason }) => S::Escalated { reason },
        (S::Active, T::Fail { cause }) => S::Failed { cause },
        (S::Active, T::Cancel) => S::Cancelled,
        (S::Interactive, T::Resume) => S::Active,
        (S::Interactive, T::Cancel) => S::Cancelled,
        (S::NeedsReview, T::Reopen) => S::Active,
        (S::NeedsReview, T::Merge) => S::Merged,
        (S::NeedsReview, T::Escalate { reason }) => S::Escalated { reason },
        (S::NeedsReview, T::Cancel) => S::Cancelled,
        (S::Escalated { .. }, T::Retry) => S::Active,
        (S::Escalated { .. }, T::Cancel) => S::Cancelled,
        (S::Failed { .. }, T::Retry) => S::Active,
        (S::Failed { .. }, T::Cancel) => S::Cancelled,
        (S::Merged, t) | (S::Cancelled, t) => {
            return Err(IllegalTransition {
                from: state.clone(),
                transition: t,
            })
        }
        (from, t) => {
            return Err(IllegalTransition {
                from: from.clone(),
                transition: t,
            })
        }
    };
    Ok(to)
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub tick_interval: Duration,
    pub heartbeat_timeout: Duration,
    pub turn_timeout: Duration,
    pub state_dir: PathBuf,
    pub daemon_url: String,
    pub sandbox_image: String,
}

impl Default for EngineConfig {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_owned());
        Self {
            tick_interval: Duration::from_secs(10),
            heartbeat_timeout: Duration::from_secs(30 * 60),
            turn_timeout: Duration::from_secs(2 * 60 * 60),
            state_dir: PathBuf::from(format!("{home}/.local/state/anvil")),
            daemon_url: "http://127.0.0.1:8788".to_owned(),
            sandbox_image: "anvil-sandbox:latest".to_owned(),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct TickReport {
    pub admitted: usize,
    pub escalated: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Illegal(#[from] IllegalTransition),
}

pub struct Engine {
    store: Store,
    config: EngineConfig,
    github: Option<GithubClient>,
    sandbox: Option<Arc<SandboxProvider>>,
    harness: Option<Arc<Harness>>,
}

impl Engine {
    pub fn new(store: Store, config: EngineConfig) -> Self {
        Self {
            store,
            config,
            github: None,
            sandbox: None,
            harness: None,
        }
    }

    pub fn with_github(mut self, github: GithubClient) -> Self {
        self.github = Some(github);
        self
    }

    pub fn with_sandbox(mut self, sandbox: Arc<SandboxProvider>) -> Self {
        self.sandbox = Some(sandbox);
        self
    }

    pub fn with_harness(mut self, harness: Arc<Harness>) -> Self {
        self.harness = Some(harness);
        self
    }

    pub async fn tick(&self) -> Result<TickReport, EngineError> {
        let mut report = TickReport::default();
        self.admit_waves(&mut report).await?;
        self.escalate_stalled_attempts(&mut report).await?;
        self.escalate_stalled_turns(&mut report).await?;
        self.escalate_exhausted_commissions(&mut report).await?;
        self.drive_active_commissions().await?;
        Ok(report)
    }

    async fn drive_active_commissions(&self) -> Result<(), EngineError> {
        if self.harness.is_none() || self.sandbox.is_none() {
            return Ok(());
        }
        for commission in self
            .store
            .commissions_in_state(&CommissionState::Active)
            .await?
        {
            let Some(campaign) = self.store.campaign(commission.campaign_id).await? else {
                continue;
            };
            let attempts = self.store.attempts(commission.id).await?;
            let running = attempts.iter().rev().find(|a| a.ended_at.is_none());
            match running {
                None => {
                    if attempts
                        .last()
                        .and_then(|a| a.outcome.as_ref())
                        .and_then(|o| o.get("error"))
                        .is_some()
                    {
                        self.fail_commission(
                            &commission,
                            "environment failure on the last attempt",
                            AttentionKind::EnvFailure,
                        )
                        .await?;
                    } else {
                        self.start_attempt(&campaign, &commission).await?;
                    }
                }
                Some(attempt) => {
                    let turns = self.store.turns(attempt.id).await?;
                    let in_flight = turns.last().is_some_and(|t| t.ended_at.is_none());
                    if in_flight || turns.is_empty() {
                        continue;
                    }
                    if attempt.done_claimed_at.is_some() {
                        self.evaluate_claim(&campaign, &commission, attempt).await?;
                    } else {
                        let gaps = vec!["the previous turn ended without claiming done".to_owned()];
                        self.spawn_turn(&campaign, &commission, attempt, gaps)
                            .await?;
                    }
                }
            }
        }
        Ok(())
    }

    async fn start_attempt(
        &self,
        campaign: &Campaign,
        commission: &Commission,
    ) -> Result<(), EngineError> {
        let strategy_value = strategy::resolve(&campaign.strategy, &commission.strategy);
        if let Err(error) = strategy::parse(&strategy_value) {
            self.fail_commission(
                commission,
                &format!("invalid strategy config: {error}"),
                AttentionKind::EnvFailure,
            )
            .await?;
            return Ok(());
        }
        let attempt_id = self
            .store
            .insert_attempt(commission.id, &strategy_value)
            .await?;
        let attempt = Attempt {
            id: attempt_id,
            commission_id: commission.id,
            n: 1,
            strategy: strategy_value.clone(),
            started_at: OffsetDateTime::now_utc(),
            ended_at: None,
            done_claimed_at: None,
            heartbeat_at: OffsetDateTime::now_utc(),
            tokens: None,
            outcome: None,
        };
        self.spawn_turn(campaign, commission, &attempt, Vec::new())
            .await
    }

    async fn evaluate_claim(
        &self,
        campaign: &Campaign,
        commission: &Commission,
        attempt: &Attempt,
    ) -> Result<(), EngineError> {
        let Some(external) = self.external_state(commission).await else {
            return Ok(());
        };
        let strategy_value = strategy::resolve(&campaign.strategy, &commission.strategy);
        let Ok(parsed) = strategy::parse(&strategy_value) else {
            self.fail_commission(
                commission,
                "invalid strategy config",
                AttentionKind::EnvFailure,
            )
            .await?;
            return Ok(());
        };
        match parsed.evaluate(&external) {
            Verdict::Converge => {
                let turns = self.store.turns(attempt.id).await?;
                let tokens: i64 = turns.iter().filter_map(|t| t.tokens).sum();
                self.store
                    .end_attempt(attempt.id, Some(tokens), json!({"converged": true}))
                    .await?;
                let to = apply(&commission.state, Transition::Converge)?;
                let event = state_changed(commission, &to, json!({"via": "done claim"}));
                let attention = NewAttention {
                    commission_id: commission.id,
                    kind: AttentionKind::ReviewReady,
                    payload: json!({"attempt": attempt.n}),
                };
                self.store
                    .transition_commission(commission.id, to, &[event], Some(attention))
                    .await?;
            }
            Verdict::Continue { gaps } => {
                self.store.clear_done_claim(attempt.id).await?;
                self.store
                    .append_events(&[NewEvent {
                        kind: EventKind::GapDetected,
                        campaign_id: Some(campaign.id),
                        commission_id: Some(commission.id),
                        payload: json!({"gaps": gaps}),
                    }])
                    .await?;
                self.spawn_turn(campaign, commission, attempt, gaps).await?;
            }
            Verdict::Pending => {}
        }
        Ok(())
    }

    async fn spawn_turn(
        &self,
        campaign: &Campaign,
        commission: &Commission,
        attempt: &Attempt,
        gaps: Vec<String>,
    ) -> Result<(), EngineError> {
        let strategy_value = strategy::resolve(&campaign.strategy, &commission.strategy);
        let Ok(parsed) = strategy::parse(&strategy_value) else {
            self.fail_commission(
                commission,
                "invalid strategy config",
                AttentionKind::EnvFailure,
            )
            .await?;
            return Ok(());
        };

        let mut credentials = std::collections::BTreeMap::new();
        for name in strategy_value
            .get("credentials")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Ok(Some(secret)) = self.store.credential(name).await {
                credentials.insert(name.to_owned(), secret);
            }
        }
        if let Some(auth) = strategy_value.get("opencode_auth").and_then(Value::as_str) {
            let name = format!("opencode-auth:{auth}");
            if let Ok(Some(secret)) = self.store.credential(&name).await {
                credentials.insert(name, secret);
            }
        }
        let provider_config = match materialize_provider_config(&strategy_value, &credentials) {
            Ok(config) => config,
            Err(error) => {
                self.fail_commission(
                    commission,
                    &format!("provider config: {error}"),
                    AttentionKind::EnvFailure,
                )
                .await?;
                return Ok(());
            }
        };

        let mut env = provider_config.env;
        if let Some(github) = &self.github {
            let Some(pr_number) = commission.pr_number else {
                return Ok(());
            };
            let _ = pr_number;
            match github.installation_token().await {
                Ok(token) => {
                    env.insert("ANVIL_GITHUB_TOKEN".to_owned(), token);
                }
                Err(_) => return Ok(()),
            }
            env.insert(
                "ANVIL_REPO_URL".to_owned(),
                format!("https://github.com/{}.git", commission.repo),
            );
            env.insert("ANVIL_REPO_BRANCH".to_owned(), commission.branch.clone());
            env.insert("ANVIL_TARGET_REF".to_owned(), commission.target_ref.clone());
        }
        match self.store.issue_commission_token(commission.id).await {
            Ok(token) => {
                env.insert("ANVILCTL_TOKEN".to_owned(), token);
            }
            Err(error) => return Err(error.into()),
        }
        env.insert("ANVILCTL_URL".to_owned(), self.config.daemon_url.clone());
        let serve_password = match self
            .store
            .credential(&serve_password_key(commission.id))
            .await?
        {
            Some(existing) => existing,
            None => {
                let password = uuid::Uuid::new_v4().simple().to_string();
                self.store
                    .put_credential(&serve_password_key(commission.id), &password)
                    .await?;
                password
            }
        };
        env.insert(
            "OPENCODE_SERVER_PASSWORD".to_owned(),
            serve_password.clone(),
        );

        let obligations: Vec<String> = self
            .store
            .obligations(commission.id)
            .await?
            .into_iter()
            .map(|o| o.text)
            .collect();

        let Some(external) = self.external_state(commission).await else {
            return Ok(());
        };
        let context = TurnContext {
            campaign_name: campaign.name.clone(),
            campaign_context: campaign.context.clone(),
            commission_title: commission.title.clone(),
            commission_spec: commission.spec.clone(),
            repo: commission.repo.clone(),
            target_ref: commission.target_ref.clone(),
            target_sha: commission.target_sha.clone(),
            branch: commission.branch.clone(),
            wave: commission.wave,
            attempt_n: attempt.n,
            obligations,
            gaps,
            external,
        };
        let prompt = parsed.compose_turn(&context);
        let prompt_hash = strategy::prompt_hash(&prompt);

        let turns = self.store.turns(attempt.id).await?;
        let session = match parsed.session {
            SessionContinuity::Fresh => None,
            SessionContinuity::Continuous => turns
                .iter()
                .rev()
                .find_map(|t| t.result.as_ref())
                .and_then(|result| result.get("session"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        };

        let turn_id = self.store.insert_turn(attempt.id, &prompt_hash).await?;

        let spec = SandboxSpec {
            name: format!("anvil-{}-{}", campaign.slug, commission.slug),
            image: self.config.sandbox_image.clone(),
            workspace: self
                .config
                .state_dir
                .join("workspaces")
                .join(&commission.slug),
            files: provider_config.files,
            env,
        };

        let store = self.store.clone();
        let sandbox = Arc::clone(self.sandbox.as_ref().expect("checked in drive"));
        let harness = Arc::clone(self.harness.as_ref().expect("checked in drive"));
        let attempt_id = attempt.id;
        tokio::spawn(async move {
            let handle = match sandbox.handle(&spec.name).await {
                Ok(Some(handle)) => handle,
                Ok(None) => match sandbox.start(&spec).await {
                    Ok(handle) => handle,
                    Err(error) => {
                        let _ = store
                            .end_attempt(
                                attempt_id,
                                None,
                                json!({"error": format!("sandbox: {error}")}),
                            )
                            .await;
                        return;
                    }
                },
                Err(error) => {
                    let _ = store
                        .end_attempt(
                            attempt_id,
                            None,
                            json!({"error": format!("sandbox: {error}")}),
                        )
                        .await;
                    return;
                }
            };
            let receipt = harness
                .run_turn(
                    &handle.serve_url,
                    Some(&serve_password),
                    session.as_deref(),
                    &prompt,
                )
                .await;
            match receipt {
                Ok(receipt) => {
                    let _ = store
                        .end_turn(
                            turn_id,
                            receipt.tokens,
                            json!({"session": receipt.session, "status": "ok"}),
                        )
                        .await;
                    let _ = store.touch_attempt(attempt_id).await;
                }
                Err(error) => {
                    let _ = store
                        .end_turn(
                            turn_id,
                            None,
                            json!({"status": "error", "error": error.to_string()}),
                        )
                        .await;
                    let _ = store.touch_attempt(attempt_id).await;
                }
            }
        });
        Ok(())
    }

    async fn external_state(&self, commission: &Commission) -> Option<ExternalState> {
        match &self.github {
            None => Some(ExternalState {
                checks: Vec::new(),
                mergeable: true,
                head_moved: false,
            }),
            Some(github) => {
                let pr_number = commission.pr_number?;
                github
                    .external_state(
                        &commission.repo,
                        pr_number,
                        &commission.target_ref,
                        &commission.target_sha,
                    )
                    .await
                    .ok()
            }
        }
    }

    async fn fail_commission(
        &self,
        commission: &Commission,
        cause: &str,
        attention: AttentionKind,
    ) -> Result<(), EngineError> {
        let to = apply(
            &commission.state,
            Transition::Fail {
                cause: cause.to_owned(),
            },
        )?;
        let event = state_changed(commission, &to, json!({"cause": cause}));
        let attention = NewAttention {
            commission_id: commission.id,
            kind: attention,
            payload: json!({"cause": cause}),
        };
        self.store
            .transition_commission(commission.id, to, &[event], Some(attention))
            .await?;
        Ok(())
    }

    async fn admit_waves(&self, report: &mut TickReport) -> Result<(), EngineError> {
        for campaign in self.store.campaigns().await? {
            let commissions = self.store.commissions_by_campaign(campaign.id).await?;
            let Some(pending_wave) = commissions
                .iter()
                .filter(|c| c.state == CommissionState::Pending)
                .map(|c| c.wave)
                .min()
            else {
                continue;
            };
            let blocked = commissions
                .iter()
                .any(|c| c.wave < pending_wave && !is_terminal(&c.state));
            if blocked {
                continue;
            }
            for commission in commissions
                .iter()
                .filter(|c| c.state == CommissionState::Pending && c.wave == pending_wave)
            {
                self.admit_commission(&campaign, commission).await?;
                report.admitted += 1;
            }
        }
        Ok(())
    }

    async fn admit_commission(
        &self,
        campaign: &anvil_api::Campaign,
        commission: &Commission,
    ) -> Result<(), EngineError> {
        let Some(github) = &self.github else {
            let to = apply(&commission.state, Transition::Admit)?;
            let event = state_changed(commission, &to, Value::Null);
            self.store
                .transition_commission(commission.id, to, &[event], None)
                .await?;
            return Ok(());
        };
        let obligations = self.store.obligations(commission.id).await?;
        let texts: Vec<String> = obligations.iter().map(|o| o.text.clone()).collect();
        let body = pr_body(&commission.spec, &texts);
        let provisioned = github
            .provision(
                &commission.repo,
                &campaign.slug,
                &commission.slug,
                &commission.target_ref,
                &commission.title,
                &body,
            )
            .await;
        match provisioned {
            Ok(provisioned) => {
                let to = apply(&commission.state, Transition::Admit)?;
                let mut events = vec![NewEvent {
                    kind: EventKind::CommissionAdmitted,
                    campaign_id: Some(commission.campaign_id),
                    commission_id: Some(commission.id),
                    payload: json!({
                        "target_sha": provisioned.target_sha,
                        "branch": provisioned.branch,
                        "pr_number": provisioned.pr_number,
                    }),
                }];
                events.push(state_changed(commission, &to, Value::Null));
                self.store
                    .provision_and_transition(
                        commission.id,
                        to,
                        &provisioned.target_sha,
                        &provisioned.branch,
                        provisioned.pr_number,
                        &events,
                    )
                    .await?;
            }
            Err(error) => self.fail_provisioning(commission, &error).await?,
        }
        Ok(())
    }

    async fn fail_provisioning(
        &self,
        commission: &Commission,
        error: &GithubError,
    ) -> Result<(), EngineError> {
        self.fail_commission(
            commission,
            &format!("provisioning failed: {error}"),
            AttentionKind::EnvFailure,
        )
        .await
    }

    async fn escalate_stalled_attempts(&self, report: &mut TickReport) -> Result<(), EngineError> {
        for commission in self
            .store
            .commissions_in_state(&CommissionState::Active)
            .await?
        {
            let attempts = self.store.attempts(commission.id).await?;
            let mut stalled = false;
            for attempt in attempts.iter().filter(|a| a.ended_at.is_none()) {
                if is_stale(attempt.heartbeat_at, self.config.heartbeat_timeout) {
                    stalled = true;
                    self.store
                        .end_attempt(
                            attempt.id,
                            None,
                            json!({"escalated": "attempt stalled: no heartbeat within timeout"}),
                        )
                        .await?;
                }
            }
            if stalled {
                self.escalate(
                    &commission,
                    AttentionKind::AttemptStalled,
                    "attempt stalled: no heartbeat within timeout",
                    json!({"heartbeat_timeout_secs": self.config.heartbeat_timeout.as_secs()}),
                )
                .await?;
                report.escalated += 1;
            }
        }
        Ok(())
    }

    async fn escalate_stalled_turns(&self, report: &mut TickReport) -> Result<(), EngineError> {
        for commission in self
            .store
            .commissions_in_state(&CommissionState::Active)
            .await?
        {
            let attempts = self.store.attempts(commission.id).await?;
            let mut stalled = Vec::new();
            for attempt in attempts.iter().filter(|a| a.ended_at.is_none()) {
                let turns = self.store.turns(attempt.id).await?;
                if turns.iter().any(|t| {
                    t.ended_at.is_none() && is_stale(t.started_at, self.config.turn_timeout)
                }) {
                    stalled.push(attempt.id);
                }
            }
            if !stalled.is_empty() {
                for attempt_id in stalled {
                    self.store
                        .end_attempt(
                            attempt_id,
                            None,
                            json!({"escalated": "turn stalled: no turn completion within timeout"}),
                        )
                        .await?;
                }
                self.escalate(
                    &commission,
                    AttentionKind::AttemptStalled,
                    "turn stalled: no turn completion within timeout",
                    json!({"turn_timeout_secs": self.config.turn_timeout.as_secs()}),
                )
                .await?;
                report.escalated += 1;
            }
        }
        Ok(())
    }

    async fn escalate_exhausted_commissions(
        &self,
        report: &mut TickReport,
    ) -> Result<(), EngineError> {
        for commission in self
            .store
            .commissions_in_state(&CommissionState::Active)
            .await?
        {
            let Some(max_attempts) = budget_attempts(&commission.budget) else {
                continue;
            };
            let attempts = self.store.attempts(commission.id).await?;
            let spent = attempts.len() as i64;
            let running = attempts.iter().any(|a| a.ended_at.is_none());
            if spent >= max_attempts && !running {
                self.escalate(
                    &commission,
                    AttentionKind::BudgetExhausted,
                    "attempt budget exhausted",
                    json!({"attempts": spent, "max_attempts": max_attempts}),
                )
                .await?;
                report.escalated += 1;
            }
        }
        Ok(())
    }

    async fn escalate(
        &self,
        commission: &Commission,
        attention: AttentionKind,
        reason: &str,
        payload: Value,
    ) -> Result<(), EngineError> {
        let to = apply(
            &commission.state,
            Transition::Escalate {
                reason: reason.to_owned(),
            },
        )?;
        let event = state_changed(commission, &to, json!({"reason": reason}));
        let attention = NewAttention {
            commission_id: commission.id,
            kind: attention,
            payload,
        };
        self.store
            .transition_commission(commission.id, to, &[event], Some(attention))
            .await?;
        Ok(())
    }

    pub async fn run(self, mut shutdown: watch::Receiver<bool>) -> Result<(), EngineError> {
        let mut interval = tokio::time::interval(self.config.tick_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    self.tick().await?;
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        return Ok(());
                    }
                }
            }
        }
    }
}

fn serve_password_key(commission: anvil_api::CommissionId) -> String {
    format!("serve-password:{}", commission)
}

fn is_terminal(state: &CommissionState) -> bool {
    matches!(
        state,
        CommissionState::Merged
            | CommissionState::NeedsReview
            | CommissionState::Escalated { .. }
            | CommissionState::Failed { .. }
            | CommissionState::Cancelled
    )
}

fn is_stale(at: OffsetDateTime, timeout: Duration) -> bool {
    let now = OffsetDateTime::now_utc();
    now - at >= time::Duration::try_from(timeout).unwrap_or(time::Duration::MAX)
}

fn budget_attempts(budget: &Value) -> Option<i64> {
    budget
        .get("attempts")
        .and_then(Value::as_i64)
        .filter(|n| *n > 0)
}

fn state_changed(commission: &Commission, to: &CommissionState, detail: Value) -> NewEvent {
    NewEvent {
        kind: EventKind::StateChanged,
        campaign_id: Some(commission.campaign_id),
        commission_id: Some(commission.id),
        payload: json!({
            "from": commission.state.kind(),
            "to": to.kind(),
            "detail": detail,
        }),
    }
}
