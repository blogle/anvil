//! Controller-owned transactional orchestration storage.
//!
//! SQLite WAL permits concurrent readers while serializing writers. FULL synchronous
//! commits make accepted idempotency results durable before callers begin provisioning.
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
    pub created_at: String,
    pub updated_at: String,
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
    ) -> Result<AcceptedResult, StoreError> {
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
        let existing = tx.query_row("SELECT operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, created_at, updated_at FROM idempotency_records WHERE idempotency_key=?1", [key], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?))).optional()?;
        if let Some((
            kind,
            stored_scope,
            stored_hash,
            version,
            reference,
            json,
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
            return Ok(AcceptedResult {
                idempotency_key: key.into(),
                operation_kind: kind,
                scope: stored_scope,
                result_reference: reference,
                result,
                created_at,
                updated_at,
            });
        }
        tx.execute("INSERT INTO idempotency_records (idempotency_key, operation_kind, scope, request_hash, canonicalization_version, result_reference, result_json, state, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'accepted',?8,?8)", params![key, operation_kind, scope, hash, CANONICALIZATION_VERSION, result_reference, serde_json::to_string(result)?, now])?;
        tx.commit()?;
        Ok(AcceptedResult {
            idempotency_key: key.into(),
            operation_kind: operation_kind.into(),
            scope: scope.into(),
            result_reference: result_reference.into(),
            result: result.clone(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<AcceptedResult>, StoreError> {
        let connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let row = connection.query_row("SELECT operation_kind, scope, result_reference, result_json, created_at, updated_at FROM idempotency_records WHERE idempotency_key=?1 AND state='accepted'", [key], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?))).optional()?;
        row.map(
            |(operation_kind, scope, result_reference, result, created_at, updated_at)| {
                Ok(AcceptedResult {
                    idempotency_key: key.into(),
                    operation_kind,
                    scope,
                    result_reference,
                    result: serde_json::from_str(&result)?,
                    created_at,
                    updated_at,
                })
            },
        )
        .transpose()
    }
}

fn migrate(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);")?;
    let tx = connection.unchecked_transaction()?;
    let version: i64 = tx.query_row(
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
        let first = store
            .accept(
                "key",
                "submit",
                "tenant",
                &request,
                "resource-1",
                &serde_json::json!({"id":"resource-1"}),
            )
            .unwrap();
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        assert_eq!(
            reopened
                .accept(
                    "key",
                    "submit",
                    "tenant",
                    &serde_json::json!({"a":1,"b":2}),
                    "ignored",
                    &Value::Null
                )
                .unwrap(),
            first
        );
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
    fn concurrent_same_key_converges_and_different_request_conflicts() {
        let (_dir, store) = store();
        let mut joins = vec![];
        for _ in 0..8 {
            let store = store.clone();
            joins.push(std::thread::spawn(move || {
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
        assert!(results.iter().all(|result| result == &results[0]));
        let store = store.clone();
        let conflict = std::thread::spawn(move || {
            store.accept(
                "race",
                "create",
                "scope",
                &serde_json::json!({"x":2}),
                "two",
                &Value::Null,
            )
        });
        assert!(matches!(
            conflict.join().unwrap(),
            Err(StoreError::Conflict)
        ));
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
