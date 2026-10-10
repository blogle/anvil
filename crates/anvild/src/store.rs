//! Controller-owned transactional orchestration storage.
//!
//! A store handle serializes its own operations with a mutex; separate handles/processes
//! use SQLite WAL for reader/writer concurrency and SQLite's writer lock for arbitration.
//! FULL synchronous commits make accepted results durable before provisioning begins.
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};
use thiserror::Error;

pub mod scheduler;

const CANONICALIZATION_VERSION: i64 = 1;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("idempotency key was already used for a different request")]
    Conflict,
    #[error("unsupported canonicalization version {0}")]
    UnsupportedCanonicalization(i64),
    #[error("idempotency record not found")]
    NotFound,
    #[error("invalid idempotency state {0}")]
    InvalidState(String),
    #[error("scheduler configuration or transition is invalid: {0}")]
    Scheduler(String),
    #[error("store error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("store I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("request canonicalization error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedResult {
    pub idempotency_key: String,
    pub operation_kind: String,
    pub scope: String,
    pub result_reference: String,
    pub result: Value,
    pub state: IdempotencyState,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdempotencyState {
    Accepted,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Acceptance {
    Created(AcceptedResult),
    Replayed(AcceptedResult),
}

/// Complete transaction input for accepting one batch and its logical tasks.
pub struct BatchAcceptance<'a> {
    pub key: &'a str,
    pub scope: &'a str,
    pub request: &'a Value,
    pub batch_id: &'a str,
    pub batch: &'a Value,
    pub tasks: &'a [(String, Value)],
    pub allow_competing: bool,
}

#[derive(Debug, Clone)]
pub struct AttemptAcceptance {
    pub attempt: Value,
    pub created: bool,
}

#[derive(Debug, Clone)]
pub struct TaskAcceptance {
    pub task: Value,
    pub created: bool,
}

