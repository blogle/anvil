//! Controller-owned SQLite persistence primitives. SQLite uses WAL for concurrent
//! readers and `synchronous=FULL` so a committed acceptance survives power loss;
//! transactions are deliberately short and never span external provisioning.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

const CANONICALIZATION_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("controller store failure: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("controller store filesystem failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid JSON request: {0}")]
    Json(#[from] serde_json::Error),
    #[error("idempotency key is already bound to a different operation or request")]
    IdempotencyConflict,
    #[error("unsupported canonicalization version {0}")]
    UnsupportedCanonicalization(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedMutation {
    pub idempotency_key: String,
    pub operation_kind: String,
    pub scope: String,
    pub result_reference: String,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Acceptance {
    Created(AcceptedMutation),
    Replayed(AcceptedMutation),
}

#[derive(Clone)]
pub struct ControllerStore {
    path: PathBuf,
}

impl ControllerStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let store = Self { path };
        let mut conn = store.connect()?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;")?;
        migrate(&mut conn)?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, StoreError> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        Ok(conn)
    }

    /// Atomically commits the caller's authoritative result identity and accepted
    /// idempotency record. External work belongs after this method returns.
    pub fn accept(
        &self,
        key: &str,
        kind: &str,
        scope: &str,
        request: &Value,
        result_reference: &str,
    ) -> Result<Acceptance, StoreError> {
        let hash = request_hash(request)?;
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx.query_row("SELECT operation_kind, scope, request_hash, canonicalization_version, result_reference, state, created_at, updated_at FROM idempotency_records WHERE idempotency_key=?1", [key], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,u32>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,i64>(6)?,row.get::<_,i64>(7)?))).optional()?;
        if let Some((old_kind, old_scope, old_hash, version, result, state, created, updated)) =
            existing
        {
            if old_kind != kind
                || old_scope != scope
                || version != CANONICALIZATION_VERSION
                || old_hash != hash
            {
                return Err(if version != CANONICALIZATION_VERSION {
                    StoreError::UnsupportedCanonicalization(version)
                } else {
                    StoreError::IdempotencyConflict
                });
            }
            tx.commit()?;
            return Ok(Acceptance::Replayed(AcceptedMutation {
                idempotency_key: key.into(),
                operation_kind: kind.into(),
                scope: scope.into(),
                result_reference: result,
                state,
                created_at: created,
                updated_at: updated,
            }));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        tx.execute("INSERT INTO idempotency_records(idempotency_key,operation_kind,scope,request_hash,canonicalization_version,result_reference,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'accepted',?7,?7)", params![key,kind,scope,hash,CANONICALIZATION_VERSION,result_reference,now])?;
        tx.commit()?;
        Ok(Acceptance::Created(AcceptedMutation {
            idempotency_key: key.into(),
            operation_kind: kind.into(),
            scope: scope.into(),
            result_reference: result_reference.into(),
            state: "accepted".into(),
            created_at: now,
            updated_at: now,
        }))
    }

    pub fn get(&self, key: &str) -> Result<Option<AcceptedMutation>, StoreError> {
        self.connect()?.query_row("SELECT idempotency_key,operation_kind,scope,result_reference,state,created_at,updated_at FROM idempotency_records WHERE idempotency_key=?1", [key], |r| Ok(AcceptedMutation{idempotency_key:r.get(0)?,operation_kind:r.get(1)?,scope:r.get(2)?,result_reference:r.get(3)?,state:r.get(4)?,created_at:r.get(5)?,updated_at:r.get(6)?})).optional().map_err(Into::into)
    }
}

fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);")?;
    let version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;
    if version < 1 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch("CREATE TABLE idempotency_records(idempotency_key TEXT PRIMARY KEY, operation_kind TEXT NOT NULL, scope TEXT NOT NULL, request_hash TEXT NOT NULL, canonicalization_version INTEGER NOT NULL, result_reference TEXT NOT NULL, batch_id TEXT, task_id TEXT, attempt_id TEXT, state TEXT NOT NULL CHECK(state IN ('accepted','completed')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX idempotency_by_scope ON idempotency_records(scope, operation_kind); CREATE INDEX idempotency_by_result_reference ON idempotency_records(result_reference); CREATE INDEX idempotency_by_batch_id ON idempotency_records(batch_id) WHERE batch_id IS NOT NULL; CREATE INDEX idempotency_by_task_id ON idempotency_records(task_id) WHERE task_id IS NOT NULL; CREATE INDEX idempotency_by_attempt_id ON idempotency_records(attempt_id) WHERE attempt_id IS NOT NULL; INSERT INTO schema_migrations(version,applied_at) VALUES(1,unixepoch());")?;
        tx.commit()?;
    }
    Ok(())
}

