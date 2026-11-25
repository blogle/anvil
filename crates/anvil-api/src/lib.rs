use std::fmt;
use std::str::FromStr;

use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

macro_rules! id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(s).map(Self)
            }
        }
    };
}

id!(CampaignId);
id!(CommissionId);
id!(ObligationId);
id!(AttemptId);
id!(TurnId);
id!(AttentionId);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckConclusion {
    Pass,
    Fail,
    Pending,
    Inconclusive,
}

impl CheckConclusion {
    pub fn classify(raw: &str) -> Self {
        match raw {
            "success" => Self::Pass,
            "failure" | "timed_out" | "action_required" => Self::Fail,
            "pending" | "queued" | "in_progress" | "" => Self::Pending,
            _ => Self::Inconclusive,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckStatus {
    pub name: String,
    pub conclusion: CheckConclusion,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExternalState {
    pub checks: Vec<CheckStatus>,
    pub mergeable: bool,
    pub head_moved: bool,
    pub work_present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Converge,
    Continue { gaps: Vec<String> },
    Pending,
}

pub struct Campaign {
    pub id: CampaignId,
    pub name: String,
    pub slug: String,
    pub context: String,
    pub strategy: Value,
    pub created_at: OffsetDateTime,
}

pub struct NewCampaign {
    pub name: String,
    pub slug: String,
    pub context: String,
    pub strategy: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CommissionState {
    Pending,
    Active,
    Interactive,
    NeedsReview,
    Merged,
    Escalated { reason: String },
    Failed { cause: String },
    Cancelled,
}

impl CommissionState {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Interactive => "interactive",
            Self::NeedsReview => "needs-review",
            Self::Merged => "merged",
            Self::Escalated { .. } => "escalated",
            Self::Failed { .. } => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn detail(&self) -> Option<&str> {
        match self {
            Self::Escalated { reason } => Some(reason),
            Self::Failed { cause } => Some(cause),
            _ => None,
        }
    }

    pub fn from_parts(kind: &str, detail: Option<&str>) -> Option<Self> {
        let detail = || detail.filter(|d| !d.is_empty()).map(str::to_owned);
        match kind {
            "pending" => Some(Self::Pending),
            "active" => Some(Self::Active),
            "interactive" => Some(Self::Interactive),
            "needs-review" => Some(Self::NeedsReview),
            "merged" => Some(Self::Merged),
            "escalated" => Some(Self::Escalated { reason: detail()? }),
            "failed" => Some(Self::Failed { cause: detail()? }),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

impl fmt::Display for CommissionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.kind())
    }
}

pub struct Commission {
    pub id: CommissionId,
    pub campaign_id: CampaignId,
    pub title: String,
    pub slug: String,
    pub spec: String,
    pub repo: String,
    pub target_ref: String,
    pub target_sha: String,
    pub wave: i64,
    pub state: CommissionState,
    pub budget: Value,
    pub strategy: Value,
    pub branch: String,
    pub pr_number: Option<i64>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

pub struct NewCommission {
    pub campaign_id: CampaignId,
    pub title: String,
    pub slug: String,
    pub spec: String,
    pub repo: String,
    pub target_ref: String,
    pub target_sha: String,
    pub wave: i64,
    pub budget: Value,
    pub strategy: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Obligation {
    pub id: ObligationId,
    pub commission_id: CommissionId,
    pub position: i64,
    pub text: String,
    pub claimed_evidence: Option<String>,
    pub created_at: OffsetDateTime,
}

pub struct Attempt {
    pub id: AttemptId,
    pub commission_id: CommissionId,
    pub n: i64,
    pub strategy: Value,
    pub started_at: OffsetDateTime,
    pub ended_at: Option<OffsetDateTime>,
    pub done_claimed_at: Option<OffsetDateTime>,
    pub heartbeat_at: OffsetDateTime,
    pub tokens: Option<i64>,
    pub outcome: Option<Value>,
}

pub struct Turn {
    pub id: TurnId,
    pub attempt_id: AttemptId,
    pub prompt_hash: String,
    pub started_at: OffsetDateTime,
    pub ended_at: Option<OffsetDateTime>,
    pub tokens: Option<i64>,
    pub result: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    CampaignCreated,
    CommissionAdmitted,
    AttemptStarted,
    AttemptEnded,
    TurnStarted,
    TurnEnded,
    StateChanged,
    GapDetected,
    ChecksFailed,
    DoneClaimed,
    AttentionRaised,
    AttentionDismissed,
    ObligationMutated,
    ObligationClaimChanged,
    SandboxDestroyed,
    SandboxDestroyFailed,
}

impl EventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CampaignCreated => "campaign-created",
            Self::CommissionAdmitted => "commission-admitted",
            Self::AttemptStarted => "attempt-started",
            Self::AttemptEnded => "attempt-ended",
            Self::TurnStarted => "turn-started",
            Self::TurnEnded => "turn-ended",
            Self::StateChanged => "state-changed",
            Self::GapDetected => "gap-detected",
            Self::ChecksFailed => "checks-failed",
            Self::DoneClaimed => "done-claimed",
            Self::AttentionRaised => "attention-raised",
            Self::AttentionDismissed => "attention-dismissed",
            Self::ObligationMutated => "obligation-mutated",
            Self::ObligationClaimChanged => "obligation-claim-changed",
            Self::SandboxDestroyed => "sandbox-destroyed",
            Self::SandboxDestroyFailed => "sandbox-destroy-failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "campaign-created" => Self::CampaignCreated,
            "commission-admitted" => Self::CommissionAdmitted,
            "attempt-started" => Self::AttemptStarted,
            "attempt-ended" => Self::AttemptEnded,
            "turn-started" => Self::TurnStarted,
            "turn-ended" => Self::TurnEnded,
            "state-changed" => Self::StateChanged,
            "gap-detected" => Self::GapDetected,
            "checks-failed" => Self::ChecksFailed,
            "done-claimed" => Self::DoneClaimed,
            "attention-raised" => Self::AttentionRaised,
            "attention-dismissed" => Self::AttentionDismissed,
            "obligation-mutated" => Self::ObligationMutated,
            "obligation-claim-changed" => Self::ObligationClaimChanged,
            "sandbox-destroyed" => Self::SandboxDestroyed,
            "sandbox-destroy-failed" => Self::SandboxDestroyFailed,
            _ => return None,
        })
    }
}

impl fmt::Display for EventKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

pub struct Event {
    pub seq: i64,
    pub at: OffsetDateTime,
    pub kind: EventKind,
    pub campaign_id: Option<CampaignId>,
    pub commission_id: Option<CommissionId>,
    pub payload: Value,
}

pub struct NewEvent {
    pub kind: EventKind,
    pub campaign_id: Option<CampaignId>,
    pub commission_id: Option<CommissionId>,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionKind {
    ReviewReady,
    BudgetExhausted,
    AgentAttention,
    EnvFailure,
    Unmergeable,
    InteractiveInvite,
    AttemptStalled,
}

impl AttentionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReviewReady => "review-ready",
            Self::BudgetExhausted => "budget-exhausted",
            Self::AgentAttention => "agent-attention",
            Self::EnvFailure => "env-failure",
            Self::Unmergeable => "unmergeable",
            Self::InteractiveInvite => "interactive-invite",
            Self::AttemptStalled => "attempt-stalled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "review-ready" => Self::ReviewReady,
            "budget-exhausted" => Self::BudgetExhausted,
            "agent-attention" => Self::AgentAttention,
            "env-failure" => Self::EnvFailure,
            "unmergeable" => Self::Unmergeable,
            "interactive-invite" => Self::InteractiveInvite,
            "attempt-stalled" => Self::AttemptStalled,
            _ => return None,
        })
    }
}

impl fmt::Display for AttentionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionState {
    Open,
    Dismissed,
}

impl AttentionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Dismissed => "dismissed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "open" => Self::Open,
            "dismissed" => Self::Dismissed,
            _ => return None,
        })
    }
}

pub struct AttentionItem {
    pub id: AttentionId,
    pub commission_id: CommissionId,
    pub kind: AttentionKind,
    pub payload: Value,
    pub state: AttentionState,
    pub created_at: OffsetDateTime,
}

pub struct NewAttention {
    pub commission_id: CommissionId,
    pub kind: AttentionKind,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnContext {
    pub campaign_name: String,
    pub campaign_context: String,
    pub commission_title: String,
    pub commission_spec: String,
    pub repo: String,
    pub target_ref: String,
    pub target_sha: String,
    pub branch: String,
    pub wave: i64,
    pub attempt_n: i64,
    pub obligations: Vec<Obligation>,
    pub gaps: Vec<String>,
    pub external: ExternalState,
}