#[derive(Clone)]
pub struct ControllerStore {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangePage {
    pub cursor: String,
    pub changes: Vec<Value>,
    pub reset_required: bool,
}

impl ControllerStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(10))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )?;
        migrate(&connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    /// Persist the current Anvil-owned projection and its change record atomically. `None`
    /// represents a tombstone while keeping the resource identity reusable for filtering.
    pub fn materialize(
        &self,
        resource_type: &str,
        resource_id: &str,
        value: Option<&Value>,
    ) -> Result<String, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let payload = value.map(serde_json::to_string).transpose()?;
        let latest: Option<(Option<String>, i64)> = tx.query_row(
            "SELECT payload_json, last_sequence FROM orchestration_materializations WHERE resource_type=?1 AND resource_id=?2",
            params![resource_type, resource_id], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
        if let Some((current, seq)) = latest.as_ref() {
            if current.as_deref() == payload.as_deref() {
                tx.commit()?;
                return Ok(encode_cursor(*seq));
            }
        }
        let change = value
            .map(|value| serde_json::json!({"deleted":false,"record":value}))
            .unwrap_or_else(|| serde_json::json!({"deleted":true}));
        tx.execute("INSERT INTO orchestration_changes(resource_type, resource_id, payload_json) VALUES (?1,?2,?3)", params![resource_type, resource_id, serde_json::to_string(&change)?])?;
        let seq = tx.last_insert_rowid();
        tx.execute("INSERT INTO orchestration_materializations(resource_type,resource_id,payload_json,last_sequence) VALUES (?1,?2,?3,?4) ON CONFLICT(resource_type,resource_id) DO UPDATE SET payload_json=excluded.payload_json,last_sequence=excluded.last_sequence", params![resource_type, resource_id, payload, seq])?;
        tx.commit()?;
        Ok(encode_cursor(seq))
    }

    /// Read the canonical durable batch resources and stream boundary from one SQLite snapshot.
    pub fn batch_snapshot(&self, batch_id: &str) -> Result<(String, Vec<Value>), StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let cursor = tx.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM orchestration_changes",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        let mut statement = tx.prepare(
            "SELECT resource_type,resource_id,payload_json FROM orchestration_resources
             WHERE batch_id=?1 ORDER BY CASE resource_type WHEN 'batch' THEN 0 WHEN 'task' THEN 1 ELSE 2 END, resource_id",
        )?;
        let rows = statement.query_map([batch_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut resources = Vec::new();
        let mut task_ids = std::collections::BTreeSet::new();
        for row in rows {
            let (resource_type, resource_id, payload) = row?;
            if resource_type == "task" {
                task_ids.insert(resource_id.clone());
            }
            let record: Value = serde_json::from_str(&payload)?;
            resources.push(serde_json::json!({
                "resource_type": resource_type,
                "resource_id": resource_id,
                "record": record,
            }));
        }
        if let Some(batch) = resources
            .iter()
            .find(|resource| resource["resource_type"] == "batch")
        {
            if let Some(ids) = batch["record"]["accepted_task_ids"].as_array() {
                task_ids.extend(ids.iter().filter_map(Value::as_str).map(str::to_owned));
            }
        }
        for task_id in task_ids {
            let task_exists = resources.iter().any(|resource| {
                resource["resource_type"] == "task" && resource["resource_id"] == task_id
            });
            if !task_exists {
                let task: Option<String> = tx
                    .query_row(
                        "SELECT payload_json FROM orchestration_resources WHERE resource_type='task' AND resource_id=?1",
                        [&task_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(task) = task {
                    resources.push(serde_json::json!({
                        "resource_type":"task",
                        "resource_id":task_id,
                        "record":serde_json::from_str::<Value>(&task)?,
                    }));
                }
            }
            let mut attempts = tx.prepare(
                "SELECT resource_id,payload_json FROM orchestration_resources WHERE resource_type='attempt' AND task_id=?1 ORDER BY resource_id",
            )?;
            let rows = attempts.query_map([&task_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (attempt_id, attempt) = row?;
                if resources.iter().any(|resource| {
                    resource["resource_type"] == "attempt" && resource["resource_id"] == attempt_id
                }) {
                    continue;
                }
                resources.push(serde_json::json!({
                    "resource_type":"attempt",
                    "resource_id":attempt_id,
                    "record":serde_json::from_str::<Value>(&attempt)?,
                }));
            }
        }
        let session_ids: std::collections::BTreeSet<_> = resources
            .iter()
            .filter(|resource| resource["resource_type"] == "attempt")
            .filter_map(|resource| resource["record"]["session_id"].as_str())
            .map(str::to_owned)
            .collect();
        for session_id in session_ids {
            let session: Option<String> = tx
                .query_row(
                    "SELECT payload_json FROM orchestration_materializations WHERE resource_type='session' AND resource_id=?1 AND payload_json IS NOT NULL",
                    [&session_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(session) = session {
                resources.push(serde_json::json!({
                    "resource_type":"session",
                    "resource_id":session_id,
                    "record":serde_json::from_str::<Value>(&session)?,
                }));
            }
        }
        drop(statement);
        tx.commit()?;
        Ok((encode_cursor(cursor), resources))
    }

    /// Read a full materialized snapshot and its boundary from a single SQLite read transaction.
    /// The change log is intentionally unbounded in this version; pruning must advance an
    /// explicit retention floor before old cursors can be considered expired.
    pub fn materialized_snapshot(&self) -> Result<(String, Vec<Value>), StoreError> {
        self.materialized_snapshot_with(|| {})
    }

    fn materialized_snapshot_with(
        &self,
        after_cursor_read: impl FnOnce(),
    ) -> Result<(String, Vec<Value>), StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let cursor = tx.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM orchestration_changes",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        after_cursor_read();
        let mut statement = tx.prepare("SELECT resource_type, resource_id, payload_json FROM orchestration_materializations WHERE payload_json IS NOT NULL ORDER BY resource_type, resource_id")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut snapshot = Vec::new();
        for row in rows {
            let (resource_type, resource_id, payload) = row?;
            snapshot.push(serde_json::json!({"resource_type":resource_type,"resource_id":resource_id,"record":serde_json::from_str::<Value>(&payload)?}));
        }
        drop(statement);
        tx.commit()?;
        Ok((encode_cursor(cursor), snapshot))
    }

    /// Read strictly after an opaque cursor. Reusing it is deterministic and exclusive;
    /// cursors beyond the stream or crossing a retained-history gap require a full reset.
    /// History is currently unbounded, so the gap path protects against manual/partial loss.
    pub fn changes_after(&self, cursor: &str, limit: usize) -> Result<ChangePage, StoreError> {
        let Some(after) = decode_cursor(cursor) else {
            return Ok(ChangePage {
                cursor: String::new(),
                changes: vec![],
                reset_required: true,
            });
        };
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let latest: i64 = connection.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM orchestration_changes",
            [],
            |row| row.get(0),
        )?;
        let earliest: i64 = connection.query_row(
            "SELECT COALESCE(MIN(sequence),0) FROM orchestration_changes",
            [],
            |row| row.get(0),
        )?;
        let next: Option<i64> = connection.query_row(
            "SELECT MIN(sequence) FROM orchestration_changes WHERE sequence>?1",
            [after],
            |row| row.get(0),
        )?;
        if after > latest
            || (earliest > 0 && after < earliest.saturating_sub(1))
            || next.is_some_and(|next| next > after.saturating_add(1))
        {
            return Ok(ChangePage {
                cursor: encode_cursor(latest),
                changes: vec![],
                reset_required: true,
            });
        }
        let mut statement = connection.prepare("SELECT sequence, resource_type, resource_id, payload_json FROM orchestration_changes WHERE sequence>?1 ORDER BY sequence LIMIT ?2")?;
        let rows = statement.query_map(params![after, limit as i64], |row| {
            let sequence: i64 = row.get(0)?;
            let resource_type: String = row.get(1)?;
            let resource_id: String = row.get(2)?;
            let payload: String = row.get(3)?;
            Ok((sequence, resource_type, resource_id, payload))
        })?;
        let mut changes = Vec::new();
        let mut last = after;
        for row in rows {
            let (sequence, resource_type, resource_id, payload) = row?;
            last = sequence;
            changes.push(serde_json::json!({"resource_type":resource_type,"resource_id":resource_id,"change":serde_json::from_str::<Value>(&payload)?}));
        }
        Ok(ChangePage {
            cursor: encode_cursor(last),
            changes,
            reset_required: false,
        })
    }

    /// Record acceptance atomically with its authoritative result. Provisioning must occur after this returns.
    pub fn accept(
        &self,
        key: &str,
        operation_kind: &str,
        scope: &str,
        request: &Value,
        result_reference: &str,
        result: &Value,
    ) -> Result<Acceptance, StoreError> {
        let canonical = canonical_json(request);
        let hash = Sha256::digest(canonical.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx.query_row("SELECT operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at FROM idempotency_records WHERE idempotency_key=?1", [key], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?))).optional()?;
        if let Some((
            kind,
            stored_scope,
            stored_hash,
            version,
            reference,
            json,
            state,
            created_at,
            updated_at,
        )) = existing
        {
            if version != CANONICALIZATION_VERSION {
                return Err(StoreError::UnsupportedCanonicalization(version));
            }
            if kind != operation_kind || stored_scope != scope || stored_hash != hash {
                return Err(StoreError::Conflict);
            }
            let result = serde_json::from_str(&json)?;
            tx.commit()?;
            return Ok(Acceptance::Replayed(AcceptedResult {
                idempotency_key: key.into(),
                operation_kind: kind,
                scope: stored_scope,
                result_reference: reference,
                result,
                state: parse_state(&state)?,
                created_at,
                updated_at,
            }));
        }
        tx.execute("INSERT INTO idempotency_records (idempotency_key, operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'accepted',?8,?8)", params![key, operation_kind, scope, hash, CANONICALIZATION_VERSION, result_reference, serde_json::to_string(result)?, now])?;
        tx.commit()?;
        Ok(Acceptance::Created(AcceptedResult {
            idempotency_key: key.into(),
            operation_kind: operation_kind.into(),
            scope: scope.into(),
            result_reference: result_reference.into(),
            result: result.clone(),
            state: IdempotencyState::Accepted,
            created_at: now.clone(),
            updated_at: now,
        }))
    }

    /// Atomically bind an idempotency key to a batch and persist its batch/task resources.
    pub fn accept_batch(&self, input: BatchAcceptance<'_>) -> Result<Acceptance, StoreError> {
        let BatchAcceptance {
            key,
            scope,
            request,
            batch_id,
            batch,
            tasks,
            allow_competing,
        } = input;
        let canonical = canonical_json(request);
        let hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx.query_row(
            "SELECT operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at FROM idempotency_records WHERE idempotency_key=?1",
            [key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?)),
        ).optional()?;
        if let Some((
            kind,
            stored_scope,
            stored_hash,
            version,
            reference,
            json,
            state,
            created_at,
            updated_at,
        )) = existing
        {
            if version != CANONICALIZATION_VERSION {
                return Err(StoreError::UnsupportedCanonicalization(version));
            }
            if kind != "submit_batch" || stored_scope != scope || stored_hash != hash {
                return Err(StoreError::Conflict);
            }
            let result = serde_json::from_str(&json)?;
            tx.commit()?;
            return Ok(Acceptance::Replayed(AcceptedResult {
                idempotency_key: key.into(),
                operation_kind: kind,
                scope: stored_scope,
                result_reference: reference,
                result,
                state: parse_state(&state)?,
                created_at,
                updated_at,
            }));
        }
        let mut accepted_batch = batch.clone();
        let mut new_tasks: Vec<(String, Value)> = Vec::new();
        let mut suppressed = Vec::new();
        for (task_id, task) in tasks {
            let already_in_batch = if allow_competing {
                None
            } else {
                new_tasks.iter().find_map(|(existing_id, existing_task)| {
                    same_logical_work(existing_task, task)
                        .then(|| (existing_id.clone(), String::new()))
                })
            };
            let existing: Option<(String, String)> = if already_in_batch.is_some() {
                already_in_batch
            } else if allow_competing {
                None
            } else {
                let mut statement = tx.prepare("SELECT resource_id,payload_json FROM orchestration_resources WHERE resource_type='task' AND json_extract(payload_json,'$.project')=?1 AND json_extract(payload_json,'$.repository')=?2 AND json_extract(payload_json,'$.prompt')=?3 AND json_extract(payload_json,'$.state') IN ('queued','running')")?;
                let matches = statement.query_map(
                    params![
                        task["project"].as_str(),
                        task["repository"].as_str(),
                        task["prompt"].as_str()
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                let mut collision = None;
                for matched in matches {
                    let (id, payload) = matched?;
                    let payload: Value = serde_json::from_str(&payload)?;
                    if same_logical_work(&payload, task) {
                        collision = Some((id, payload.to_string()));
                        break;
                    }
                }
                collision
            };
            if let Some((existing_id, _)) = existing {
                suppressed.push(
                    serde_json::json!({"requested_task_id":task_id,"existing_task_id":existing_id}),
                );
            } else {
                new_tasks.push((task_id.clone(), task.clone()));
            }
        }
        let aliases: std::collections::HashMap<_, _> = suppressed
            .iter()
            .filter_map(|entry| {
                Some((
                    entry["requested_task_id"].as_str()?.to_owned(),
                    entry["existing_task_id"].as_str()?.to_owned(),
                ))
            })
            .collect();
        if !suppressed.is_empty() {
            accepted_batch["queued_count"] = serde_json::json!(new_tasks.len());
            accepted_batch["runnable_count"] = serde_json::json!(
                new_tasks
                    .iter()
                    .filter(|(_, task)| task["dependencies"].as_array().is_none_or(Vec::is_empty))
                    .count()
            );
            if let Some(ids) = accepted_batch
                .get_mut("accepted_task_ids")
                .and_then(Value::as_array_mut)
            {
                for outcome in &suppressed {
                    let requested = outcome["requested_task_id"].as_str().unwrap_or_default();
                    let existing = outcome["existing_task_id"].as_str().unwrap_or_default();
                    if let Some(id) = ids.iter_mut().find(|id| id.as_str() == Some(requested)) {
                        *id = Value::String(existing.to_owned());
                    }
                }
            }
            accepted_batch["duplicate_suppression"] = Value::Array(suppressed);
        }
        tx.execute("INSERT INTO orchestration_resources (resource_type, resource_id, batch_id, task_id, attempt_id, payload_json, created_at, updated_at) VALUES ('batch',?1,?1,NULL,NULL,?2,?3,?3)", params![batch_id, serde_json::to_string(&accepted_batch)?, now])?;
        tx.execute("INSERT INTO batches(batch_id,project,repository,requested_revision,base_commit,payload_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![batch_id,accepted_batch["project"].as_str().unwrap_or_default(),accepted_batch["repository"].as_str().unwrap_or_default(),accepted_batch["requested_revision"].as_str().unwrap_or_default(),accepted_batch["base_commit"].as_str().unwrap_or_default(),serde_json::to_string(&accepted_batch)?,now])?;
        append_resource_change(&tx, "batch", batch_id, &accepted_batch)?;
        for (task_id, mut task) in new_tasks {
            if let Some(dependencies) = task["dependencies"].as_array_mut() {
                for dependency in dependencies {
                    if let Some(replacement) = dependency.as_str().and_then(|id| aliases.get(id)) {
                        *dependency = Value::String(replacement.clone());
                    }
                }
            }
            tx.execute("INSERT INTO tasks(task_id,batch_id,client_task_id,project,repository,prompt,state,payload_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,'queued',?7,?8)", params![task_id,batch_id,task["requested_task_id"].as_str().unwrap_or(&task_id),task["project"].as_str().unwrap_or_default(),task["repository"].as_str().unwrap_or_default(),task["prompt"].as_str().unwrap_or_default(),serde_json::to_string(&task)?,now])?;
            let execution_target = serde_json::json!({
                "kind":"git_repository", "project":task["project"], "repository":task["repository"],
                "base_ref":task["requested_revision"], "delivery":{"kind":"pull_request"}
            });
            let completion_policy =
                serde_json::json!({"kind":"evidence","required_kinds":["legacy_scheduler_exit"]});
            let budget = serde_json::json!({"max_attempts":3,"max_continuations_per_reason":2,"max_verifier_cycles":0,"max_ci_retries":2,"max_execution_seconds":14400,"max_model_cost":null});
            tx.execute(
                "INSERT INTO task_durable_state(task_id,completion_policy_json,verification_spec_json,budget_json,execution_target_json,work_branch,base_revision,updated_at) VALUES(?1,?2,'{\"holdout_scenarios\":[]}',?3,?4,?5,?6,?7)",
                params![task_id,serde_json::to_string(&completion_policy)?,serde_json::to_string(&budget)?,serde_json::to_string(&execution_target)?,format!("anvil/{task_id}"),task["base_id"].as_str().or(task["base_commit"].as_str()),now],
            )?;
            if let Some(dependencies) = task["dependencies"].as_array() {
                for predecessor in dependencies.iter().filter_map(Value::as_str) {
                    tx.execute("INSERT INTO task_dependencies(predecessor_task_id,successor_task_id) VALUES(?1,?2)",params![predecessor,task_id])?;
                }
            }
            tx.execute("INSERT INTO orchestration_resources (resource_type, resource_id, batch_id, task_id, attempt_id, payload_json, created_at, updated_at) VALUES ('task',?1,?2,?1,NULL,?3,?4,?4)", params![task_id, batch_id, serde_json::to_string(&task)?, now])?;
            append_resource_change(&tx, "task", &task_id, &task)?;
        }
        tx.execute("INSERT INTO idempotency_records (idempotency_key, operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at) VALUES (?1,'submit_batch',?2,?3,?4,?5,?6,'accepted',?7,?7)", params![key, scope, hash, CANONICALIZATION_VERSION, batch_id, serde_json::to_string(&accepted_batch)?, now])?;
        tx.commit()?;
        Ok(Acceptance::Created(AcceptedResult {
            idempotency_key: key.into(),
            operation_kind: "submit_batch".into(),
            scope: scope.into(),
            result_reference: batch_id.into(),
            result: accepted_batch,
            state: IdempotencyState::Accepted,
            created_at: now.clone(),
            updated_at: now,
        }))
    }

    /// Check an existing submission binding before external base resolution. A miss is not
    /// a reservation; `accept_batch` still arbitrates races inside its write transaction.
    pub fn replay_batch(
        &self,
        key: &str,
        scope: &str,
        request: &Value,
    ) -> Result<Option<AcceptedResult>, StoreError> {
        let canonical = canonical_json(request);
        let hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let existing = connection.query_row(
            "SELECT operation_kind,scope,request_hash,canonicalization_version,result_reference,result_json,state,created_at,updated_at FROM idempotency_records WHERE idempotency_key=?1",
            [key],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?)),
        ).optional()?;
        let Some((
            kind,
            stored_scope,
            stored_hash,
            version,
            reference,
            json,
            state,
            created_at,
            updated_at,
        )) = existing
        else {
            return Ok(None);
        };
        if version != CANONICALIZATION_VERSION {
            return Err(StoreError::UnsupportedCanonicalization(version));
        }
        if kind != "submit_batch" || stored_scope != scope || stored_hash != hash {
            return Err(StoreError::Conflict);
        }
        Ok(Some(AcceptedResult {
            idempotency_key: key.into(),
            operation_kind: kind,
            scope: stored_scope,
            result_reference: reference,
            result: serde_json::from_str(&json)?,
            state: parse_state(&state)?,
            created_at,
            updated_at,
        }))
    }

    pub fn get_resource(&self, resource_type: &str, id: &str) -> Result<Option<Value>, StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let query = match resource_type {
            "batch" => "SELECT payload_json FROM batches WHERE batch_id=?1",
            "task" => "SELECT payload_json FROM tasks WHERE task_id=?1",
            "attempt" => "SELECT payload_json FROM attempts WHERE attempt_id=?1",
            _ => return Ok(None),
        };
        connection
            .query_row(query, [id], |row| row.get::<_, String>(0))
            .optional()?
            .map(|value| serde_json::from_str(&value).map_err(StoreError::from))
            .transpose()
    }

    /// Accept one Task without requiring a Batch. Intent, durable metadata, the
    /// resource projection, and the idempotency binding commit atomically.
    pub fn accept_task(
        &self,
        key: &str,
        scope: &str,
        request: &Value,
        task_id: &str,
        specification: &Value,
    ) -> Result<TaskAcceptance, StoreError> {
        let hash = format!("{:x}", Sha256::digest(canonical_json(request).as_bytes()));
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx.query_row(
            "SELECT operation_kind,scope,request_hash,canonicalization_version,result_reference,result_json FROM idempotency_records WHERE idempotency_key=?1",
            [key],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?)),
        ).optional()?;
        if let Some((kind, stored_scope, stored_hash, canonical_version, _reference, json)) =
            existing
        {
            if kind != "create_task"
                || stored_scope != scope
                || stored_hash != hash
                || canonical_version != CANONICALIZATION_VERSION
            {
                return Err(StoreError::Conflict);
            }
            let task = serde_json::from_str(&json)?;
            tx.commit()?;
            return Ok(TaskAcceptance {
                task,
                created: false,
            });
        }
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE task_id=?1)",
            [task_id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(StoreError::Conflict);
        }
        let outcome = specification["outcome"].as_str().unwrap_or_default();
        let target = specification
            .get("execution_target")
            .filter(|v| !v.is_null());
        let project = target
            .and_then(|v| v["project"].as_str())
            .unwrap_or_default();
        let repository = target
            .and_then(|v| v["repository"].as_str())
            .unwrap_or_default();
        let runnable = target.is_some();
        let state = if runnable { "queued" } else { "open" };
        let completion_policy = specification
            .get("completion_policy")
            .cloned()
            .unwrap_or_else(|| {
                if runnable {
                    serde_json::json!({"kind":"evidence","required_kinds":["delivery_complete"]})
                } else {
                    serde_json::json!({"kind":"all_children_completed"})
                }
            });
        let verification = specification
            .get("verification_spec")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({"holdout_scenarios":[]}));
        let budget = specification.get("budget").cloned().unwrap_or_else(|| {
            serde_json::json!({
                "max_attempts":3,"max_continuations_per_reason":2,"max_verifier_cycles":0,
                "max_ci_retries":2,"max_execution_seconds":14400,"max_model_cost":null
            })
        });
        let branch = runnable.then(|| format!("anvil/{task_id}"));
        let parent_task_id = specification["parent_task_id"].as_str();
        if let Some(parent) = parent_task_id {
            if parent == task_id
                || !tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tasks WHERE task_id=?1)",
                    [parent],
                    |r| r.get::<_, bool>(0),
                )?
            {
                return Err(StoreError::InvalidState(
                    "parent task does not exist or is self".into(),
                ));
            }
        }
        let task = serde_json::json!({
            "task_id":task_id,"batch_id":null,"outcome":outcome,
            "acceptance_criteria":specification["acceptance_criteria"],
            "execution_target":target,"work_branch":branch,"completion_policy":completion_policy,
            "verification_spec":verification,"budget":budget,"parent_task_id":parent_task_id,
            "dependencies":[],"state":state,"version":1
        });
        tx.execute(
            "INSERT INTO tasks(task_id,batch_id,client_task_id,project,repository,prompt,state,payload_json,created_at) VALUES(?1,NULL,?1,?2,?3,?4,?5,?6,?7)",
            params![task_id,project,repository,outcome,state,serde_json::to_string(&task)?,now],
        )?;
        tx.execute(
            "INSERT INTO task_durable_state(task_id,completion_policy_json,verification_spec_json,budget_json,parent_task_id,execution_target_json,work_branch,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![task_id,serde_json::to_string(&completion_policy)?,serde_json::to_string(&verification)?,serde_json::to_string(&budget)?,parent_task_id,target.map(serde_json::to_string).transpose()?,branch,now],
        )?;
        tx.execute("INSERT INTO orchestration_resources(resource_type,resource_id,batch_id,task_id,attempt_id,payload_json,created_at,updated_at) VALUES('task',?1,NULL,?1,NULL,?2,?3,?3)", params![task_id,serde_json::to_string(&task)?,now])?;
        append_resource_change(&tx, "task", task_id, &task)?;
        tx.execute("INSERT INTO idempotency_records(idempotency_key,operation_kind,scope,request_hash,canonicalization_version,result_reference,result_json,state,created_at,updated_at) VALUES(?1,'create_task',?2,?3,?4,?5,?6,'accepted',?7,?7)",params![key,scope,hash,CANONICALIZATION_VERSION,task_id,serde_json::to_string(&task)?,now])?;
        tx.commit()?;
        Ok(TaskAcceptance {
            task,
            created: true,
        })
    }

    /// Submit a bounded task graph as one idempotent SQLite transaction. Client node
    /// keys are request-local; returned durable IDs and all edges commit together.
    pub fn accept_task_graph(
        &self,
        key: &str,
        scope: &str,
        request: &Value,
        nodes: &[(String, String, Value)],
        edges: &[(String, String)],
    ) -> Result<TaskAcceptance, StoreError> {
        if nodes.is_empty() || nodes.len() > 256 || edges.len() > 2048 {
            return Err(StoreError::InvalidState(
                "task graph exceeds configured bounds".into(),
            ));
        }
        let hash = format!("{:x}", Sha256::digest(canonical_json(request).as_bytes()));
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing=tx.query_row("SELECT operation_kind,scope,request_hash,canonicalization_version,result_json FROM idempotency_records WHERE idempotency_key=?1",[key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?))).optional()?;
        if let Some((kind, stored_scope, stored_hash, version, result)) = existing {
            if kind != "create_task_graph"
                || stored_scope != scope
                || stored_hash != hash
                || version != CANONICALIZATION_VERSION
            {
                return Err(StoreError::Conflict);
            }
            let result: Value = serde_json::from_str(&result)?;
            tx.commit()?;
            return Ok(TaskAcceptance {
                task: result,
                created: false,
            });
        }
        let ids: std::collections::HashMap<_, _> = nodes
            .iter()
            .map(|(key, id, _)| (key.clone(), id.clone()))
            .collect();
        if ids.len() != nodes.len()
            || edges
                .iter()
                .any(|(a, b)| a == b || !ids.contains_key(a) || !ids.contains_key(b))
        {
            return Err(StoreError::InvalidState(
                "graph has duplicate, self, or unknown node references".into(),
            ));
        }
        if nodes.iter().any(|(key, _, spec)| {
            spec["parent_node_key"]
                .as_str()
                .is_some_and(|parent| parent == key || !ids.contains_key(parent))
        }) {
            return Err(StoreError::InvalidState(
                "graph has a self or unknown parent node key".into(),
            ));
        }
        for (client_key, task_id, spec) in nodes {
            if tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE task_id=?1)",
                [task_id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(StoreError::Conflict);
            }
            let outcome = spec["outcome"].as_str().unwrap_or_default();
            if outcome.trim().is_empty() {
                return Err(StoreError::InvalidState(format!(
                    "node {client_key} has no outcome"
                )));
            }
            let target = spec.get("execution_target").filter(|v| !v.is_null());
            let project = target
                .and_then(|v| v["project"].as_str())
                .unwrap_or_default();
            let repository = target
                .and_then(|v| v["repository"].as_str())
                .unwrap_or_default();
            let state = if target.is_some() { "queued" } else { "open" };
            let deps: Vec<_> = edges
                .iter()
                .filter(|(_, successor)| successor == client_key)
                .filter_map(|(predecessor, _)| ids.get(predecessor))
                .cloned()
                .collect();
            let parent = spec["parent_node_key"]
                .as_str()
                .and_then(|value| ids.get(value))
                .cloned();
            let task = json!({"task_id":task_id,"batch_id":null,"node_key":client_key,"outcome":outcome,"acceptance_criteria":spec["acceptance_criteria"],"execution_target":target,"completion_policy":spec["completion_policy"],"parent_task_id":parent,"dependencies":deps,"state":state,"version":1});
            tx.execute("INSERT INTO tasks(task_id,batch_id,client_task_id,project,repository,prompt,state,payload_json,created_at) VALUES(?1,NULL,?1,?2,?3,?4,?5,?6,?7)",params![task_id,project,repository,outcome,state,serde_json::to_string(&task)?,now])?;
            let policy = spec.get("completion_policy").cloned().unwrap_or_else(|| {
                if target.is_some() {
                    json!({"kind":"evidence","required_kinds":["delivery_complete"]})
                } else {
                    json!({"kind":"all_children_completed"})
                }
            });
            let budget=spec.get("budget").cloned().unwrap_or_else(||json!({"max_attempts":3,"max_continuations_per_reason":2,"max_verifier_cycles":0,"max_ci_retries":2,"max_execution_seconds":14400,"max_model_cost":null}));
            let verification = spec
                .get("verification_spec")
                .cloned()
                .unwrap_or_else(|| json!({"holdout_scenarios":[]}));
            tx.execute("INSERT INTO task_durable_state(task_id,completion_policy_json,verification_spec_json,budget_json,execution_target_json,work_branch,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![task_id,serde_json::to_string(&policy)?,serde_json::to_string(&verification)?,serde_json::to_string(&budget)?,target.map(serde_json::to_string).transpose()?,target.map(|_|format!("anvil/{task_id}")),now])?;
            tx.execute("INSERT INTO orchestration_resources(resource_type,resource_id,batch_id,task_id,attempt_id,payload_json,created_at,updated_at) VALUES('task',?1,NULL,?1,NULL,?2,?3,?3)",params![task_id,serde_json::to_string(&task)?,now])?;
            append_resource_change(&tx, "task", task_id, &task)?;
        }
        for (_client_key, task_id, spec) in nodes {
            if let Some(parent_id) = spec["parent_node_key"]
                .as_str()
                .and_then(|parent| ids.get(parent))
            {
                tx.execute(
                    "UPDATE task_durable_state SET parent_task_id=?2 WHERE task_id=?1",
                    params![task_id, parent_id],
                )?;
            }
        }
        for (predecessor, successor) in edges {
            tx.execute("INSERT INTO task_dependencies(predecessor_task_id,successor_task_id) VALUES(?1,?2)",params![ids[predecessor],ids[successor]])?;
        }
        let dependency_cycle:i64=tx.query_row("WITH RECURSIVE reach(start,node) AS (SELECT predecessor_task_id,successor_task_id FROM task_dependencies UNION SELECT r.start,d.successor_task_id FROM reach r JOIN task_dependencies d ON d.predecessor_task_id=r.node) SELECT EXISTS(SELECT 1 FROM reach WHERE start=node)",[],|r|r.get(0))?;
        let parent_cycle:i64=tx.query_row("WITH RECURSIVE chain(start,node) AS (SELECT task_id,parent_task_id FROM task_durable_state WHERE parent_task_id IS NOT NULL UNION SELECT c.start,s.parent_task_id FROM chain c JOIN task_durable_state s ON s.task_id=c.node WHERE s.parent_task_id IS NOT NULL) SELECT EXISTS(SELECT 1 FROM chain WHERE start=node)",[],|r|r.get(0))?;
        if dependency_cycle != 0 || parent_cycle != 0 {
            return Err(StoreError::InvalidState(
                "task graph contains a cycle".into(),
            ));
        }
        let result = json!({"tasks":nodes.iter().map(|(client,id,_)|json!({"node_key":client,"task_id":id})).collect::<Vec<_>>()});
        tx.execute("INSERT INTO idempotency_records(idempotency_key,operation_kind,scope,request_hash,canonicalization_version,result_reference,result_json,state,created_at,updated_at) VALUES(?1,'create_task_graph',?2,?3,?4,?5,?6,'accepted',?7,?7)",params![key,scope,hash,CANONICALIZATION_VERSION,key,serde_json::to_string(&result)?,now])?;
        tx.commit()?;
        Ok(TaskAcceptance {
            task: result,
            created: true,
        })
    }

    /// Read the durable controller ownership/version tuple. The scheduler remains
    /// the capacity authority; this row fences future controller ownership changes.
    pub fn task_control(&self, task_id: &str) -> Result<Option<Value>, StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        connection.query_row(
            "SELECT version,operator_hold,controller_mode,reconcile_generation,parent_task_id,
                    execution_target_json,work_branch,pull_request_binding_json,base_revision,
                    completion_policy_json,verification_spec_json,budget_json,terminal_json,retry_due_ms
             FROM task_durable_state WHERE task_id=?1",
            [task_id],
            |row| Ok(serde_json::json!({
                "version":row.get::<_,i64>(0)?, "operator_hold":row.get::<_,bool>(1)?,
                "controller_mode":row.get::<_,String>(2)?, "reconcile_generation":row.get::<_,i64>(3)?,
                "parent_task_id":row.get::<_,Option<String>>(4)?,
                "execution_target":row.get::<_,Option<String>>(5)?, "work_branch":row.get::<_,Option<String>>(6)?,
                "pull_request_binding":row.get::<_,Option<String>>(7)?, "base_revision":row.get::<_,Option<String>>(8)?,
                "completion_policy":row.get::<_,String>(9)?, "verification_spec":row.get::<_,String>(10)?,
                "budget":row.get::<_,String>(11)?, "terminal":row.get::<_,Option<String>>(12)?,
                "retry_due_ms":row.get::<_,Option<i64>>(13)?
            })),
        ).optional().map_err(StoreError::from)
    }

    pub fn task_page(
        &self,
        after: i64,
        limit: usize,
    ) -> Result<(Vec<Value>, Option<i64>), StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let mut statement = connection.prepare(
            "SELECT rowid,payload_json FROM tasks WHERE rowid>?1 ORDER BY rowid LIMIT ?2",
        )?;
        let rows = statement.query_map(params![after, limit.clamp(1, 100) as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut values = Vec::new();
        let mut cursor = None;
        for row in rows {
            let (sequence, json) = row?;
            cursor = Some(sequence);
            values.push(serde_json::from_str(&json)?);
        }
        Ok((values, cursor))
    }

    /// Reserve a durable per-Task/key sequence before a provider request starts.
    pub fn reserve_observation_sequence(
        &self,
        task_id: &str,
        key: &str,
    ) -> Result<u64, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO task_observation_sequences(task_id,key,next_sequence) VALUES(?1,?2,2) ON CONFLICT(task_id,key) DO UPDATE SET next_sequence=next_sequence+1",params![task_id,key])?;
        let next: i64 = tx.query_row(
            "SELECT next_sequence-1 FROM task_observation_sequences WHERE task_id=?1 AND key=?2",
            params![task_id, key],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(next as u64)
    }

    /// Persist a collected fact. Arrival order cannot let an older in-flight
    /// collection replace the current value; same-sequence disagreement is invalid.
    pub fn record_observation(
        &self,
        observation_id: &str,
        task_id: &str,
        key: &str,
        value: &Value,
        provenance: &str,
        collection_seq: u64,
        expires_at: Option<&str>,
    ) -> Result<(), StoreError> {
        if !matches!(provenance, "runtime" | "platform" | "external" | "agent") {
            return Err(StoreError::InvalidState(
                "invalid observation provenance".into(),
            ));
        }
        let canonical = canonical_json(value);
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let reserved: Option<i64> = tx
            .query_row(
                "SELECT next_sequence FROM task_observation_sequences WHERE task_id=?1 AND key=?2",
                params![task_id, key],
                |r| r.get(0),
            )
            .optional()?;
        if reserved.is_none_or(|next| collection_seq as i64 >= next) {
            return Err(StoreError::InvalidState(
                "observation sequence was not reserved".into(),
            ));
        }
        let same:Option<String>=tx.query_row("SELECT value_json FROM task_observations WHERE task_id=?1 AND key=?2 AND collection_seq=?3",params![task_id,key,collection_seq as i64],|r|r.get(0)).optional()?;
        if let Some(existing) = same {
            if canonical_json(&serde_json::from_str::<Value>(&existing)?) != canonical {
                return Err(StoreError::InvalidState(
                    "same collection sequence has conflicting value".into(),
                ));
            }
            tx.commit()?;
            return Ok(());
        }
        let latest_id: Option<String> = tx
            .query_row(
                "SELECT observation_id FROM task_observation_current WHERE task_id=?1 AND key=?2",
                params![task_id, key],
                |r| r.get(0),
            )
            .optional()?;
        let version: i64 = latest_id
            .as_ref()
            .map(|id| {
                tx.query_row(
                    "SELECT version FROM task_observations WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
            })
            .transpose()?
            .unwrap_or(0)
            + 1;
        tx.execute("INSERT INTO task_observations(id,task_id,key,value_json,provenance,observed_at,recorded_at,version,collection_seq,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![observation_id,task_id,key,serde_json::to_string(value)?,provenance,now,chrono::Utc::now().to_rfc3339(),version,collection_seq as i64,expires_at])?;
        tx.execute("INSERT INTO task_observation_current(task_id,key,observation_id) VALUES(?1,?2,?3) ON CONFLICT(task_id,key) DO UPDATE SET observation_id=excluded.observation_id WHERE (SELECT collection_seq FROM task_observations WHERE id=task_observation_current.observation_id)<(SELECT collection_seq FROM task_observations WHERE id=excluded.observation_id)",params![task_id,key,observation_id])?;
        tx.commit()?;
        Ok(())
    }

    /// The single compatibility completion boundary for Legacy scheduler exits and
    /// future trusted observers. Completion is policy-evaluated and Task-CAS fenced.
    pub fn complete_task(
        &self,
        task_id: &str,
        expected_version: u64,
        evidence_ids: &[String],
    ) -> Result<Value, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (task_json,state,version,policy_json):(String,String,i64,String)=tx.query_row(
            "SELECT t.payload_json,t.state,d.version,d.completion_policy_json FROM tasks t JOIN task_durable_state d USING(task_id) WHERE task_id=?1",
            [task_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional()?.ok_or(StoreError::NotFound)?;
        if matches!(
            state.as_str(),
            "completed" | "canceled" | "obviated" | "superseded" | "failed_exhausted"
        ) {
            return Err(StoreError::InvalidState(
                "terminal Task state is immutable".into(),
            ));
        }
        if version as u64 != expected_version {
            return Err(StoreError::Conflict);
        }
        let policy: anvil_core::CompletionPolicy = serde_json::from_str(&policy_json)?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut refs = Vec::new();
        let mut trusted = Vec::new();
        for id in evidence_ids {
            let row:Option<(String,String,i64,Option<String>)>=tx.query_row("SELECT o.key,o.provenance,o.version,o.expires_at FROM task_observations o JOIN task_observation_current c ON c.observation_id=o.id WHERE o.id=?1 AND o.task_id=?2",params![id,task_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            let Some((key, provenance, obs_version, expires_at)) = row else {
                continue;
            };
            if provenance == "agent"
                || expires_at
                    .as_deref()
                    .is_some_and(|deadline| deadline <= now.as_str())
            {
                continue;
            }
            let kind = match key.rsplit('.').next().unwrap_or(key.as_str()) {
                "legacy_scheduler_exit" => anvil_core::EvidenceKind::LegacySchedulerExit,
                "delivery_complete" => anvil_core::EvidenceKind::DeliveryComplete,
                "deterministic_verification" => anvil_core::EvidenceKind::DeterministicVerification,
                "manual_completion" => anvil_core::EvidenceKind::ManualCompletion,
                _ => continue,
            };
            let reference = anvil_core::ObservationRef {
                id: id.clone(),
                version: obs_version as u64,
                kind,
            };
            let source = match provenance.as_str() {
                "runtime" => anvil_core::ObservationProvenance::Runtime,
                "platform" => anvil_core::ObservationProvenance::Platform,
                "external" => anvil_core::ObservationProvenance::External,
                _ => anvil_core::ObservationProvenance::Agent,
            };
            if let Ok(item) =
                anvil_core::TrustedEvidence::from_observation(reference.clone(), source)
            {
                trusted.push(item);
                refs.push(reference);
            }
        }
        let children: Vec<anvil_core::TaskTerminal> = {
            let mut stmt=tx.prepare("SELECT t.state,d.terminal_json FROM tasks t JOIN task_durable_state d USING(task_id) WHERE d.parent_task_id=?1 ORDER BY t.task_id")?;
            let rows = stmt.query_map([task_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            let mut result = Vec::new();
            for row in rows {
                let (state, raw) = row?;
                let terminal = raw
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or_else(|| match state.as_str() {
                        "canceled" => anvil_core::TaskTerminal::Canceled {
                            actor: "unknown".into(),
                            reason: "legacy terminal state".into(),
                        },
                        "obviated" => anvil_core::TaskTerminal::Obviated {
                            reason: "legacy terminal state".into(),
                        },
                        "superseded" => anvil_core::TaskTerminal::Superseded {
                            by_task_id: String::new(),
                        },
                        "failed_exhausted" => anvil_core::TaskTerminal::FailedExhausted {
                            attempt_budget: 0,
                            last_failure: None,
                        },
                        _ => anvil_core::TaskTerminal::Canceled {
                            actor: "system".into(),
                            reason: "child is not completed".into(),
                        },
                    });
                result.push(terminal);
            }
            result
        };
        if !anvil_core::completion_policy_satisfied(&policy, &trusted, &children) {
            return Err(StoreError::InvalidState(
                "completion policy is not satisfied by fresh trusted evidence".into(),
            ));
        }
        let terminal = anvil_core::TaskTerminal::Completed { evidence: refs };
        let terminal_json = serde_json::to_string(&terminal)?;
        let mut task: Value = serde_json::from_str(&task_json)?;
        task["state"] = Value::String("completed".into());
        task["terminal"] = serde_json::to_value(&terminal)?;
        task["version"] = serde_json::json!(expected_version + 1);
        let encoded = serde_json::to_string(&task)?;
        let changed=tx.execute("UPDATE task_durable_state SET version=version+1,terminal_json=?3,updated_at=?4 WHERE task_id=?1 AND version=?2",params![task_id,expected_version as i64,terminal_json,now])?;
        if changed != 1 {
            return Err(StoreError::Conflict);
        }
        tx.execute(
            "UPDATE tasks SET state='completed',payload_json=?2 WHERE task_id=?1",
            params![task_id, encoded],
        )?;
        tx.execute("UPDATE orchestration_resources SET payload_json=?2,updated_at=?3 WHERE resource_type='task' AND resource_id=?1",params![task_id,encoded,now])?;
        append_resource_change(&tx, "task", task_id, &task)?;
        tx.commit()?;
        Ok(task)
    }

    /// Persist a typed non-success terminal before any best-effort runtime shutdown.
    pub fn terminate_task(
        &self,
        task_id: &str,
        expected_version: u64,
        terminal: anvil_core::TaskTerminal,
    ) -> Result<Value, StoreError> {
        let state = match &terminal {
            anvil_core::TaskTerminal::Canceled { .. } => "canceled",
            anvil_core::TaskTerminal::Obviated { .. } => "obviated",
            anvil_core::TaskTerminal::Superseded { .. } => "superseded",
            anvil_core::TaskTerminal::FailedExhausted { .. } => "failed_exhausted",
            anvil_core::TaskTerminal::Completed { .. } => {
                return Err(StoreError::InvalidState(
                    "Completed requires trusted completion-policy evaluation".into(),
                ));
            }
        };
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let raw:Option<(String,String,i64)>=tx.query_row("SELECT t.payload_json,t.state,d.version FROM tasks t JOIN task_durable_state d USING(task_id) WHERE task_id=?1",[task_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (raw, old_state, version) = raw.ok_or(StoreError::NotFound)?;
        if version as u64 != expected_version {
            return Err(StoreError::Conflict);
        }
        if matches!(
            old_state.as_str(),
            "completed" | "canceled" | "obviated" | "superseded" | "failed_exhausted"
        ) {
            return Err(StoreError::InvalidState(
                "terminal Task state is immutable".into(),
            ));
        }
        let terminal_json = serde_json::to_string(&terminal)?;
        let mut task: Value = serde_json::from_str(&raw)?;
        task["state"] = Value::String(state.into());
        task["terminal"] = serde_json::to_value(&terminal)?;
        task["version"] = serde_json::json!(expected_version + 1);
        let encoded = serde_json::to_string(&task)?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed=tx.execute("UPDATE task_durable_state SET version=version+1,terminal_json=?3,updated_at=?4 WHERE task_id=?1 AND version=?2",params![task_id,expected_version as i64,terminal_json,now])?;
        if changed != 1 {
            return Err(StoreError::Conflict);
        }
        tx.execute(
            "UPDATE tasks SET state=?2,payload_json=?3 WHERE task_id=?1",
            params![task_id, state, encoded],
        )?;
        tx.execute("UPDATE orchestration_resources SET payload_json=?2,updated_at=?3 WHERE resource_type='task' AND resource_id=?1",params![task_id,encoded,now])?;
        append_resource_change(&tx, "task", task_id, &task)?;
        tx.commit()?;
        Ok(task)
    }

    /// Construct bounded decision input using a single SQLite read transaction.
    pub fn task_snapshot(
        &self,
        task_id: &str,
        logical_time: i64,
    ) -> Result<Option<Value>, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let task: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM tasks WHERE task_id=?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(task_json) = task else {
            tx.commit()?;
            return Ok(None);
        };
        let task: Value = serde_json::from_str(&task_json)?;
        let control: (i64,bool,String,i64,String,String,String,Option<i64>,Option<String>,Option<String>,Option<String>) = tx.query_row(
            "SELECT version,operator_hold,controller_mode,reconcile_generation,completion_policy_json,budget_json,verification_spec_json,retry_due_ms,execution_target_json,work_branch,pull_request_binding_json FROM task_durable_state WHERE task_id=?1",
            [task_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?)),
        )?;
        let dependencies: Vec<Value> = {
            let mut stmt=tx.prepare("SELECT predecessor_task_id,t.state FROM task_dependencies d JOIN tasks t ON t.task_id=d.predecessor_task_id WHERE d.successor_task_id=?1 ORDER BY d.predecessor_task_id")?;
            let rows = stmt.query_map([task_id],|row|Ok(serde_json::json!({"task_id":row.get::<_,String>(0)?,"state":row.get::<_,String>(1)?})))?.collect::<Result<_,_>>()?;
            rows
        };
        let children: Vec<Value> = {
            let mut stmt=tx.prepare("SELECT task_id,state FROM tasks WHERE json_extract(payload_json,'$.parent_task_id')=?1 ORDER BY task_id LIMIT 256")?;
            let rows = stmt.query_map([task_id],|row|Ok(serde_json::json!({"task_id":row.get::<_,String>(0)?,"state":row.get::<_,String>(1)?})))?.collect::<Result<_,_>>()?;
            rows
        };
        let attempts: Vec<Value> = {
            let mut stmt = tx.prepare(
                "SELECT payload_json FROM attempts WHERE task_id=?1 ORDER BY ordinal DESC LIMIT 16",
            )?;
            let rows = stmt.query_map([task_id], |row| row.get::<_, String>(0))?
                .map(|r| Ok(serde_json::from_str(&r?)?))
                .collect::<Result<_, StoreError>>()?;
            rows
        };
        let active: Vec<Value> = attempts
            .iter()
            .filter(|a| {
                !matches!(
                    a["state"].as_str(),
                    Some(
                        "ended"
                            | "completed"
                            | "failed"
                            | "canceled"
                            | "abandoned"
                            | "orphaned"
                            | "replaced"
                            | "exhausted"
                    )
                )
            })
            .cloned()
            .collect();
        let blocker: Option<Value> = tx.query_row("SELECT json_object('id',blocker_id,'attempt_id',attempt_id,'question',question,'context',context,'version',version) FROM task_blockers WHERE task_id=?1 AND resolution_json IS NULL",[task_id],|row|row.get::<_,String>(0)).optional()?.map(|v|serde_json::from_str(&v)).transpose()?;
        let observations: Vec<Value> = {
            let mut stmt=tx.prepare("SELECT o.id,o.key,o.value_json,o.provenance,o.observed_at,o.recorded_at,o.version,o.collection_seq,o.expires_at FROM task_observation_current c JOIN task_observations o ON o.id=c.observation_id WHERE c.task_id=?1 ORDER BY o.key LIMIT 128")?;
            let rows = stmt.query_map([task_id],|row|Ok(serde_json::json!({"id":row.get::<_,String>(0)?,"key":row.get::<_,String>(1)?,"value":serde_json::from_str::<Value>(&row.get::<_,String>(2)?).unwrap_or(Value::Null),"provenance":row.get::<_,String>(3)?,"observed_at":row.get::<_,String>(4)?,"recorded_at":row.get::<_,String>(5)?,"version":row.get::<_,i64>(6)?,"collection_seq":row.get::<_,i64>(7)?,"expires_at":row.get::<_,Option<String>>(8)?})))?.collect::<Result<_,_>>()?;
            rows
        };
        let attempt_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM attempts WHERE task_id=?1",
            [task_id],
            |row| row.get(0),
        )?;
        let grants: String=tx.query_row("SELECT json_object('attempts',COALESCE(SUM(additional_attempts),0),'continuations',COALESCE(SUM(additional_continuations),0),'ci_retries',COALESCE(SUM(additional_ci_retries),0),'execution_seconds',COALESCE(SUM(additional_execution_seconds),0)) FROM task_budget_grants WHERE task_id=?1",[task_id],|row|row.get(0))?;
        let mode = control.2;
        let controller_mode = match mode.as_str() {
            "shadow" => "shadow",
            "reconciler" => "reconciler",
            _ => "legacy",
        };
        let has_execution_target = control.8.is_some();
        let dependencies_unresolved = dependencies
            .iter()
            .any(|item| item["state"] != "completed" && item["state"] != "succeeded");
        let phase = anvil_core::derive_task_phase(
            task["state"].as_str().unwrap_or("open"),
            blocker.is_some() || dependencies_unresolved,
            !active.is_empty(),
            has_execution_target,
        );
        let snapshot = serde_json::json!({
            "schema_version":1,"task_id":task_id,"task_version":control.0,"logical_time_ms":logical_time,
            "lifecycle":{"state":if matches!(task["state"].as_str(),Some("completed"|"canceled"|"obviated"|"superseded"|"failed_exhausted")) {"terminal"} else {"open"},"terminal":task["terminal"]},"completion_policy":serde_json::from_str::<Value>(&control.4)?,
            "operator_hold":control.1,"controller_mode":controller_mode,"reconcile_generation":control.3,
            "execution_target":control.8.as_deref().map(serde_json::from_str::<Value>).transpose()? ,"delivery":{"work_branch":control.9,"pull_request":control.10,"base_revision":null,"pr_head_sha":null,"evaluation_sha":null,"evaluation_kind":null,"pr_state":null,"required_checks":[]},
            "dependencies":{"all_completed":!dependencies_unresolved,"predecessors":dependencies},"children":{"total":children.len(),"completed":children.iter().filter(|c|c["state"]=="completed").count(),"terminal_noncompleted":children.iter().filter(|c|c["state"]!="completed"&&matches!(c["state"].as_str(),Some("canceled"|"obviated"|"superseded"|"failed_exhausted"))).count()},
            "attempts":attempts,"blocker":blocker,"observations":observations,
            "action_history":{"recent":[]},"budget_usage":{"attempt_count":attempt_count,"grants":serde_json::from_str::<Value>(&grants)?,"spec":serde_json::from_str::<Value>(&control.5)?},
            "retry_schedule":{"due_at_ms":control.7},"verification_spec":serde_json::from_str::<Value>(&control.6)?,"phase":phase
        });
        tx.commit()?;
        Ok(Some(snapshot))
    }

    /// Compare-and-swap the mutable controller fields. Immutable task intent is
    /// deliberately not exposed through this mutation.
    pub fn set_task_control(
        &self,
        task_id: &str,
        expected_version: u64,
        operator_hold: bool,
        controller_mode: &str,
    ) -> Result<u64, StoreError> {
        if !matches!(controller_mode, "legacy" | "shadow" | "reconciler") {
            return Err(StoreError::InvalidState(controller_mode.to_owned()));
        }
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE task_durable_state SET version=version+1,operator_hold=?3,controller_mode=?4,
                 reconcile_generation=reconcile_generation+CASE WHEN controller_mode<>?4 THEN 1 ELSE 0 END,
                 updated_at=?5 WHERE task_id=?1 AND version=?2",
            params![task_id, expected_version as i64, operator_hold, controller_mode, chrono::Utc::now().to_rfc3339()],
        )?;
        if changed != 1 {
            return Err(StoreError::Conflict);
        }
        let payload: String = tx.query_row(
            "SELECT payload_json FROM tasks WHERE task_id=?1",
            [task_id],
            |row| row.get(0),
        )?;
        let mut task: Value = serde_json::from_str(&payload)?;
        task["version"] = serde_json::json!(expected_version + 1);
        task["operator_hold"] = serde_json::json!(operator_hold);
        task["controller_mode"] = serde_json::json!(controller_mode);
        let encoded = serde_json::to_string(&task)?;
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE tasks SET payload_json=?2 WHERE task_id=?1",
            params![task_id, encoded],
        )?;
        tx.execute("UPDATE orchestration_resources SET payload_json=?2,updated_at=?3 WHERE resource_type='task' AND resource_id=?1", params![task_id, encoded, now])?;
        append_resource_change(&tx, "task", task_id, &task)?;
        tx.commit()?;
        Ok(expected_version + 1)
    }

    pub fn grant_task_budget(
        &self,
        task_id: &str,
        expected_version: u64,
        actor: &str,
        reason: &str,
        attempts: u32,
        continuations: u32,
        ci_retries: u32,
        execution_seconds: u64,
    ) -> Result<u64, StoreError> {
        if actor.trim().is_empty()
            || reason.trim().is_empty()
            || (attempts == 0 && continuations == 0 && ci_retries == 0 && execution_seconds == 0)
        {
            return Err(StoreError::InvalidState(
                "budget grant requires an actor, reason, and positive allocation".into(),
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let grant_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let changed=tx.execute("UPDATE task_durable_state SET version=version+1,updated_at=?3 WHERE task_id=?1 AND version=?2",params![task_id,expected_version as i64,now])?;
        if changed != 1 {
            return Err(StoreError::Conflict);
        }
        tx.execute("INSERT INTO task_budget_grants(grant_id,task_id,actor_json,reason,additional_attempts,additional_continuations,additional_ci_retries,additional_execution_seconds,recorded_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![grant_id,task_id,serde_json::json!({"kind":"operator","id":actor}).to_string(),reason,attempts,continuations,ci_retries,execution_seconds,now])?;
        let payload: String = tx.query_row(
            "SELECT payload_json FROM tasks WHERE task_id=?1",
            [task_id],
            |r| r.get(0),
        )?;
        let mut task: Value = serde_json::from_str(&payload)?;
        task["version"] = serde_json::json!(expected_version + 1);
        let encoded = serde_json::to_string(&task)?;
        tx.execute(
            "UPDATE tasks SET payload_json=?2 WHERE task_id=?1",
            params![task_id, encoded],
        )?;
        tx.execute("UPDATE orchestration_resources SET payload_json=?2,updated_at=?3 WHERE resource_type='task' AND resource_id=?1",params![task_id,encoded,now])?;
        append_resource_change(&tx, "task", task_id, &task)?;
        tx.commit()?;
        Ok(expected_version + 1)
    }

    /// Create the next durable execution attempt for an already accepted logical task.
    pub fn create_attempt(
        &self,
        task_id: &str,
        attempt_id: &str,
        idempotency_key: &str,
    ) -> Result<AttemptAcceptance, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let acceptance = create_attempt_tx(&tx, task_id, attempt_id, idempotency_key)?;
        tx.commit()?;
        Ok(acceptance)
    }

    pub fn get_attempt_submission(&self, key: &str) -> Result<Option<Value>, StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let payload = connection
            .query_row(
                "SELECT attempts.payload_json FROM attempt_submissions JOIN attempts ON attempts.attempt_id=attempt_submissions.attempt_id WHERE attempt_submissions.idempotency_key=?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        payload
            .map(|payload| serde_json::from_str(&payload).map_err(StoreError::from))
            .transpose()
    }

    pub fn attempts_for_task(&self, task_id: &str) -> Result<Vec<Value>, StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let mut statement = connection
            .prepare("SELECT payload_json FROM attempts WHERE task_id=?1 ORDER BY ordinal")?;
        let values = statement.query_map([task_id], |row| row.get::<_, String>(0))?;
        values
            .map(|value| Ok(serde_json::from_str(&value?)?))
            .collect()
    }

    pub fn tasks_for_session(&self, session_id: &str) -> Result<Vec<(String, String)>, StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let mut statement = connection.prepare(
            "SELECT a.task_id,t.batch_id FROM orchestration_resources a
             JOIN orchestration_resources t ON t.resource_type='task' AND t.resource_id=a.task_id
             WHERE a.resource_type='attempt' AND json_extract(a.payload_json,'$.session_id')=?1",
        )?;
        let rows = statement.query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn bind_attempt_session(
        &self,
        attempt_id: &str,
        session_id: &str,
    ) -> Result<Value, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let json: Option<String> = tx
            .query_row(
                "SELECT payload_json FROM attempts WHERE attempt_id=?1",
                [attempt_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(json) = json else {
            return Err(StoreError::NotFound);
        };
        let mut attempt: Value = serde_json::from_str(&json)?;
        attempt["session_id"] = Value::String(session_id.to_owned());
        attempt["state"] = Value::String("provisioning".into());
        attempt["lifecycle"] = Value::String("provisioning".into());
        attempt["exit_reason"] = Value::Null;
        let version: i64 = tx.query_row(
            "SELECT version+1 FROM attempts WHERE attempt_id=?1",
            [attempt_id],
            |row| row.get(0),
        )?;
        attempt["version"] = serde_json::json!(version);
        tx.execute(
            "UPDATE attempts SET session_id=?2,payload_json=?3,version=?4 WHERE attempt_id=?1 AND version=?4-1",
            params![attempt_id, session_id, serde_json::to_string(&attempt)?, version],
        )?;
        tx.execute("UPDATE orchestration_resources SET payload_json=?2,updated_at=?3 WHERE resource_type='attempt' AND resource_id=?1", params![attempt_id,serde_json::to_string(&attempt)?,chrono::Utc::now().to_rfc3339()])?;
        append_resource_change(&tx, "attempt", attempt_id, &attempt)?;
        tx.commit()?;
        Ok(attempt)
    }

    pub fn get(&self, key: &str) -> Result<Option<AcceptedResult>, StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let row = connection.query_row("SELECT operation_kind, scope, result_reference, result_json, state, created_at, updated_at FROM idempotency_records WHERE idempotency_key=?1", [key], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?))).optional()?;
        row.map(
            |(operation_kind, scope, result_reference, result, state, created_at, updated_at)| {
                Ok(AcceptedResult {
                    idempotency_key: key.into(),
                    operation_kind,
                    scope,
                    result_reference,
                    result: serde_json::from_str(&result)?,
                    state: parse_state(&state)?,
                    created_at,
                    updated_at,
                })
            },
        )
        .transpose()
    }

    /// Complete an accepted operation without changing its immutable request/result binding.
    pub fn mark_completed(&self, key: &str) -> Result<AcceptedResult, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute("UPDATE idempotency_records SET state='completed', updated_at=?2 WHERE idempotency_key=?1 AND state='accepted'", params![key, chrono::Utc::now().to_rfc3339()])?;
        if changed == 0
            && tx
                .query_row(
                    "SELECT state FROM idempotency_records WHERE idempotency_key=?1",
                    [key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .is_none()
        {
            return Err(StoreError::NotFound);
        }
        let record = read_result(&tx, key)?.ok_or(StoreError::NotFound)?;
        tx.commit()?;
        Ok(record)
    }

    /// Persist the authoritative HTTP result after an accepted operation finishes.
    pub fn set_result(
        &self,
        key: &str,
        result_reference: &str,
        result: &Value,
    ) -> Result<(), StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let changed = connection.execute(
            "UPDATE idempotency_records SET result_reference=?2, result_json=?3, updated_at=?4 WHERE idempotency_key=?1 AND state='accepted'",
            params![key, result_reference, serde_json::to_string(result)?, chrono::Utc::now().to_rfc3339()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

/// Shared canonical Attempt acceptance used by both the public idempotent API
/// and atomic scheduler claims. Caller owns and commits the surrounding txn.
pub(super) fn create_attempt_tx(
    tx: &Transaction<'_>,
    task_id: &str,
    attempt_id: &str,
    idempotency_key: &str,
) -> Result<AttemptAcceptance, StoreError> {
    let replay: Option<(String, String)> = tx
        .query_row(
            "SELECT task_id,attempt_id FROM attempt_submissions WHERE idempotency_key=?1",
            [idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((bound_task, bound_attempt)) = replay {
        if bound_task != task_id {
            return Err(StoreError::Conflict);
        }
        let json: String = tx.query_row(
            "SELECT payload_json FROM attempts WHERE attempt_id=?1",
            [bound_attempt],
            |row| row.get(0),
        )?;
        return Ok(AttemptAcceptance {
            attempt: serde_json::from_str(&json)?,
            created: false,
        });
    }
    let task: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM tasks WHERE task_id=?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(task) = task else {
        return Err(StoreError::NotFound);
    };
    let ordinal: i64 = tx.query_row(
        "SELECT COALESCE(MAX(ordinal),0)+1 FROM attempts WHERE task_id=?1",
        [task_id],
        |row| row.get(0),
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    let attempt = serde_json::json!({"attempt_id":attempt_id,"task_id":task_id,"ordinal":ordinal,"version":1,"role":"implementation","session_id":null,"state":"queued","lifecycle":"queued","exit_reason":null,"created_at":now});
    tx.execute("INSERT INTO attempts(attempt_id,task_id,ordinal,session_id,payload_json,created_at,version) VALUES(?1,?2,?3,NULL,?4,?5,1)", params![attempt_id,task_id,ordinal,serde_json::to_string(&attempt)?,now])?;
    tx.execute(
        "INSERT INTO attempt_submissions(idempotency_key,task_id,attempt_id) VALUES(?1,?2,?3)",
        params![idempotency_key, task_id, attempt_id],
    )?;
    tx.execute("INSERT INTO orchestration_resources(resource_type,resource_id,batch_id,task_id,attempt_id,payload_json,created_at,updated_at) SELECT 'attempt',?1,batch_id,?2,?1,?3,?4,?4 FROM orchestration_resources WHERE resource_type='task' AND resource_id=?2", params![attempt_id,task_id,serde_json::to_string(&attempt)?,now])?;
    append_resource_change(tx, "attempt", attempt_id, &attempt)?;
    let mut task: Value = serde_json::from_str(&task)?;
    let task_version:i64=tx.query_row("UPDATE task_durable_state SET version=version+1,updated_at=?2 WHERE task_id=?1 RETURNING version",params![task_id,now],|row|row.get(0))?;
    task["version"] = serde_json::json!(task_version);
    let task_payload = serde_json::to_string(&task)?;
    tx.execute(
        "UPDATE tasks SET payload_json=?2 WHERE task_id=?1",
        params![task_id, task_payload],
    )?;
    tx.execute("UPDATE orchestration_resources SET payload_json=?2,updated_at=?3 WHERE resource_type='task' AND resource_id=?1",params![task_id,task_payload,now])?;
    append_resource_change(tx, "task", task_id, &task)?;
    Ok(AttemptAcceptance {
        attempt,
        created: true,
    })
}

/// Default active-work uniqueness is scoped to project, repository, frozen base,
/// prompt, dependency/ownership metadata, and policy. Same prompt on a different
/// base or under a different contract is distinct work.
fn same_logical_work(left: &Value, right: &Value) -> bool {
    [
        "project",
        "repository",
        "base_commit",
        "prompt",
        "dependencies",
        "owner",
        "policy",
        "pr_policy",
        "evidence_contract",
        "batch_policies",
    ]
    .into_iter()
    .all(|field| canonical_json(&left[field]) == canonical_json(&right[field]))
}

fn parse_state(state: &str) -> Result<IdempotencyState, StoreError> {
    match state {
        "accepted" => Ok(IdempotencyState::Accepted),
        "completed" => Ok(IdempotencyState::Completed),
        _ => Err(StoreError::InvalidState(state.to_owned())),
    }
}

fn read_result(connection: &Connection, key: &str) -> Result<Option<AcceptedResult>, StoreError> {
    let row = connection.query_row("SELECT operation_kind, scope, result_reference, result_json, state, created_at, updated_at FROM idempotency_records WHERE idempotency_key=?1", [key], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?))).optional()?;
    row.map(
        |(operation_kind, scope, result_reference, result, state, created_at, updated_at)| {
            Ok(AcceptedResult {
                idempotency_key: key.into(),
                operation_kind,
                scope,
                result_reference,
                result: serde_json::from_str(&result)?,
                state: parse_state(&state)?,
                created_at,
                updated_at,
            })
        },
    )
    .transpose()
}

fn append_resource_change(
    tx: &rusqlite::Transaction<'_>,
    resource_type: &str,
    resource_id: &str,
    record: &Value,
) -> Result<(), StoreError> {
    let change = serde_json::json!({"deleted":false,"record":record});
    tx.execute(
        "INSERT INTO orchestration_changes(resource_type,resource_id,payload_json) VALUES(?1,?2,?3)",
        params![resource_type, resource_id, serde_json::to_string(&change)?],
    )?;
    let sequence = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO orchestration_materializations(resource_type,resource_id,payload_json,last_sequence)
         VALUES(?1,?2,?3,?4)
         ON CONFLICT(resource_type,resource_id) DO UPDATE SET payload_json=excluded.payload_json,last_sequence=excluded.last_sequence",
        params![resource_type, resource_id, serde_json::to_string(record)?, sequence],
    )?;
    Ok(())
}

fn migrate(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);")?;
    // SQLite only permits changing foreign-key enforcement outside a transaction.
    // Migration 10 rebuilds tasks to make Batch membership genuinely optional;
    // the copy is checked before enforcement is restored below.
    connection.execute_batch("PRAGMA foreign_keys=OFF;")?;
    let tx = connection.unchecked_transaction()?;
    let mut version: i64 = tx.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if version < 1 {
        tx.execute_batch("CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY, operation_kind TEXT NOT NULL, scope TEXT NOT NULL, request_hash TEXT NOT NULL, canonicalization_version INTEGER NOT NULL, result_reference TEXT NOT NULL, result_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX idempotency_by_scope ON idempotency_records(scope, operation_kind);
        -- Reserved indexed identity slots for future Batch/Task/Attempt records.
        CREATE TABLE orchestration_resources (resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, batch_id TEXT, task_id TEXT, attempt_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(resource_type, resource_id));
        CREATE INDEX orchestration_by_batch ON orchestration_resources(batch_id);
        CREATE INDEX orchestration_by_task ON orchestration_resources(task_id);
        CREATE INDEX orchestration_by_attempt ON orchestration_resources(attempt_id);")?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        version = 1;
    }
    if version < 2 {
        // v1 allowed only accepted records. Rebuild transactionally to expand the state contract.
        tx.execute_batch("CREATE TABLE idempotency_records_v2 (idempotency_key TEXT PRIMARY KEY, operation_kind TEXT NOT NULL, scope TEXT NOT NULL, request_hash TEXT NOT NULL, canonicalization_version INTEGER NOT NULL, result_reference TEXT NOT NULL, result_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted','completed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO idempotency_records_v2 SELECT idempotency_key, operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at FROM idempotency_records;
        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_v2 RENAME TO idempotency_records;
        CREATE INDEX idempotency_by_scope ON idempotency_records(scope, operation_kind);")?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        version = 2;
    }
    if version < 3 {
        tx.execute_batch("CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, session_id TEXT UNIQUE, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, ordinal)); CREATE INDEX attempts_by_task ON attempts(task_id);")?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        version = 3;
    }
    if version < 4 {
        tx.execute_batch("CREATE TABLE batches (batch_id TEXT PRIMARY KEY, project TEXT NOT NULL, repository TEXT NOT NULL, requested_revision TEXT NOT NULL, base_commit TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE tasks (task_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(batch_id), client_task_id TEXT NOT NULL, project TEXT NOT NULL, repository TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX tasks_by_batch ON tasks(batch_id); CREATE INDEX active_logical_tasks ON tasks(project,repository,prompt,state); CREATE TABLE attempts_v4 (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), ordinal INTEGER NOT NULL, session_id TEXT UNIQUE, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id,ordinal)); INSERT INTO attempts_v4 SELECT attempt_id,task_id,ordinal,session_id,payload_json,created_at FROM attempts; DROP TABLE attempts; ALTER TABLE attempts_v4 RENAME TO attempts; CREATE INDEX attempts_by_task ON attempts(task_id);")?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        version = 4;
    }
    if version < 5 {
        tx.execute_batch("CREATE TABLE attempt_submissions (idempotency_key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id));")?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        version = 5;
    }
    if version < 6 {
        tx.execute_batch("CREATE TABLE orchestration_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, payload_json TEXT NOT NULL);
            CREATE INDEX orchestration_changes_by_resource ON orchestration_changes(resource_type, resource_id, sequence);")?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (6, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        version = 6;
    }
    if version < 7 {
        tx.execute_batch("CREATE TABLE orchestration_materializations (resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, payload_json TEXT, last_sequence INTEGER NOT NULL, PRIMARY KEY(resource_type,resource_id));")?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (7, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
    }
    if version < 8 {
        // Scheduler queries are served from canonical task/attempt payload state.
        // Expression indexes preserve that single source of truth while keeping
        // capacity snapshots and atomic claims efficient as history grows.
        tx.execute_batch(
            "CREATE INDEX attempts_by_state ON attempts(json_extract(payload_json,'$.state'));",
        )?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
    }
    if version < 9 {
        // Extend the existing canonical Task/Attempt store. Batch membership remains
        // an optional grouping concern in the durable metadata, while old rows and
        // their IDs/session/idempotency bindings are preserved verbatim.
        tx.execute_batch(
            "CREATE TABLE task_durable_state (
                task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
                version INTEGER NOT NULL DEFAULT 1,
                completion_policy_json TEXT NOT NULL DEFAULT '{\"kind\":\"evidence\",\"required_kinds\":[\"legacy_scheduler_exit\"]}',
                verification_spec_json TEXT NOT NULL DEFAULT '{\"holdout_scenarios\":[]}',
                budget_json TEXT NOT NULL DEFAULT '{}',
                operator_hold INTEGER NOT NULL DEFAULT 0 CHECK(operator_hold IN (0,1)),
                controller_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(controller_mode IN ('legacy','shadow','reconciler')),
                reconcile_generation INTEGER NOT NULL DEFAULT 0,
                parent_task_id TEXT REFERENCES tasks(task_id),
                execution_target_json TEXT,
                work_branch TEXT,
                pull_request_binding_json TEXT,
                base_revision TEXT,
                terminal_json TEXT,
                retry_due_ms INTEGER,
                updated_at TEXT NOT NULL
            );
            INSERT INTO task_durable_state(task_id,updated_at)
                SELECT task_id,created_at FROM tasks;
            UPDATE task_durable_state SET
                parent_task_id=(SELECT json_extract(t.payload_json,'$.parent_task_id') FROM tasks t WHERE t.task_id=task_durable_state.task_id),
                execution_target_json=(SELECT CASE WHEN t.project<>'' AND t.repository<>'' THEN json_object('kind','git_repository','project',t.project,'repository',t.repository,'base_ref',COALESCE(json_extract(t.payload_json,'$.requested_revision'),'main'),'delivery',json_object('kind','pull_request')) END FROM tasks t WHERE t.task_id=task_durable_state.task_id),
                work_branch='anvil/'||task_id,
                base_revision=(SELECT COALESCE(json_extract(t.payload_json,'$.base_id'),json_extract(t.payload_json,'$.base_commit')) FROM tasks t WHERE t.task_id=task_durable_state.task_id),
                retry_due_ms=(SELECT json_extract(a.payload_json,'$.retry_at_ms') FROM attempts a WHERE a.task_id=task_durable_state.task_id ORDER BY a.ordinal DESC LIMIT 1);
            CREATE TABLE task_dependencies (
                predecessor_task_id TEXT NOT NULL REFERENCES tasks(task_id),
                successor_task_id TEXT NOT NULL REFERENCES tasks(task_id),
                PRIMARY KEY(predecessor_task_id,successor_task_id),
                CHECK(predecessor_task_id <> successor_task_id)
            );
            CREATE INDEX task_dependencies_by_successor ON task_dependencies(successor_task_id);
            INSERT OR IGNORE INTO task_dependencies(predecessor_task_id,successor_task_id)
                SELECT json_each.value,t.task_id FROM tasks t,json_each(t.payload_json,'$.dependencies')
                WHERE json_each.type='text' AND EXISTS(SELECT 1 FROM tasks p WHERE p.task_id=json_each.value);
            CREATE TABLE task_state_migration_map(legacy_state TEXT PRIMARY KEY,canonical_state TEXT NOT NULL,terminal_kind TEXT);
            INSERT INTO task_state_migration_map VALUES
                ('queued','open',NULL),('provisioning','open',NULL),('running','open',NULL),('retry_wait','open',NULL),
                ('completed','completed','completed'),('succeeded','completed','completed'),
                ('canceled','canceled','canceled'),('cancelled','canceled','canceled'),
                ('obviated','obviated','obviated'),('superseded','superseded','superseded'),
                ('failed','open',NULL),('exhausted','open',NULL);
            CREATE TABLE task_failure_migration_map(legacy_failure TEXT PRIMARY KEY,canonical_domain TEXT NOT NULL,canonical_code TEXT NOT NULL);
            INSERT INTO task_failure_migration_map VALUES
                ('infrastructure','platform','legacy_infrastructure'),('execution','work','legacy_execution'),
                ('non_retryable','unknown','legacy_non_retryable'),('unclassified','unknown','legacy_unclassified');
            UPDATE task_durable_state SET terminal_json=(
                SELECT CASE t.state
                    WHEN 'completed' THEN json_object('kind','completed','evidence',json_array(json_object('id','legacy-exit:'||t.task_id,'version',1,'kind','legacy_scheduler_exit')))
                    WHEN 'succeeded' THEN json_object('kind','completed','evidence',json_array(json_object('id','legacy-exit:'||t.task_id,'version',1,'kind','legacy_scheduler_exit')))
                    WHEN 'canceled' THEN json_object('kind','canceled','actor','legacy_migration','reason','historical canceled state')
                    WHEN 'cancelled' THEN json_object('kind','canceled','actor','legacy_migration','reason','historical canceled state')
                    WHEN 'obviated' THEN json_object('kind','obviated','reason','historical obviated state')
                    WHEN 'superseded' THEN json_object('kind','superseded','by_task_id',COALESCE(json_extract(t.payload_json,'$.superseded_by_task_id'),'legacy-unknown'))
                    ELSE NULL END FROM tasks t WHERE t.task_id=task_durable_state.task_id
            );
            CREATE TABLE task_observation_sequences (
                task_id TEXT NOT NULL REFERENCES tasks(task_id), key TEXT NOT NULL,
                next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),
                PRIMARY KEY(task_id,key)
            );
            CREATE TABLE task_observations (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
                key TEXT NOT NULL, value_json TEXT NOT NULL,
                provenance TEXT NOT NULL CHECK(provenance IN ('runtime','platform','external','agent')),
                observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
                version INTEGER NOT NULL, collection_seq INTEGER NOT NULL,
                expires_at TEXT, UNIQUE(task_id,key,collection_seq)
            );
            CREATE TABLE task_observation_current (
                task_id TEXT NOT NULL REFERENCES tasks(task_id), key TEXT NOT NULL,
                observation_id TEXT NOT NULL REFERENCES task_observations(id),
                PRIMARY KEY(task_id,key)
            );
            INSERT INTO task_observation_sequences(task_id,key,next_sequence)
                SELECT task_id,'evidence.legacy_scheduler_exit',2 FROM tasks WHERE state IN ('completed','succeeded');
            INSERT INTO task_observations(id,task_id,key,value_json,provenance,observed_at,recorded_at,version,collection_seq,expires_at)
                SELECT 'legacy-exit:'||task_id,task_id,'evidence.legacy_scheduler_exit',json_object('migration','schema_v9','legacy_state',state),'runtime',created_at,datetime('now'),1,1,NULL
                FROM tasks WHERE state IN ('completed','succeeded');
            INSERT INTO task_observation_current(task_id,key,observation_id)
                SELECT task_id,'evidence.legacy_scheduler_exit','legacy-exit:'||task_id FROM tasks WHERE state IN ('completed','succeeded');
            CREATE TABLE task_blockers (
                blocker_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
                attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), version INTEGER NOT NULL DEFAULT 1,
                question TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL,
                resolution_json TEXT
            );
            CREATE UNIQUE INDEX one_unresolved_blocker_per_task ON task_blockers(task_id) WHERE resolution_json IS NULL;
            CREATE TABLE task_budget_grants (
                grant_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
                actor_json TEXT NOT NULL, reason TEXT NOT NULL,
                additional_attempts INTEGER NOT NULL, additional_continuations INTEGER NOT NULL,
                additional_ci_retries INTEGER NOT NULL, additional_execution_seconds INTEGER NOT NULL,
                recorded_at TEXT NOT NULL
            );
            CREATE TABLE task_external_refs (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
                provider TEXT NOT NULL, external_id TEXT NOT NULL, source_hash TEXT NOT NULL, url TEXT,
                task_open INTEGER NOT NULL DEFAULT 1 CHECK(task_open IN (0,1))
            );
            CREATE UNIQUE INDEX one_open_external_task_ref ON task_external_refs(provider,external_id) WHERE task_open=1;
            CREATE UNIQUE INDEX one_live_attempt_per_task_role ON attempts(task_id,COALESCE(json_extract(payload_json,'$.role'),'implementation'))
                WHERE json_extract(payload_json,'$.state') IN ('queued','provisioning','running');
            CREATE TABLE legacy_scheduler_operations (
                task_id TEXT NOT NULL REFERENCES tasks(task_id), operation_key TEXT NOT NULL,
                operation_kind TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL, PRIMARY KEY(task_id,operation_key)
            );",
        )?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (9, ?1)",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        version = 9;
    }
    if version < 10 {
        tx.execute_batch(
            "CREATE TABLE tasks_v10 (
                task_id TEXT PRIMARY KEY,
                batch_id TEXT REFERENCES batches(batch_id),
                client_task_id TEXT NOT NULL,
                project TEXT NOT NULL,
                repository TEXT NOT NULL,
                prompt TEXT NOT NULL,
                state TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO tasks_v10 SELECT task_id,batch_id,client_task_id,project,repository,prompt,state,payload_json,created_at FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_v10 RENAME TO tasks;
            CREATE INDEX tasks_by_batch ON tasks(batch_id);
            CREATE INDEX active_logical_tasks ON tasks(project,repository,prompt,state);
            INSERT INTO schema_migrations(version,applied_at) VALUES (10,datetime('now'));",
        )?;
    }
    let latest: i64 = tx.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if latest < 11 {
        tx.execute_batch("ALTER TABLE attempts ADD COLUMN version INTEGER NOT NULL DEFAULT 1; UPDATE attempts SET payload_json=json_set(payload_json,'$.version',1) WHERE json_type(payload_json,'$.version') IS NULL; INSERT INTO schema_migrations(version,applied_at) VALUES(11,datetime('now'));")?;
    }
    let latest: i64 = tx.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if latest < 12 {
        tx.execute_batch("CREATE TABLE attempt_state_migration_map(legacy_state TEXT PRIMARY KEY,lifecycle TEXT NOT NULL,exit_reason TEXT); INSERT INTO attempt_state_migration_map VALUES ('queued','queued',NULL),('provisioning','provisioning',NULL),('running','running',NULL),('completed','ended','completed_turn'),('succeeded','ended','completed_turn'),('failed','ended','failed'),('retry_wait','ended','failed'),('exhausted','ended','failed'),('canceled','ended','canceled'),('cancelled','ended','canceled'),('abandoned','ended','abandoned'),('orphaned','ended','orphaned'),('replaced','ended','replaced'); UPDATE attempts SET payload_json=json_set(payload_json,'$.lifecycle',CASE WHEN json_extract(payload_json,'$.state') IN ('queued','provisioning','running') THEN json_extract(payload_json,'$.state') ELSE 'ended' END,'$.exit_reason',CASE json_extract(payload_json,'$.state') WHEN 'completed' THEN 'completed_turn' WHEN 'succeeded' THEN 'completed_turn' WHEN 'failed' THEN 'failed' WHEN 'retry_wait' THEN 'failed' WHEN 'exhausted' THEN 'failed' WHEN 'canceled' THEN 'canceled' WHEN 'cancelled' THEN 'canceled' WHEN 'abandoned' THEN 'abandoned' WHEN 'orphaned' THEN 'orphaned' WHEN 'replaced' THEN 'replaced' ELSE NULL END) WHERE json_type(payload_json,'$.lifecycle') IS NULL; UPDATE attempts SET payload_json=json_set(payload_json,'$.failure',json_object('domain',CASE json_extract(payload_json,'$.failure_class') WHEN 'infrastructure' THEN 'platform' WHEN 'execution' THEN 'work' ELSE 'unknown' END,'code','legacy_'||COALESCE(json_extract(payload_json,'$.failure_class'),'unclassified'),'summary',substr(COALESCE(json_extract(payload_json,'$.failure_reason'),''),1,512),'artifact_refs',json('[]'))) WHERE json_type(payload_json,'$.failure_class') IS NOT NULL; INSERT INTO schema_migrations(version,applied_at) VALUES(12,datetime('now'));")?;
    }
    tx.commit()?;
    connection.execute_batch("PRAGMA foreign_keys=ON;")?;
    let mut check = connection.prepare("PRAGMA foreign_key_check")?;
    if check.query([])?.next()?.is_some() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn encode_cursor(sequence: i64) -> String {
    format!("anv1.{sequence}")
}
fn decode_cursor(cursor: &str) -> Option<i64> {
    let sequence = cursor.strip_prefix("anv1.")?.parse::<i64>().ok()?;
    (sequence >= 0).then_some(sequence)
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(&map[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        // Scalar serialization preserves string, boolean, null, and JSON number distinctions.
        scalar => serde_json::to_string(scalar).expect("JSON value serializes"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, ControllerStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        (dir, store)
    }
    fn accept_batch(
        store: &ControllerStore,
        input: BatchAcceptance<'_>,
    ) -> Result<Acceptance, StoreError> {
        store.accept_batch(input)
    }
    #[test]
    fn canonicalization_sorts_objects_and_preserves_semantics() {
        let a: Value = serde_json::from_str(r#"{"z":[1,true,null],"a":2}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{ "a":2,"z":[1,true,null] }"#).unwrap();
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_ne!(
            canonical_json(&a),
            canonical_json(&serde_json::json!({"a":2,"z":[1,false,null]}))
        );
        assert_ne!(
            canonical_json(&serde_json::json!(1)),
            canonical_json(&serde_json::json!(1.0))
        );
    }
    #[test]
    fn persists_replays_conflicts_and_restart() {
        let (dir, store) = store();
        let request = serde_json::json!({"b":2,"a":1});
        let Acceptance::Created(first) = store
            .accept(
                "key",
                "submit",
                "tenant",
                &request,
                "resource-1",
                &serde_json::json!({"id":"resource-1"}),
            )
            .unwrap()
        else {
            panic!("expected initial creation")
        };
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        let Acceptance::Replayed(replayed) = reopened
            .accept(
                "key",
                "submit",
                "tenant",
                &serde_json::json!({"a":1,"b":2}),
                "ignored",
                &Value::Null,
            )
            .unwrap()
        else {
            panic!("expected replay")
        };
        assert_eq!(replayed, first);
        assert!(matches!(
            reopened.accept(
                "key",
                "submit",
                "tenant",
                &serde_json::json!({"a":9}),
                "other",
                &Value::Null
            ),
            Err(StoreError::Conflict)
        ));
        assert_eq!(reopened.get("key").unwrap(), Some(first));
    }
    #[test]
    fn concurrent_same_key_converges_to_one_created_and_rest_replayed() {
        let (_dir, store) = store();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let mut joins = vec![];
        for _ in 0..8 {
            let store = store.clone();
            let barrier = barrier.clone();
            joins.push(std::thread::spawn(move || {
                barrier.wait();
                store
                    .accept(
                        "race",
                        "create",
                        "scope",
                        &serde_json::json!({"x":1}),
                        "one",
                        &serde_json::json!({"id":"one"}),
                    )
                    .unwrap()
            }));
        }
        let results: Vec<_> = joins.into_iter().map(|join| join.join().unwrap()).collect();
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Acceptance::Created(_)))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Acceptance::Replayed(_)))
                .count(),
            7
        );
        assert!(results.iter().all(|result| match result {
            Acceptance::Created(r) | Acceptance::Replayed(r) => r.result_reference == "one",
        }));
    }

    #[test]
    fn simultaneous_different_requests_have_one_winner_and_one_conflict() {
        let (_dir, store) = store();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut joins = vec![];
        for (body, reference) in [
            (serde_json::json!({"request":"left"}), "left-result"),
            (serde_json::json!({"request":"right"}), "right-result"),
        ] {
            let store = store.clone();
            let barrier = barrier.clone();
            joins.push(std::thread::spawn(move || {
                barrier.wait();
                store.accept(
                    "competing",
                    "create",
                    "scope",
                    &body,
                    reference,
                    &serde_json::json!({"ref":reference}),
                )
            }));
        }
        let outcomes: Vec<_> = joins.into_iter().map(|join| join.join().unwrap()).collect();
        assert_eq!(
            outcomes
                .iter()
                .filter(|r| matches!(r, Ok(Acceptance::Created(_))))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|r| matches!(r, Err(StoreError::Conflict)))
                .count(),
            1
        );
        let winner = match outcomes.into_iter().find_map(Result::ok).unwrap() {
            Acceptance::Created(result) => result,
            other => panic!("unexpected outcome: {other:?}"),
        };
        assert_eq!(store.get("competing").unwrap(), Some(winner.clone()));
        assert_eq!(winner.result["ref"], winner.result_reference);
        let count: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key='competing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn completion_survives_restart_and_replay_preserves_completed_state() {
        let (dir, store) = store();
        let Acceptance::Created(accepted) = store
            .accept(
                "complete-key",
                "create",
                "scope",
                &serde_json::json!({"x":1}),
                "ref",
                &serde_json::json!({"id":"ref","full":true}),
            )
            .unwrap()
        else {
            panic!("expected creation")
        };
        let completed = store.mark_completed("complete-key").unwrap();
        assert_eq!(completed.state, IdempotencyState::Completed);
        assert_eq!(completed.result, accepted.result);
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        assert_eq!(
            reopened.get("complete-key").unwrap(),
            Some(completed.clone())
        );
        let Acceptance::Replayed(replayed) = reopened
            .accept(
                "complete-key",
                "create",
                "scope",
                &serde_json::json!({"x":1}),
                "ignored",
                &Value::Null,
            )
            .unwrap()
        else {
            panic!("expected replay")
        };
        assert_eq!(replayed, completed);
        assert_eq!(reopened.mark_completed("complete-key").unwrap(), completed);
    }

    #[test]
    fn migration_upgrades_v1_fixture_without_losing_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("controller.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
            INSERT INTO schema_migrations VALUES (1, 'v1-time');
            CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY, operation_kind TEXT NOT NULL, scope TEXT NOT NULL, request_hash TEXT NOT NULL, canonicalization_version INTEGER NOT NULL, result_reference TEXT NOT NULL, result_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE INDEX idempotency_by_scope ON idempotency_records(scope, operation_kind);
            INSERT INTO idempotency_records VALUES ('legacy','submit','scope','hash',1,'resource-v1','{\"payload\":true}','accepted','created-v1','updated-v1');") .unwrap();
        drop(connection);
        let store = ControllerStore::open(&path).unwrap();
        let record = store.get("legacy").unwrap().unwrap();
        assert_eq!(record.result_reference, "resource-v1");
        assert_eq!(record.result, serde_json::json!({"payload":true}));
        assert_eq!(record.state, IdempotencyState::Accepted);
        let version: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 12);
    }
    #[test]
    fn migration_is_repeatable_and_indexed() {
        let (dir, _) = store();
        let db = dir.path().join("controller.sqlite3");
        let connection = Connection::open(db).unwrap();
        let versions: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(versions, 1);
        let latest: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(latest, 12);
        let index: i64=connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='orchestration_by_attempt'",[],|row|row.get(0)).unwrap();
        assert_eq!(index, 1);
        let state_mappings: i64 = connection
            .query_row("SELECT COUNT(*) FROM task_state_migration_map", [], |row| {
                row.get(0)
            })
            .unwrap();
        let failure_mappings: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM task_failure_migration_map",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state_mappings, 12);
        assert_eq!(failure_mappings, 4);
        let attempt_mappings: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM attempt_state_migration_map",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempt_mappings, 13);
    }

    #[test]
    fn durable_task_control_is_versioned_and_compare_and_swap() {
        let (_dir, store) = store();
        let batch = serde_json::json!({"batch_id":"control-batch","project":"demo","repository":"https://example.test/r","requested_revision":"main","base_commit":"abc"});
        let task = serde_json::json!({"task_id":"control-task","project":"demo","repository":"https://example.test/r","prompt":"durable work","state":"queued"});
        store
            .accept_batch(BatchAcceptance {
                key: "control-key",
                scope: "test",
                request: &serde_json::json!({"control":true}),
                batch_id: "control-batch",
                batch: &batch,
                tasks: &[("control-task".into(), task)],
                allow_competing: true,
            })
            .unwrap();
        let initial = store.task_control("control-task").unwrap().unwrap();
        assert_eq!(initial["version"], 1);
        assert_eq!(initial["controller_mode"], "legacy");
        assert_eq!(initial["operator_hold"], false);
        assert_eq!(
            store
                .set_task_control("control-task", 1, true, "shadow")
                .unwrap(),
            2
        );
        assert!(matches!(
            store.set_task_control("control-task", 1, false, "legacy"),
            Err(StoreError::Conflict)
        ));
        let after = store.task_control("control-task").unwrap().unwrap();
        assert_eq!(after["version"], 2);
        assert_eq!(after["controller_mode"], "shadow");
        assert_eq!(after["reconcile_generation"], 1);
        assert_eq!(after["operator_hold"], true);
        assert!(store.claim_runnable(2, 0, 3, 0).unwrap().is_empty());
    }

    #[test]
    fn budget_grants_are_audited_append_only_and_visible_in_snapshot() {
        let (_dir, store) = store();
        let spec = serde_json::json!({"outcome":"bounded work"});
        store
            .accept_task("grant-task", "test", &spec, "grant-me", &spec)
            .unwrap();
        assert_eq!(
            store
                .grant_task_budget("grant-me", 1, "operator-1", "approved retry", 2, 1, 3, 900)
                .unwrap(),
            2
        );
        assert!(matches!(
            store.grant_task_budget("grant-me", 1, "operator-1", "stale", 1, 0, 0, 0),
            Err(StoreError::Conflict)
        ));
        let snapshot = store.task_snapshot("grant-me", 42).unwrap().unwrap();
        assert_eq!(snapshot["budget_usage"]["grants"]["attempts"], 2);
        assert_eq!(snapshot["budget_usage"]["grants"]["continuations"], 1);
        assert_eq!(snapshot["budget_usage"]["grants"]["ci_retries"], 3);
        assert_eq!(snapshot["budget_usage"]["grants"]["execution_seconds"], 900);
    }

    #[test]
    fn detached_task_acceptance_is_atomic_replayable_and_snapshotable() {
        let (dir, store) = store();
        let request = serde_json::json!({"outcome":"compile the project","execution_target":{"kind":"git_repository","project":"demo","repository":"https://example.test/r","base_ref":"main","delivery":{"kind":"local_branch"}}});
        let spec = request.clone();
        let first = store
            .accept_task("detached-key", "test", &request, "task-detached", &spec)
            .unwrap();
        assert!(first.created);
        assert_eq!(first.task["batch_id"], Value::Null);
        assert_eq!(first.task["work_branch"], "anvil/task-detached");
        let replay = store
            .accept_task("detached-key", "test", &request, "generated-new-id", &spec)
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.task, first.task);
        let snapshot = store.task_snapshot("task-detached", 123).unwrap().unwrap();
        assert_eq!(snapshot["task_id"], "task-detached");
        assert_eq!(snapshot["logical_time_ms"], 123);
        assert!(snapshot.get("dependencies").is_some());
        assert!(snapshot.get("children").is_some());
        assert!(snapshot.get("attempts").is_some());
        assert!(snapshot.get("observations").is_some());
        assert!(snapshot.get("action_history").is_some());
        assert_eq!(snapshot["phase"], "runnable");
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        assert_eq!(
            reopened
                .get_resource("task", "task-detached")
                .unwrap()
                .unwrap(),
            first.task
        );
        let claims = reopened.claim_runnable(1, 0, 3, 0).unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].task_id, "task-detached");
        assert!(matches!(
            reopened.create_attempt("task-detached", "duplicate-live", "duplicate-live-key"),
            Err(StoreError::Sqlite(_))
        ));
    }

    #[test]
    fn graph_cycle_rejection_rolls_back_all_nodes_and_edges() {
        let (_dir, store) = store();
        let request = serde_json::json!({"nodes":["a","b"],"dependencies":[["a","b"],["b","a"]]});
        let nodes = vec![
            (
                "a".into(),
                "task-a".into(),
                serde_json::json!({"outcome":"A"}),
            ),
            (
                "b".into(),
                "task-b".into(),
                serde_json::json!({"outcome":"B"}),
            ),
        ];
        let edges = vec![("a".into(), "b".into()), ("b".into(), "a".into())];
        assert!(matches!(
            store.accept_task_graph("cycle", "test", &request, &nodes, &edges),
            Err(StoreError::InvalidState(_))
        ));
        let count: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn observation_sequences_prevent_out_of_order_overwrite_and_conflicting_replay() {
        let (_dir, store) = store();
        let request = serde_json::json!({"outcome":"observe"});
        store
            .accept_task("observation-task", "test", &request, "observed", &request)
            .unwrap();
        let first = store
            .reserve_observation_sequence("observed", "git.head")
            .unwrap();
        let second = store
            .reserve_observation_sequence("observed", "git.head")
            .unwrap();
        store
            .record_observation(
                "newer",
                "observed",
                "git.head",
                &serde_json::json!({"sha":"new"}),
                "runtime",
                second,
                None,
            )
            .unwrap();
        store
            .record_observation(
                "older",
                "observed",
                "git.head",
                &serde_json::json!({"sha":"old"}),
                "runtime",
                first,
                None,
            )
            .unwrap();
        let snapshot = store.task_snapshot("observed", 0).unwrap().unwrap();
        assert_eq!(snapshot["current_observations"][0]["value"]["sha"], "new");
        assert!(matches!(
            store.record_observation(
                "conflict",
                "observed",
                "git.head",
                &serde_json::json!({"sha":"different"}),
                "runtime",
                second,
                None
            ),
            Err(StoreError::InvalidState(_))
        ));
    }

    #[test]
    fn completion_is_fresh_trusted_policy_checked_and_terminal_cas_fenced() {
        let (_dir, store) = store();
        let specification = serde_json::json!({"outcome":"deliver","completion_policy":{"kind":"evidence","required_kinds":["delivery_complete"]}});
        store
            .accept_task(
                "complete-task",
                "test",
                &specification,
                "complete-me",
                &specification,
            )
            .unwrap();
        let agent_seq = store
            .reserve_observation_sequence("complete-me", "evidence.delivery_complete")
            .unwrap();
        store
            .record_observation(
                "agent-proof",
                "complete-me",
                "evidence.delivery_complete",
                &serde_json::json!({"claimed":true}),
                "agent",
                agent_seq,
                None,
            )
            .unwrap();
        assert!(matches!(
            store.complete_task("complete-me", 1, &["agent-proof".into()]),
            Err(StoreError::InvalidState(_))
        ));
        let trusted_seq = store
            .reserve_observation_sequence("complete-me", "evidence.delivery_complete")
            .unwrap();
        store
            .record_observation(
                "trusted-proof",
                "complete-me",
                "evidence.delivery_complete",
                &serde_json::json!({"merged":true}),
                "external",
                trusted_seq,
                None,
            )
            .unwrap();
        let completed = store
            .complete_task("complete-me", 1, &["trusted-proof".into()])
            .unwrap();
        assert_eq!(completed["state"], "completed");
        assert_eq!(completed["terminal"]["kind"], "completed");
        assert_eq!(completed["terminal"]["evidence"][0]["id"], "trusted-proof");
        assert!(matches!(
            store.terminate_task(
                "complete-me",
                2,
                anvil_core::TaskTerminal::Canceled {
                    actor: "operator".into(),
                    reason: "late".into()
                }
            ),
            Err(StoreError::InvalidState(_))
        ));
    }

    #[test]
    fn uncommitted_acceptance_is_not_visible_after_reopen() {
        let (dir, store) = store();
        {
            let mut connection = store.connection.lock().unwrap();
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.execute(
                "INSERT INTO idempotency_records (idempotency_key, operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at) VALUES ('pending','create','scope','hash',1,'resource','{}','accepted','now','now')",
                [],
            )
            .unwrap();
            // Dropping this transaction simulates a process failure before COMMIT.
        }
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        assert_eq!(reopened.get("pending").unwrap(), None);
    }

    #[test]
    fn batch_acceptance_is_atomic_and_replayable_after_restart() {
        let (dir, store) = store();
        store.connection.lock().unwrap().execute_batch("CREATE TRIGGER fail_task BEFORE INSERT ON orchestration_resources WHEN NEW.resource_type='task' BEGIN SELECT RAISE(ABORT, 'injected task write failure'); END;").unwrap();
        let batch = serde_json::json!({"batch_id":"batch-1"});
        let failed = accept_batch(
            &store,
            BatchAcceptance {
                key: "failure-key",
                scope: "project",
                request: &serde_json::json!({"x":1}),
                batch_id: "batch-1",
                batch: &batch,
                tasks: &[("task-1".into(), serde_json::json!({"task_id":"task-1"}))],
                allow_competing: false,
            },
        );
        assert!(failed.is_err());
        assert_eq!(store.get_resource("batch", "batch-1").unwrap(), None);
        assert_eq!(store.get_resource("task", "task-1").unwrap(), None);
        assert_eq!(store.get("failure-key").unwrap(), None);
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_task;")
            .unwrap();
        let request = serde_json::json!({"plan":{"tasks":["task-1"]}});
        let batch = serde_json::json!({"batch_id":"batch-2","base_commit":"a"});
        let tasks = vec![("task-1".to_owned(), serde_json::json!({"task_id":"task-1"}))];
        let first = accept_batch(
            &store,
            BatchAcceptance {
                key: "retry-key",
                scope: "project",
                request: &request,
                batch_id: "batch-2",
                batch: &batch,
                tasks: &tasks,
                allow_competing: false,
            },
        )
        .unwrap();
        assert!(matches!(first, Acceptance::Created(_)));
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        assert!(matches!(
            accept_batch(
                &reopened,
                BatchAcceptance {
                    key: "retry-key",
                    scope: "project",
                    request: &request,
                    batch_id: "ignored",
                    batch: &Value::Null,
                    tasks: &[],
                    allow_competing: false,
                }
            )
            .unwrap(),
            Acceptance::Replayed(_)
        ));
        let batch_count: i64 = reopened
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM batches", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            batch_count, 1,
            "retry after simulated client timeout must not create another batch"
        );
        assert!(matches!(
            accept_batch(
                &reopened,
                BatchAcceptance {
                    key: "retry-key",
                    scope: "project",
                    request: &serde_json::json!({"plan":{"tasks":["other"]}}),
                    batch_id: "ignored",
                    batch: &Value::Null,
                    tasks: &[],
                    allow_competing: false,
                }
            ),
            Err(StoreError::Conflict)
        ));
        assert_eq!(
            reopened.get_resource("task", "task-1").unwrap().unwrap()["task_id"],
            "task-1"
        );
    }

    #[test]
    fn replacement_attempt_increments_attempt_identity_without_new_task() {
        let (dir, store) = store();
        accept_batch(
            &store,
            BatchAcceptance {
                key: "batch-key",
                scope: "project",
                request: &serde_json::json!({"x":1}),
                batch_id: "batch",
                batch: &serde_json::json!({"batch_id":"batch"}),
                tasks: &[(
                    "logical-task".into(),
                    serde_json::json!({"task_id":"logical-task"}),
                )],
                allow_competing: false,
            },
        )
        .unwrap();
        let first = store
            .create_attempt("logical-task", "attempt-1", "attempt-key-1")
            .unwrap();
        let first_replay = store
            .create_attempt("logical-task", "attempt-ignored", "attempt-key-1")
            .unwrap();
        assert!(!first_replay.created);
        assert_eq!(
            first_replay.attempt["attempt_id"],
            first.attempt["attempt_id"]
        );
        let second = store
            .create_attempt("logical-task", "attempt-2", "attempt-key-2")
            .unwrap();
        assert_eq!(first.attempt["ordinal"], 1);
        assert_eq!(second.attempt["ordinal"], 2);
        assert_eq!(store.attempts_for_task("logical-task").unwrap().len(), 2);
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        assert_eq!(
            reopened
                .get_resource("task", "logical-task")
                .unwrap()
                .unwrap()["task_id"],
            "logical-task"
        );
        assert_eq!(reopened.attempts_for_task("logical-task").unwrap().len(), 2);
    }

    #[test]
    fn active_logical_collision_suppresses_by_default_and_override_allows_competition() {
        let (_dir, store) = store();
        let base_a = "0123456789abcdef0123456789abcdef01234567";
        let base_b = "abcdef0123456789abcdef0123456789abcdef01";
        let batch = |id: &str, task_id: &str, base: &str| serde_json::json!({"batch_id":id,"project":"demo","repository":"https://github.com/example/repo","requested_revision":"main","base_commit":base,"accepted_task_ids":[task_id],"queued_count":1,"duplicate_suppression":[]});
        let task = |id: &str, client_id: &str, base: &str| serde_json::json!({"task_id":id,"requested_task_id":client_id,"project":"demo","repository":"https://github.com/example/repo","base_commit":base,"prompt":"same active work","dependencies":[],"owner":null,"policy":{},"state":"queued"});
        let first = accept_batch(
            &store,
            BatchAcceptance {
                key: "first",
                scope: "demo",
                request: &serde_json::json!({"n":1}),
                batch_id: "batch-1",
                batch: &batch("batch-1", "task-1", base_a),
                tasks: &[("task-1".into(), task("task-1", "build", base_a))],
                allow_competing: false,
            },
        )
        .unwrap();
        assert!(matches!(first, Acceptance::Created(_)));
        let suppressed = accept_batch(
            &store,
            BatchAcceptance {
                key: "second",
                scope: "demo",
                request: &serde_json::json!({"n":2}),
                batch_id: "batch-2",
                batch: &batch("batch-2", "task-2", base_a),
                tasks: &[("task-2".into(), task("task-2", "build", base_a))],
                allow_competing: false,
            },
        )
        .unwrap();
        let Acceptance::Created(suppressed) = suppressed else {
            panic!("new batch expected")
        };
        assert_eq!(suppressed.result["accepted_task_ids"][0], "task-1");
        assert_eq!(
            suppressed.result["duplicate_suppression"][0]["existing_task_id"],
            "task-1"
        );
        assert_eq!(store.get_resource("task", "task-2").unwrap(), None);
        let different_base = accept_batch(
            &store,
            BatchAcceptance {
                key: "different-base",
                scope: "demo",
                request: &serde_json::json!({"n":4}),
                batch_id: "batch-4",
                batch: &batch("batch-4", "task-4", base_b),
                tasks: &[("task-4".into(), task("task-4", "build", base_b))],
                allow_competing: false,
            },
        )
        .unwrap();
        assert!(matches!(different_base, Acceptance::Created(_)));
        assert!(store.get_resource("task", "task-4").unwrap().is_some());
        let competing = accept_batch(
            &store,
            BatchAcceptance {
                key: "third",
                scope: "demo",
                request: &serde_json::json!({"n":3}),
                batch_id: "batch-3",
                batch: &batch("batch-3", "task-3", base_a),
                tasks: &[("task-3".into(), task("task-3", "build", base_a))],
                allow_competing: true,
            },
        )
        .unwrap();
        assert!(matches!(competing, Acceptance::Created(_)));
        assert!(store.get_resource("task", "task-3").unwrap().is_some());
    }

    #[test]
    fn cursor_changes_are_exclusive_durable_and_normalized() {
        let (dir, store) = store();
        let initial = store
            .materialize("session", "s1", Some(&serde_json::json!({"state":"idle"})))
            .unwrap();
        assert_eq!(store.changes_after(&initial, 100).unwrap().changes.len(), 0);
        let next = store
            .materialize(
                "session",
                "s1",
                Some(&serde_json::json!({"state":"running"})),
            )
            .unwrap();
        let page = store.changes_after(&initial, 100).unwrap();
        assert_eq!(page.changes.len(), 1);
        assert_eq!(page.cursor, next);
        assert_eq!(store.changes_after(&initial, 100).unwrap(), page);
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        assert_eq!(reopened.changes_after(&initial, 100).unwrap(), page);
        assert!(
            reopened
                .changes_after("not-a-cursor", 100)
                .unwrap()
                .reset_required
        );
        assert!(
            reopened
                .changes_after("anv1.999", 100)
                .unwrap()
                .reset_required
        );
    }

    #[test]
    fn normalized_changes_coalesce_identical_materializations() {
        let (_dir, store) = store();
        let payload = serde_json::json!({"execution":"busy"});
        let first = store.materialize("session", "s1", Some(&payload)).unwrap();
        store
            .materialize("session", "other", Some(&serde_json::json!({"x":1})))
            .unwrap();
        let repeated = store.materialize("session", "s1", Some(&payload)).unwrap();
        assert_eq!(first, repeated);
        let page = store.changes_after("anv1.0", 100).unwrap();
        assert_eq!(page.changes.len(), 2);
        assert_eq!(
            page.changes
                .iter()
                .filter(|change| change["resource_id"] == "s1")
                .count(),
            1
        );
    }

    #[test]
    fn snapshot_racing_update_is_in_snapshot_or_after_cursor_never_skipped() {
        let (dir, snapshot_store) = store();
        let writer_store = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        snapshot_store
            .materialize("session", "s1", Some(&serde_json::json!({"state":"idle"})))
            .unwrap();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let reader_entered = entered.clone();
        let reader_release = release.clone();
        let reader_store = snapshot_store.clone();
        let reader = std::thread::spawn(move || {
            reader_store
                .materialized_snapshot_with(|| {
                    reader_entered.wait();
                    reader_release.wait();
                })
                .unwrap()
        });
        entered.wait();
        writer_store
            .materialize(
                "session",
                "s1",
                Some(&serde_json::json!({"state":"running"})),
            )
            .unwrap();
        release.wait();
        let (snapshot_cursor, snapshot) = reader.join().unwrap();
        let deltas = writer_store.changes_after(&snapshot_cursor, 100).unwrap();
        let snapshot_state = snapshot[0]["record"]["state"].as_str().unwrap();
        assert_eq!(snapshot_state, "idle");
        assert_eq!(deltas.changes.len(), 1);
        assert_eq!(deltas.changes[0]["change"]["record"]["state"], "running");
        assert_eq!(
            writer_store.changes_after(&snapshot_cursor, 100).unwrap(),
            deltas
        );
    }

    #[test]
    fn ordered_transitions_and_expired_cursor_reset() {
        let (_dir, store) = store();
        let first = store
            .materialize("session", "s", Some(&serde_json::json!({"n":1})))
            .unwrap();
        store
            .materialize("session", "s", Some(&serde_json::json!({"n":2})))
            .unwrap();
        store
            .materialize("session", "s", Some(&serde_json::json!({"n":3})))
            .unwrap();
        let page = store.changes_after(&first, 100).unwrap();
        assert_eq!(page.changes.len(), 2);
        assert_eq!(page.changes[0]["change"]["record"]["n"], 2);
        assert_eq!(page.changes[1]["change"]["record"]["n"], 3);
        store
            .connection
            .lock()
            .unwrap()
            .execute("DELETE FROM orchestration_changes WHERE sequence=1", [])
            .unwrap();
        assert!(store.changes_after("anv1.0", 100).unwrap().reset_required);
    }

    #[test]
    fn limited_pages_continue_without_losing_or_duplicating_transitions() {
        let (_dir, store) = store();
        for transition in 1..=7 {
            store
                .materialize(
                    "task",
                    "task-1",
                    Some(&serde_json::json!({"transition":transition})),
                )
                .unwrap();
        }
        let mut cursor = "anv1.0".to_owned();
        let mut observed = Vec::new();
        loop {
            let page = store.changes_after(&cursor, 3).unwrap();
            assert!(!page.reset_required);
            observed.extend(
                page.changes
                    .iter()
                    .map(|change| change["change"]["record"]["transition"].as_i64().unwrap()),
            );
            if page.changes.is_empty() {
                break;
            }
            cursor = page.cursor;
        }
        assert_eq!(observed, (1..=7).collect::<Vec<_>>());
    }

    #[test]
    fn concurrent_materializations_have_one_total_order_and_matching_final_snapshot() {
        let (dir, store) = store();
        let mut writers = Vec::new();
        let barrier = Arc::new(std::sync::Barrier::new(9));
        for transition in 1..=8 {
            let writer = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
            let barrier = barrier.clone();
            writers.push(std::thread::spawn(move || {
                barrier.wait();
                writer
                    .materialize(
                        "session",
                        "shared",
                        Some(&serde_json::json!({"transition":transition})),
                    )
                    .unwrap();
            }));
        }
        barrier.wait();
        for writer in writers {
            writer.join().unwrap();
        }
        let page = store.changes_after("anv1.0", 100).unwrap();
        assert_eq!(page.changes.len(), 8);
        let transitions = page
            .changes
            .iter()
            .map(|change| change["change"]["record"]["transition"].as_i64().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(transitions, (1..=8).collect());
        let (snapshot_cursor, snapshot) = store.materialized_snapshot().unwrap();
        assert_eq!(snapshot_cursor, page.cursor);
        assert_eq!(
            snapshot[0]["record"]["transition"],
            page.changes.last().unwrap()["change"]["record"]["transition"]
        );
    }
}
