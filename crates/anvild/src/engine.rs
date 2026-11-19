use std::time::Duration;

use anvil_api::{AttentionKind, Commission, CommissionState, EventKind, NewAttention, NewEvent};
use serde_json::json;
use serde_json::Value;
use time::OffsetDateTime;
use tokio::sync::watch;

use crate::store::{Store, StoreError};

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
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            tick_interval: Duration::from_secs(10),
            heartbeat_timeout: Duration::from_secs(30 * 60),
            turn_timeout: Duration::from_secs(2 * 60 * 60),
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
}

impl Engine {
    pub fn new(store: Store, config: EngineConfig) -> Self {
        Self { store, config }
    }

    pub async fn tick(&self) -> Result<TickReport, EngineError> {
        let mut report = TickReport::default();
        self.admit_waves(&mut report).await?;
        self.escalate_stalled_attempts(&mut report).await?;
        self.escalate_stalled_turns(&mut report).await?;
        self.escalate_exhausted_commissions(&mut report).await?;
        Ok(report)
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
                let to = apply(&commission.state, Transition::Admit)?;
                let event = state_changed(commission, &to, Value::Null);
                self.store
                    .transition_commission(commission.id, to, &[event], None)
                    .await?;
                report.admitted += 1;
            }
        }
        Ok(())
    }

    async fn escalate_stalled_attempts(&self, report: &mut TickReport) -> Result<(), EngineError> {
        for commission in self
            .store
            .commissions_in_state(&CommissionState::Active)
            .await?
        {
            let attempts = self.store.attempts(commission.id).await?;
            let stalled = attempts.iter().any(|a| {
                a.ended_at.is_none() && is_stale(a.heartbeat_at, self.config.heartbeat_timeout)
            });
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
            let mut stalled = false;
            for attempt in attempts.iter().filter(|a| a.ended_at.is_none()) {
                let turns = self.store.turns(attempt.id).await?;
                if turns.iter().any(|t| {
                    t.ended_at.is_none() && is_stale(t.started_at, self.config.turn_timeout)
                }) {
                    stalled = true;
                    break;
                }
            }
            if stalled {
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
}

pub async fn run(
    store: Store,
    config: EngineConfig,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), EngineError> {
    let engine = Engine::new(store, config);
    let mut interval = tokio::time::interval(engine.config.tick_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                engine.tick().await?;
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return Ok(());
                }
            }
        }
    }
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