/// Canonical JSON v1 sorts object keys recursively; arrays preserve order; scalar
/// values (including number representation/value, null, and strings) are retained.
pub fn canonical_json(value: &Value) -> Result<Vec<u8>, StoreError> {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                let mut out = serde_json::Map::new();
                for key in keys {
                    out.insert(key.clone(), sort(&map[key]));
                }
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(items.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    Ok(serde_json::to_vec(&sort(value))?)
}

pub fn request_hash(value: &Value) -> Result<String, StoreError> {
    let bytes = canonical_json(value)?;
    let mut hasher = Sha256::new();
    hasher.update(CANONICALIZATION_VERSION.to_be_bytes());
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, ControllerStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ControllerStore::open(dir.path().join("controller.sqlite")).unwrap();
        (dir, store)
    }
    #[test]
    fn canonicalization_is_semantic_and_order_stable() {
        assert_eq!(
            request_hash(&serde_json::from_str(r#"{"b":[1,2],"a":{"y":null,"x":true}}"#).unwrap())
                .unwrap(),
            request_hash(&serde_json::from_str(r#"{"a":{"x":true,"y":null},"b":[1,2]}"#).unwrap())
                .unwrap()
        );
        assert_ne!(
            request_hash(&serde_json::json!([1, 2])).unwrap(),
            request_hash(&serde_json::json!([2, 1])).unwrap()
        );
        assert_ne!(
            request_hash(&serde_json::json!(1)).unwrap(),
            request_hash(&serde_json::json!(1.0)).unwrap()
        );
    }
    #[test]
    fn migrations_repeat_and_survive_reopen() {
        let (dir, store) = store();
        let path = dir.path().join("controller.sqlite");
        let a = store
            .accept(
                "k",
                "batch.submit",
                "tenant",
                &"{\"b\":2,\"a\":1}".parse().unwrap(),
                "batch-1",
            )
            .unwrap();
        assert!(matches!(a, Acceptance::Created(_)));
        drop(store);
        let reopened = ControllerStore::open(path).unwrap();
        let replay = reopened
            .accept(
                "k",
                "batch.submit",
                "tenant",
                &"{\"a\":1,\"b\":2}".parse().unwrap(),
                "batch-2",
            )
            .unwrap();
        assert!(matches!(replay,Acceptance::Replayed(ref r) if r.result_reference=="batch-1"));
        assert_eq!(reopened.get("k").unwrap().unwrap().state, "accepted");
    }
    #[test]
    fn conflict_and_uncommitted_transaction_are_not_visible() {
        let (_dir, store) = store();
        store
            .accept("k", "op", "s", &serde_json::json!({"x":1}), "r1")
            .unwrap();
        assert!(matches!(
            store.accept("k", "op", "s", &serde_json::json!({"x":2}), "r2"),
            Err(StoreError::IdempotencyConflict)
        ));
        let mut conn = store.connect().unwrap();
        {
            let tx = conn.transaction().unwrap();
            tx.execute("INSERT INTO idempotency_records(idempotency_key,operation_kind,scope,request_hash,canonicalization_version,result_reference,state,created_at,updated_at) VALUES('pending','op','s','h',1,'bad','accepted',0,0)",[]).unwrap();
        }
        assert!(store.get("pending").unwrap().is_none());
    }
    #[test]
    fn concurrent_same_key_converges_and_different_request_conflicts() {
        let (_dir, store) = store();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let s = store.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    b.wait();
                    s.accept(
                        "race",
                        "op",
                        "scope",
                        &serde_json::json!({"x":1}),
                        "same-result",
                    )
                    .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Acceptance::Created(_)))
                .count(),
            1
        );
        assert!(results.iter().all(|r| match r {
            Acceptance::Created(v) | Acceptance::Replayed(v) => v.result_reference == "same-result",
        }));
        let s = store.clone();
        let other = std::thread::spawn(move || {
            s.accept("race", "op", "scope", &serde_json::json!({"x":2}), "other")
        });
        assert!(matches!(
            other.join().unwrap(),
            Err(StoreError::IdempotencyConflict)
        ));
    }
}
