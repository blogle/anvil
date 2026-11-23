use std::fmt;
use std::path::Path;
use std::time::Duration;

use anvil_api::{
    Attempt, AttemptId, AttentionId, AttentionItem, AttentionKind, AttentionState, Campaign,
    CampaignId, Commission, CommissionId, CommissionState, Event, EventKind, NewAttention,
    NewCampaign, NewCommission, NewEvent, Obligation, ObligationId, Turn, TurnId,
};
use serde_json::{json, Value};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteQueryResult,
    SqliteSynchronous,
};
use sqlx::{FromRow, Row, SqlitePool};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::secrets::SecretBox;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("secrets: {0}")]
    Secrets(#[from] crate::secrets::SecretError),
    #[error("no {what} with id {id}")]
    Missing { what: &'static str, id: String },
    #[error("corrupt {field}: {value}")]
    Corrupt { field: &'static str, value: String },
}

impl StoreError {
    fn corrupt(field: &'static str, value: impl fmt::Debug) -> Self {
        Self::Corrupt {
            field,
            value: format!("{value:?}"),
        }
    }
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    secrets: SecretBox,
}

impl Store {
    pub async fn open(path: &Path) -> Result<Self, StoreError> {
        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        let secrets = SecretBox::bootstrap(dir)?;
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        Self::connect(options, secrets).await
    }

    pub async fn open_memory() -> Result<Self, StoreError> {
        let secrets = SecretBox::from_key([0u8; 32]);
        let options = SqliteConnectOptions::new()
            .in_memory(true)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool, secrets })
    }

    async fn connect(
        options: SqliteConnectOptions,
        secrets: SecretBox,
    ) -> Result<Self, StoreError> {
        let pool = SqlitePool::connect_with(options).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool, secrets })
    }

    pub async fn insert_campaign(&self, new: NewCampaign) -> Result<CampaignId, StoreError> {
        let id = CampaignId::new();
        sqlx::query(
            "INSERT INTO campaigns (id, name, slug, context, strategy, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(&new.name)
        .bind(&new.slug)
        .bind(&new.context)
        .bind(encode_json(&new.strategy))
        .bind(now_millis())
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn campaign(&self, id: CampaignId) -> Result<Option<Campaign>, StoreError> {
        let row = sqlx::query_as::<_, CampaignRow>(
            "SELECT id, name, slug, context, strategy, created_at
             FROM campaigns WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(CampaignRow::into_campaign).transpose()
    }

    pub async fn campaigns(&self) -> Result<Vec<Campaign>, StoreError> {
        let rows = sqlx::query_as::<_, CampaignRow>(
            "SELECT id, name, slug, context, strategy, created_at
             FROM campaigns ORDER BY created_at, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(CampaignRow::into_campaign).collect()
    }

    pub async fn insert_commission(&self, new: NewCommission) -> Result<CommissionId, StoreError> {
        let id = CommissionId::new();
        let now = now_millis();
        sqlx::query(
            "INSERT INTO commissions
             (id, campaign_id, title, slug, spec, repo, target_ref, target_sha, wave,
              state, state_detail, budget, strategy, branch, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, '', ?, ?)",
        )
        .bind(id.to_string())
        .bind(new.campaign_id.to_string())
        .bind(&new.title)
        .bind(&new.slug)
        .bind(&new.spec)
        .bind(&new.repo)
        .bind(&new.target_ref)
        .bind(&new.target_sha)
        .bind(new.wave)
        .bind(encode_json(&new.budget))
        .bind(encode_json(&new.strategy))
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn commissions(&self) -> Result<Vec<Commission>, StoreError> {
        let rows = sqlx::query_as::<_, CommissionRow>(
            "SELECT id, campaign_id, title, slug, spec, repo, target_ref, target_sha, wave,
                    state, state_detail, budget, strategy, branch, pr_number, created_at, updated_at
             FROM commissions ORDER BY wave, slug",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(CommissionRow::into_commission)
            .collect()
    }

    pub async fn commissions_updated_since(
        &self,
        since_millis: i64,
    ) -> Result<Vec<Commission>, StoreError> {
        let rows = sqlx::query_as::<_, CommissionRow>(
            "SELECT id, campaign_id, title, slug, spec, repo, target_ref, target_sha, wave,
                     state, state_detail, budget, strategy, branch, pr_number, created_at, updated_at
             FROM commissions WHERE updated_at > ? ORDER BY updated_at, slug",
        )
        .bind(since_millis)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(CommissionRow::into_commission)
            .collect()
    }

    pub async fn terminal_commissions_pending_teardown(
        &self,
        terminal_before: OffsetDateTime,
    ) -> Result<Vec<Commission>, StoreError> {
        let rows = sqlx::query_as::<_, CommissionRow>(
            "SELECT id, campaign_id, title, slug, spec, repo, target_ref, target_sha, wave,
                    state, state_detail, budget, strategy, branch, pr_number, created_at, updated_at
             FROM commissions
             WHERE state IN ('cancelled', 'merged') AND sandbox_destroyed_at IS NULL
               AND updated_at <= ?
             ORDER BY updated_at, slug",
        )
        .bind(to_millis(terminal_before))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(CommissionRow::into_commission)
            .collect()
    }

    pub async fn mark_sandbox_destroyed(
        &self,
        id: CommissionId,
        event: NewEvent,
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE commissions SET sandbox_destroyed_at = ?
             WHERE id = ? AND state IN ('cancelled', 'merged')
               AND sandbox_destroyed_at IS NULL",
        )
        .bind(now_millis())
        .bind(id.to_string())
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            insert_event(&mut tx, &event).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn idempotency_remember(&self, key: &str, response: &str) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT OR IGNORE INTO idempotency (key, response, created_at) VALUES (?, ?, ?)",
        )
        .bind(key)
        .bind(response)
        .bind(now_millis())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn idempotency_lookup(&self, key: &str) -> Result<Option<String>, StoreError> {
        let row = sqlx::query("SELECT response FROM idempotency WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("response")))
    }

    pub async fn commission(&self, id: CommissionId) -> Result<Option<Commission>, StoreError> {
        let row = sqlx::query_as::<_, CommissionRow>(
            "SELECT id, campaign_id, title, slug, spec, repo, target_ref, target_sha, wave,
                    state, state_detail, budget, strategy, branch, pr_number, created_at, updated_at
             FROM commissions WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(CommissionRow::into_commission).transpose()
    }

    pub async fn commissions_by_campaign(
        &self,
        campaign: CampaignId,
    ) -> Result<Vec<Commission>, StoreError> {
        let rows = sqlx::query_as::<_, CommissionRow>(
            "SELECT id, campaign_id, title, slug, spec, repo, target_ref, target_sha, wave,
                    state, state_detail, budget, strategy, branch, pr_number, created_at, updated_at
             FROM commissions WHERE campaign_id = ? ORDER BY wave, slug",
        )
        .bind(campaign.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(CommissionRow::into_commission)
            .collect()
    }

    pub async fn commissions_in_state(
        &self,
        state: &CommissionState,
    ) -> Result<Vec<Commission>, StoreError> {
        let rows = sqlx::query_as::<_, CommissionRow>(
            "SELECT id, campaign_id, title, slug, spec, repo, target_ref, target_sha, wave,
                    state, state_detail, budget, strategy, branch, pr_number, created_at, updated_at
             FROM commissions WHERE state = ? ORDER BY wave, slug",
        )
        .bind(state.kind())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(CommissionRow::into_commission)
            .collect()
    }

    pub async fn set_commission_state(
        &self,
        id: CommissionId,
        state: CommissionState,
    ) -> Result<(), StoreError> {
        let result = sqlx::query(
            "UPDATE commissions
             SET state = ?, state_detail = ?,
                 sandbox_destroyed_at = CASE WHEN ? IN ('cancelled', 'merged')
                                             THEN sandbox_destroyed_at ELSE NULL END,
                 updated_at = ? WHERE id = ?",
        )
        .bind(state.kind())
        .bind(state.detail())
        .bind(state.kind())
        .bind(now_millis())
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Self::require_row(result, "commission", &id.to_string())
    }

    pub async fn transition_commission(
        &self,
        id: CommissionId,
        to: CommissionState,
        events: &[NewEvent],
        attention: Option<NewAttention>,
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE commissions
             SET state = ?, state_detail = ?,
                 sandbox_destroyed_at = CASE WHEN ? IN ('cancelled', 'merged')
                                             THEN sandbox_destroyed_at ELSE NULL END,
                 updated_at = ? WHERE id = ?",
        )
        .bind(to.kind())
        .bind(to.detail())
        .bind(to.kind())
        .bind(now_millis())
        .bind(id.to_string())
        .execute(&mut *tx)
        .await?;
        Self::require_row(result, "commission", &id.to_string())?;
        for event in events {
            insert_event(&mut tx, event).await?;
        }
        if let Some(new) = attention {
            insert_attention(&mut tx, AttentionId::new(), &new).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn provision_and_transition(
        &self,
        id: CommissionId,
        to: CommissionState,
        target_sha: &str,
        branch: &str,
        pr_number: i64,
        events: &[NewEvent],
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE commissions
             SET state = ?, state_detail = ?,
                 sandbox_destroyed_at = CASE WHEN ? IN ('cancelled', 'merged')
                                             THEN sandbox_destroyed_at ELSE NULL END,
                 target_sha = ?, branch = ?, pr_number = ?,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(to.kind())
        .bind(to.detail())
        .bind(to.kind())
        .bind(target_sha)
        .bind(branch)
        .bind(pr_number)
        .bind(now_millis())
        .bind(id.to_string())
        .execute(&mut *tx)
        .await?;
        Self::require_row(result, "commission", &id.to_string())?;
        for event in events {
            insert_event(&mut tx, event).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn set_commission_pr(
        &self,
        id: CommissionId,
        pr_number: i64,
    ) -> Result<(), StoreError> {
        let result =
            sqlx::query("UPDATE commissions SET pr_number = ?, updated_at = ? WHERE id = ?")
                .bind(pr_number)
                .bind(now_millis())
                .bind(id.to_string())
                .execute(&self.pool)
                .await?;
        Self::require_row(result, "commission", &id.to_string())
    }

    pub async fn insert_obligation(
        &self,
        commission: CommissionId,
        text: &str,
    ) -> Result<ObligationId, StoreError> {
        let id = ObligationId::new();
        sqlx::query(
            "INSERT INTO obligations (id, commission_id, position, text, created_at)
             VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1
                            FROM obligations WHERE commission_id = ?), ?, ?)",
        )
        .bind(id.to_string())
        .bind(commission.to_string())
        .bind(commission.to_string())
        .bind(text)
        .bind(now_millis())
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn obligations(
        &self,
        commission: CommissionId,
    ) -> Result<Vec<Obligation>, StoreError> {
        let rows = sqlx::query_as::<_, ObligationRow>(
            "SELECT id, commission_id, position, text, created_at
             FROM obligations WHERE commission_id = ? ORDER BY position",
        )
        .bind(commission.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(ObligationRow::into_obligation)
            .collect()
    }

    pub async fn drop_obligation(&self, id: ObligationId) -> Result<(), StoreError> {
        let result = sqlx::query("DELETE FROM obligations WHERE id = ?")
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;
        Self::require_row(result, "obligation", &id.to_string())
    }

    pub async fn insert_attempt(
        &self,
        commission: CommissionId,
        strategy: &Value,
    ) -> Result<AttemptId, StoreError> {
        let id = AttemptId::new();
        let now = now_millis();
        sqlx::query(
            "INSERT INTO attempts (id, commission_id, n, strategy, started_at, heartbeat_at)
             VALUES (?, ?, (SELECT COALESCE(MAX(n), 0) + 1
                            FROM attempts WHERE commission_id = ?), ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(commission.to_string())
        .bind(commission.to_string())
        .bind(encode_json(strategy))
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn attempts(&self, commission: CommissionId) -> Result<Vec<Attempt>, StoreError> {
        let rows = sqlx::query_as::<_, AttemptRow>(
            "SELECT id, commission_id, n, strategy, started_at, ended_at, done_claimed_at,
                    heartbeat_at, tokens, outcome
             FROM attempts WHERE commission_id = ? ORDER BY n",
        )
        .bind(commission.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(AttemptRow::into_attempt).collect()
    }

    pub async fn touch_attempt(&self, id: AttemptId) -> Result<(), StoreError> {
        let result = sqlx::query("UPDATE attempts SET heartbeat_at = ? WHERE id = ?")
            .bind(now_millis())
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;
        Self::require_row(result, "attempt", &id.to_string())
    }

    pub async fn end_attempt(&self, id: AttemptId, outcome: Value) -> Result<(), StoreError> {
        let result = sqlx::query(
            "UPDATE attempts SET ended_at = ?,
                    tokens = (SELECT COALESCE(SUM(tokens), 0) FROM turns WHERE attempt_id = ?),
                    outcome = ? WHERE id = ?",
        )
        .bind(now_millis())
        .bind(id.to_string())
        .bind(encode_json(&outcome))
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Self::require_row(result, "attempt", &id.to_string())
    }

    pub async fn insert_turn(
        &self,
        attempt: AttemptId,
        prompt_hash: &str,
    ) -> Result<TurnId, StoreError> {
        let id = TurnId::new();
        sqlx::query(
            "INSERT INTO turns (id, attempt_id, prompt_hash, started_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(attempt.to_string())
        .bind(prompt_hash)
        .bind(now_millis())
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn end_turn(
        &self,
        id: TurnId,
        tokens: Option<i64>,
        result: Value,
    ) -> Result<(), StoreError> {
        let rows =
            sqlx::query("UPDATE turns SET ended_at = ?, tokens = ?, result = ? WHERE id = ?")
                .bind(now_millis())
                .bind(tokens)
                .bind(encode_json(&result))
                .bind(id.to_string())
                .execute(&self.pool)
                .await?;
        Self::require_row(rows, "turn", &id.to_string())
    }

    pub async fn close_in_flight_turns(&self) -> Result<u64, StoreError> {
        let rows = sqlx::query("UPDATE turns SET ended_at = ?, result = ? WHERE ended_at IS NULL")
            .bind(now_millis())
            .bind(encode_json(&json!({
                "status": "error",
                "error": "daemon restarted while the turn was in flight",
            })))
            .execute(&self.pool)
            .await?;
        Ok(rows.rows_affected())
    }

    pub async fn turns(&self, attempt: AttemptId) -> Result<Vec<Turn>, StoreError> {
        let rows = sqlx::query_as::<_, TurnRow>(
            "SELECT id, attempt_id, prompt_hash, started_at, ended_at, tokens, result
             FROM turns WHERE attempt_id = ? ORDER BY rowid",
        )
        .bind(attempt.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(TurnRow::into_turn).collect()
    }

    pub async fn append_events(&self, events: &[NewEvent]) -> Result<(), StoreError> {
        if events.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        for event in events {
            insert_event(&mut tx, event).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn events_since(&self, cursor: i64, limit: i64) -> Result<Vec<Event>, StoreError> {
        let rows = sqlx::query_as::<_, EventRow>(
            "SELECT seq, at, kind, campaign_id, commission_id, payload
             FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        )
        .bind(cursor)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(EventRow::into_event).collect()
    }

    pub async fn recent_commission_events(
        &self,
        commission: CommissionId,
        kind: &str,
        since: i64,
        limit: i64,
    ) -> Result<Vec<Value>, StoreError> {
        let rows = sqlx::query_scalar::<_, Option<String>>(
            "SELECT payload FROM events
             WHERE commission_id = ? AND kind = ? AND at > ?
             ORDER BY seq DESC LIMIT ?",
        )
        .bind(commission.to_string())
        .bind(kind)
        .bind(since)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .flatten()
            .filter_map(|raw| serde_json::from_str(&raw).ok())
            .collect())
    }

    pub async fn commission_tokens_spent(
        &self,
        commission: CommissionId,
    ) -> Result<i64, StoreError> {
        let spent: Option<i64> = sqlx::query_scalar(
            "SELECT COALESCE(SUM(t.tokens), 0) FROM turns t
             JOIN attempts a ON t.attempt_id = a.id
             WHERE a.commission_id = ?",
        )
        .bind(commission.to_string())
        .fetch_one(&self.pool)
        .await?;
        Ok(spent.unwrap_or(0))
    }

    pub async fn set_commission_strategy(
        &self,
        commission: CommissionId,
        strategy: &Value,
    ) -> Result<(), StoreError> {
        let rows = sqlx::query("UPDATE commissions SET strategy = ?, updated_at = ? WHERE id = ?")
            .bind(encode_json(strategy))
            .bind(now_millis())
            .bind(commission.to_string())
            .execute(&self.pool)
            .await?;
        Self::require_row(rows, "commission", &commission.to_string())
    }

    pub async fn set_commission_budget(
        &self,
        commission: CommissionId,
        budget: &Value,
    ) -> Result<(), StoreError> {
        let rows = sqlx::query("UPDATE commissions SET budget = ?, updated_at = ? WHERE id = ?")
            .bind(encode_json(budget))
            .bind(now_millis())
            .bind(commission.to_string())
            .execute(&self.pool)
            .await?;
        Self::require_row(rows, "commission", &commission.to_string())
    }

    pub async fn raise_attention(&self, new: NewAttention) -> Result<AttentionId, StoreError> {
        let id = AttentionId::new();
        let mut tx = self.pool.begin().await?;
        insert_attention(&mut tx, id, &new).await?;
        tx.commit().await?;
        Ok(id)
    }

    pub async fn open_attention(&self) -> Result<Vec<AttentionItem>, StoreError> {
        let rows = sqlx::query_as::<_, AttentionRow>(
            "SELECT id, commission_id, kind, payload, state, created_at
             FROM attention WHERE state = 'open' ORDER BY created_at, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(AttentionRow::into_attention).collect()
    }

    pub async fn dismiss_attention(&self, id: AttentionId) -> Result<(), StoreError> {
        let result =
            sqlx::query("UPDATE attention SET state = 'dismissed' WHERE id = ? AND state = 'open'")
                .bind(id.to_string())
                .execute(&self.pool)
                .await?;
        Self::require_row(result, "open attention item", &id.to_string())
    }

    pub async fn set_config(&self, key: &str, value: &str) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO config (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn config(&self, key: &str) -> Result<Option<String>, StoreError> {
        let row = sqlx::query("SELECT value FROM config WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("value")))
    }

    pub async fn put_credential(&self, name: &str, secret: &str) -> Result<(), StoreError> {
        let sealed = self.secrets.seal(secret)?;
        sqlx::query(
            "INSERT INTO credentials (name, secret, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET secret = excluded.secret,
                                            updated_at = excluded.updated_at",
        )
        .bind(name)
        .bind(sealed)
        .bind(now_millis())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn credential(&self, name: &str) -> Result<Option<String>, StoreError> {
        let row = sqlx::query("SELECT secret FROM credentials WHERE name = ?")
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            None => Ok(None),
            Some(row) => {
                let raw = row.get::<String, _>("secret");
                Ok(self.secrets.open(&raw)?)
            }
        }
    }

    pub async fn credential_names(&self) -> Result<Vec<(String, i64)>, StoreError> {
        let rows = sqlx::query("SELECT name, updated_at FROM credentials ORDER BY name")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                (
                    row.get::<String, _>("name"),
                    row.get::<i64, _>("updated_at"),
                )
            })
            .collect())
    }

    pub async fn issue_commission_token(
        &self,
        commission: CommissionId,
    ) -> Result<String, StoreError> {
        let token = Uuid::new_v4().to_string();
        let hash = token_hash(&token);
        sqlx::query("INSERT INTO tokens (token_hash, commission_id, created_at) VALUES (?, ?, ?)")
            .bind(hash)
            .bind(commission.to_string())
            .bind(now_millis())
            .execute(&self.pool)
            .await?;
        Ok(token)
    }

    pub async fn commission_by_token(
        &self,
        token: &str,
    ) -> Result<Option<CommissionId>, StoreError> {
        let row = sqlx::query("SELECT commission_id FROM tokens WHERE token_hash = ?")
            .bind(token_hash(token))
            .fetch_optional(&self.pool)
            .await?;
        row.map(|r| {
            decode_uuid("commission id", &r.get::<String, _>("commission_id")).map(CommissionId)
        })
        .transpose()
    }

    pub async fn claim_done(
        &self,
        commission: CommissionId,
        notes: Option<&str>,
    ) -> Result<AttemptId, StoreError> {
        let mut tx = self.pool.begin().await?;
        let running = sqlx::query(
            "SELECT id, done_claimed_at FROM attempts
             WHERE commission_id = ? AND ended_at IS NULL
             ORDER BY n DESC LIMIT 1",
        )
        .bind(commission.to_string())
        .fetch_optional(&mut *tx)
        .await?;
        let Some(running) = running else {
            return Err(StoreError::Missing {
                what: "running attempt for done claim",
                id: commission.to_string(),
            });
        };
        let attempt_id = AttemptId(decode_uuid("attempt id", &running.get::<String, _>("id"))?);
        if running.get::<Option<i64>, _>("done_claimed_at").is_none() {
            sqlx::query("UPDATE attempts SET done_claimed_at = ? WHERE id = ?")
                .bind(now_millis())
                .bind(attempt_id.to_string())
                .execute(&mut *tx)
                .await?;
            let mut payload = json!({"attempt": attempt_id.to_string()});
            if let Some(notes) = notes {
                payload["notes"] = json!(notes);
            }
            insert_event(
                &mut tx,
                &NewEvent {
                    kind: EventKind::DoneClaimed,
                    campaign_id: None,
                    commission_id: Some(commission),
                    payload,
                },
            )
            .await?;
        }
        tx.commit().await?;
        Ok(attempt_id)
    }

    pub async fn clear_done_claim(&self, id: AttemptId) -> Result<(), StoreError> {
        let result =
            sqlx::query("UPDATE attempts SET done_claimed_at = NULL WHERE id = ? AND done_claimed_at IS NOT NULL")
                .bind(id.to_string())
                .execute(&self.pool)
                .await?;
        Self::require_row(result, "claimed attempt", &id.to_string())
    }

    pub async fn agent_attention(
        &self,
        commission: CommissionId,
        message: &str,
    ) -> Result<AttentionId, StoreError> {
        let id = AttentionId::new();
        let mut tx = self.pool.begin().await?;
        insert_attention(
            &mut tx,
            id,
            &NewAttention {
                commission_id: commission,
                kind: AttentionKind::AgentAttention,
                payload: json!({"message": message}),
            },
        )
        .await?;
        insert_event(
            &mut tx,
            &NewEvent {
                kind: EventKind::AttentionRaised,
                campaign_id: None,
                commission_id: Some(commission),
                payload: json!({"message": message}),
            },
        )
        .await?;
        tx.commit().await?;
        Ok(id)
    }

    fn require_row(
        result: SqliteQueryResult,
        what: &'static str,
        id: &str,
    ) -> Result<(), StoreError> {
        if result.rows_affected() == 0 {
            Err(StoreError::Missing {
                what,
                id: id.to_owned(),
            })
        } else {
            Ok(())
        }
    }
}

fn now_millis() -> i64 {
    to_millis(OffsetDateTime::now_utc())
}

async fn insert_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &NewEvent,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO events (at, kind, campaign_id, commission_id, payload)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(now_millis())
    .bind(event.kind.as_str())
    .bind(event.campaign_id.map(|id| id.to_string()))
    .bind(event.commission_id.map(|id| id.to_string()))
    .bind(encode_json(&event.payload))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_attention(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: AttentionId,
    new: &NewAttention,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO attention (id, commission_id, kind, payload, state, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)",
    )
    .bind(id.to_string())
    .bind(new.commission_id.to_string())
    .bind(new.kind.as_str())
    .bind(encode_json(&new.payload))
    .bind(now_millis())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn to_millis(at: OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

fn from_millis(millis: i64) -> Result<OffsetDateTime, StoreError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .map_err(|_| StoreError::corrupt("timestamp", millis))
}

fn decode_uuid(field: &'static str, raw: &str) -> Result<Uuid, StoreError> {
    Uuid::parse_str(raw).map_err(|_| StoreError::corrupt(field, raw))
}

fn encode_json(value: &Value) -> String {
    value.to_string()
}

fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn decode_json(field: &'static str, raw: &str) -> Result<Value, StoreError> {
    serde_json::from_str(raw).map_err(|_| StoreError::corrupt(field, raw))
}

#[derive(FromRow)]
struct CampaignRow {
    id: String,
    name: String,
    slug: String,
    context: String,
    strategy: String,
    created_at: i64,
}

impl CampaignRow {
    fn into_campaign(self) -> Result<Campaign, StoreError> {
        Ok(Campaign {
            id: CampaignId(decode_uuid("campaign id", &self.id)?),
            name: self.name,
            slug: self.slug,
            context: self.context,
            strategy: decode_json("campaign strategy", &self.strategy)?,
            created_at: from_millis(self.created_at)?,
        })
    }
}

#[derive(FromRow)]
struct CommissionRow {
    id: String,
    campaign_id: String,
    title: String,
    slug: String,
    spec: String,
    repo: String,
    target_ref: String,
    target_sha: String,
    wave: i64,
    state: String,
    state_detail: Option<String>,
    budget: String,
    strategy: String,
    branch: String,
    pr_number: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

impl CommissionRow {
    fn into_commission(self) -> Result<Commission, StoreError> {
        let detail = self.state_detail.as_deref().filter(|d| !d.is_empty());
        Ok(Commission {
            id: CommissionId(decode_uuid("commission id", &self.id)?),
            campaign_id: CampaignId(decode_uuid("campaign id", &self.campaign_id)?),
            title: self.title,
            slug: self.slug,
            spec: self.spec,
            repo: self.repo,
            target_ref: self.target_ref,
            target_sha: self.target_sha,
            wave: self.wave,
            state: CommissionState::from_parts(&self.state, detail)
                .ok_or_else(|| StoreError::corrupt("commission state", &self.state))?,
            budget: decode_json("commission budget", &self.budget)?,
            strategy: decode_json("commission strategy", &self.strategy)?,
            branch: self.branch,
            pr_number: self.pr_number,
            created_at: from_millis(self.created_at)?,
            updated_at: from_millis(self.updated_at)?,
        })
    }
}

#[derive(FromRow)]
struct ObligationRow {
    id: String,
    commission_id: String,
    position: i64,
    text: String,
    created_at: i64,
}

impl ObligationRow {
    fn into_obligation(self) -> Result<Obligation, StoreError> {
        Ok(Obligation {
            id: ObligationId(decode_uuid("obligation id", &self.id)?),
            commission_id: CommissionId(decode_uuid("commission id", &self.commission_id)?),
            position: self.position,
            text: self.text,
            created_at: from_millis(self.created_at)?,
        })
    }
}

#[derive(FromRow)]
struct AttemptRow {
    id: String,
    commission_id: String,
    n: i64,
    strategy: String,
    started_at: i64,
    ended_at: Option<i64>,
    done_claimed_at: Option<i64>,
    heartbeat_at: i64,
    tokens: Option<i64>,
    outcome: Option<String>,
}

impl AttemptRow {
    fn into_attempt(self) -> Result<Attempt, StoreError> {
        Ok(Attempt {
            id: AttemptId(decode_uuid("attempt id", &self.id)?),
            commission_id: CommissionId(decode_uuid("commission id", &self.commission_id)?),
            n: self.n,
            strategy: decode_json("attempt strategy", &self.strategy)?,
            started_at: from_millis(self.started_at)?,
            ended_at: self.ended_at.map(from_millis).transpose()?,
            done_claimed_at: self.done_claimed_at.map(from_millis).transpose()?,
            heartbeat_at: from_millis(self.heartbeat_at)?,
            tokens: self.tokens,
            outcome: self
                .outcome
                .as_deref()
                .map(|raw| decode_json("attempt outcome", raw))
                .transpose()?,
        })
    }
}

#[derive(FromRow)]
struct TurnRow {
    id: String,
    attempt_id: String,
    prompt_hash: String,
    started_at: i64,
    ended_at: Option<i64>,
    tokens: Option<i64>,
    result: Option<String>,
}

impl TurnRow {
    fn into_turn(self) -> Result<Turn, StoreError> {
        Ok(Turn {
            id: TurnId(decode_uuid("turn id", &self.id)?),
            attempt_id: AttemptId(decode_uuid("attempt id", &self.attempt_id)?),
            prompt_hash: self.prompt_hash,
            started_at: from_millis(self.started_at)?,
            ended_at: self.ended_at.map(from_millis).transpose()?,
            tokens: self.tokens,
            result: self
                .result
                .as_deref()
                .map(|raw| decode_json("turn result", raw))
                .transpose()?,
        })
    }
}

#[derive(FromRow)]
struct EventRow {
    seq: i64,
    at: i64,
    kind: String,
    campaign_id: Option<String>,
    commission_id: Option<String>,
    payload: String,
}

impl EventRow {
    fn into_event(self) -> Result<Event, StoreError> {
        Ok(Event {
            seq: self.seq,
            at: from_millis(self.at)?,
            kind: EventKind::parse(&self.kind)
                .ok_or_else(|| StoreError::corrupt("event kind", &self.kind))?,
            campaign_id: self
                .campaign_id
                .as_deref()
                .map(|raw| decode_uuid("campaign id", raw))
                .transpose()?
                .map(CampaignId),
            commission_id: self
                .commission_id
                .as_deref()
                .map(|raw| decode_uuid("commission id", raw))
                .transpose()?
                .map(CommissionId),
            payload: decode_json("event payload", &self.payload)?,
        })
    }
}

#[derive(FromRow)]
struct AttentionRow {
    id: String,
    commission_id: String,
    kind: String,
    payload: String,
    state: String,
    created_at: i64,
}

impl AttentionRow {
    fn into_attention(self) -> Result<AttentionItem, StoreError> {
        Ok(AttentionItem {
            id: AttentionId(decode_uuid("attention id", &self.id)?),
            commission_id: CommissionId(decode_uuid("commission id", &self.commission_id)?),
            kind: AttentionKind::parse(&self.kind)
                .ok_or_else(|| StoreError::corrupt("attention kind", &self.kind))?,
            payload: decode_json("attention payload", &self.payload)?,
            state: AttentionState::parse(&self.state)
                .ok_or_else(|| StoreError::corrupt("attention state", &self.state))?,
            created_at: from_millis(self.created_at)?,
        })
    }
}
