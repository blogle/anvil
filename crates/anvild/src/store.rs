//! Controller-owned transactional orchestration storage.
//!
//! A store handle serializes its own operations with a mutex; separate handles/processes
//! use SQLite WAL for reader/writer concurrency and SQLite's writer lock for arbitration.
//! FULL synchronous commits make accepted results durable before provisioning begins.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};
use thiserror::Error;

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

#[derive(Clone)]
pub struct ControllerStore {
    connection: Arc<Mutex<Connection>>,
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
    pub fn accept_batch(
        &self,
        key: &str,
        scope: &str,
        request: &Value,
        batch_id: &str,
        batch: &Value,
        tasks: &[(String, Value)],
    ) -> Result<Acceptance, StoreError> {
        let canonical = canonical_json(request);
        let hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.connection.lock().expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx.query_row(
            "SELECT operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at FROM idempotency_records WHERE idempotency_key=?1",
            [key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?)),
        ).optional()?;
        if let Some((kind, stored_scope, stored_hash, version, reference, json, state, created_at, updated_at)) = existing {
            if version != CANONICALIZATION_VERSION { return Err(StoreError::UnsupportedCanonicalization(version)); }
            if kind != "submit_batch" || stored_scope != scope || stored_hash != hash { return Err(StoreError::Conflict); }
            let result = serde_json::from_str(&json)?;
            tx.commit()?;
            return Ok(Acceptance::Replayed(AcceptedResult { idempotency_key: key.into(), operation_kind: kind, scope: stored_scope, result_reference: reference, result, state: parse_state(&state)?, created_at, updated_at }));
        }
        tx.execute("INSERT INTO orchestration_resources (resource_type, resource_id, batch_id, task_id, attempt_id, payload_json, created_at, updated_at) VALUES ('batch',?1,?1,NULL,NULL,?2,?3,?3)", params![batch_id, serde_json::to_string(batch)?, now])?;
        for (task_id, task) in tasks {
            tx.execute("INSERT INTO orchestration_resources (resource_type, resource_id, batch_id, task_id, attempt_id, payload_json, created_at, updated_at) VALUES ('task',?1,?2,?1,NULL,?3,?4,?4)", params![task_id, batch_id, serde_json::to_string(task)?, now])?;
        }
        tx.execute("INSERT INTO idempotency_records (idempotency_key, operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at) VALUES (?1,'submit_batch',?2,?3,?4,?5,?6,'accepted',?7,?7)", params![key, scope, hash, CANONICALIZATION_VERSION, batch_id, serde_json::to_string(batch)?, now])?;
        tx.commit()?;
        Ok(Acceptance::Created(AcceptedResult { idempotency_key: key.into(), operation_kind: "submit_batch".into(), scope: scope.into(), result_reference: batch_id.into(), result: batch.clone(), state: IdempotencyState::Accepted, created_at: now.clone(), updated_at: now }))
    }

    pub fn get_resource(&self, resource_type: &str, id: &str) -> Result<Option<Value>, StoreError> {
        let connection = self.connection.lock().expect("controller store lock poisoned");
        connection.query_row("SELECT payload_json FROM orchestration_resources WHERE resource_type=?1 AND resource_id=?2", params![resource_type, id], |row| row.get::<_, String>(0)).optional()?.map(|value| serde_json::from_str(&value).map_err(StoreError::from)).transpose()
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

fn migrate(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);")?;
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
    }
    tx.commit()?;
    Ok(())
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
        assert_eq!(version, 2);
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
        assert_eq!(latest, 2);
        let index: i64=connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='orchestration_by_attempt'",[],|row|row.get(0)).unwrap();
        assert_eq!(index, 1);
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
}
