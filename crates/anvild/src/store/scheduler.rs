//! Scheduling operations over the canonical `batches`, `tasks`, and `attempts`
//! records. Queue order is durable task insertion order (`tasks.rowid`), which is
//! the acceptance order within a batch and is stable across controller restarts.
use super::{ControllerStore, StoreError};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    Infrastructure,
    Execution,
    NonRetryable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchCapacity {
    pub batch_id: String,
    pub active: u32,
    pub queued: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capacity {
    pub global_limit: u32,
    pub running: u32,
    pub provisioning: u32,
    pub non_batch_running: u32,
    pub non_batch_provisioning: u32,
    pub queued_runnable: u32,
    pub available_slots: u32,
    pub batches: Vec<BatchCapacity>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaimedAttempt {
    pub batch_id: String,
    pub task_id: String,
    pub attempt: Value,
    pub task: Value,
}

#[derive(Debug, Clone)]
pub struct ActiveAttempt {
    pub attempt_id: String,
    pub task_id: String,
    pub state: String,
    pub session_id: Option<String>,
}

impl ControllerStore {
    /// Atomically create and claim due work subject to global and per-batch ceilings.
    /// `now_ms` and retry parameters are explicit to permit deterministic timing tests.
    pub fn claim_runnable(
        &self,
        global_limit: u32,
        now_ms: i64,
        max_attempts: u32,
        non_batch_active: u32,
    ) -> Result<Vec<ClaimedAttempt>, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut active_global = active_count(&tx, None)?.saturating_add(non_batch_active);
        let mut active_batches = std::collections::HashMap::<String, u32>::new();
        let mut batches_stmt = tx.prepare("SELECT b.batch_id, COUNT(a.attempt_id) FROM batches b LEFT JOIN attempts a ON a.task_id IN (SELECT task_id FROM tasks WHERE batch_id=b.batch_id) AND json_extract(a.payload_json,'$.state') IN ('provisioning','running') GROUP BY b.batch_id")?;
        for row in
            batches_stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))?
        {
            let (batch, count) = row?;
            active_batches.insert(batch, count);
        }
        drop(batches_stmt);

        let mut stmt = tx.prepare("SELECT t.task_id,t.batch_id,t.payload_json,b.payload_json,t.state FROM tasks t JOIN batches b USING(batch_id) WHERE t.state IN ('queued','retry_wait','provisioning') ORDER BY t.rowid")?;
        let candidates = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut claims = Vec::new();
        for (task_id, batch_id, task_json, batch_json, task_state) in candidates {
            let task: Value = serde_json::from_str(&task_json)?;
            let batch: Value = serde_json::from_str(&batch_json)?;
            let ceiling = batch["requested_concurrency"].as_u64().unwrap_or(1) as u32;
            let previous: Option<(i64, String, Option<String>)> = tx.query_row("SELECT ordinal,payload_json,session_id FROM attempts WHERE task_id=?1 ORDER BY ordinal DESC LIMIT 1", [&task_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let previous_payload = previous
                .as_ref()
                .map(|(_, payload, _)| serde_json::from_str::<Value>(payload))
                .transpose()?;
            let resume = task_state == "provisioning"
                && previous.as_ref().is_some_and(|(_, payload, session)| {
                    session.is_none()
                        && serde_json::from_str::<Value>(payload)
                            .is_ok_and(|v| v["state"] == "provisioning")
                });
            if !resume && active_global >= global_limit {
                break;
            }
            if !resume && active_batches.get(&batch_id).copied().unwrap_or(0) >= ceiling {
                continue;
            }
            if !dependencies_satisfied(&tx, &task)? {
                continue;
            }
            if resume {
                let (n, json, _) = previous.as_ref().unwrap();
                let attempt: Value = serde_json::from_str(json)?;
                claims.push(ClaimedAttempt {
                    batch_id,
                    task_id,
                    attempt,
                    task,
                });
                let _ = n;
                continue;
            }
            if !task_is_runnable(&task_state, previous_payload.as_ref(), now_ms, max_attempts) {
                continue;
            }
            if task_state == "queued"
                && previous_payload
                    .as_ref()
                    .is_some_and(|attempt| attempt["state"] == "queued")
            {
                let (ordinal, raw, _) = previous.as_ref().unwrap();
                let mut attempt: Value = serde_json::from_str(raw)?;
                attempt["state"] = Value::String("provisioning".into());
                let attempt_id = attempt["attempt_id"].as_str().unwrap_or_default();
                persist_attempt(&tx, attempt_id, &attempt)?;
                set_task_state(&tx, &task_id, "provisioning")?;
                active_global += 1;
                *active_batches.entry(batch_id.clone()).or_default() += 1;
                claims.push(ClaimedAttempt {
                    batch_id,
                    task_id,
                    attempt,
                    task,
                });
                let _ = ordinal;
                continue;
            }
            let (ordinal, attempt_id) = match previous {
                Some((n, _json, _)) => {
                    if n as u32 >= max_attempts {
                        continue;
                    }
                    ((n + 1) as u32, format!("{task_id}-attempt-{}", n + 1))
                }
                None => (1, format!("{task_id}-attempt-1")),
            };
            let key = format!("scheduler:{task_id}:{ordinal}");
            let accepted = super::create_attempt_tx(&tx, &task_id, &attempt_id, &key)?;
            let mut attempt = accepted.attempt;
            attempt["state"] = Value::String("provisioning".into());
            persist_attempt(&tx, &attempt_id, &attempt)?;
            set_task_state(&tx, &task_id, "provisioning")?;
            active_global += 1;
            *active_batches.entry(batch_id.clone()).or_default() += 1;
            claims.push(ClaimedAttempt {
                batch_id,
                task_id,
                attempt,
                task,
            });
        }
        tx.commit()?;
        Ok(claims)
    }

    pub fn record_attempt_failure(
        &self,
        attempt_id: &str,
        class: FailureClass,
        reason: &str,
        now_ms: i64,
        max_attempts: u32,
        base_backoff_ms: u64,
    ) -> Result<bool, StoreError> {
        let mut c = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (task_id, raw_attempt): (String, String) = tx.query_row(
            "SELECT task_id,payload_json FROM attempts WHERE attempt_id=?1",
            [attempt_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut attempt: Value = serde_json::from_str(&raw_attempt)?;
        let ordinal = attempt["ordinal"].as_u64().unwrap_or(0) as u32;
        let retry = class == FailureClass::Infrastructure && ordinal < max_attempts;
        let wait = base_backoff_ms.saturating_mul(1u64 << ordinal.saturating_sub(1).min(20));
        attempt["state"] = serde_json::json!(if retry {
            "retry_wait"
        } else if class == FailureClass::Infrastructure {
            "exhausted"
        } else {
            "failed"
        });
        attempt["failure_class"] = serde_json::json!(class);
        attempt["failure_reason"] = Value::String(reason.to_owned());
        attempt["retry_at_ms"] = if retry {
            serde_json::json!(now_ms.saturating_add(wait.min(i64::MAX as u64) as i64))
        } else {
            Value::Null
        };
        persist_attempt(&tx, attempt_id, &attempt)?;
        set_task_state(
            &tx,
            &task_id,
            if retry {
                "retry_wait"
            } else if class == FailureClass::Infrastructure {
                "exhausted"
            } else {
                "failed"
            },
        )?;
        tx.commit()?;
        Ok(retry)
    }

    pub fn set_attempt_state(&self, attempt_id: &str, state: &str) -> Result<(), StoreError> {
        let mut c = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let raw_attempt: String = tx.query_row(
            "SELECT payload_json FROM attempts WHERE attempt_id=?1",
            [attempt_id],
            |r| r.get(0),
        )?;
        let mut attempt: Value = serde_json::from_str(&raw_attempt)?;
        attempt["state"] = Value::String(state.to_owned());
        persist_attempt(&tx, attempt_id, &attempt)?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_attempt_and_task_state(
        &self,
        attempt_id: &str,
        attempt_state: &str,
        task_state: &str,
    ) -> Result<(), StoreError> {
        let mut c = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task_id: String = tx.query_row(
            "SELECT task_id FROM attempts WHERE attempt_id=?1",
            [attempt_id],
            |r| r.get(0),
        )?;
        let raw_attempt: String = tx.query_row(
            "SELECT payload_json FROM attempts WHERE attempt_id=?1",
            [attempt_id],
            |r| r.get(0),
        )?;
        let mut attempt: Value = serde_json::from_str(&raw_attempt)?;
        attempt["state"] = Value::String(attempt_state.to_owned());
        persist_attempt(&tx, attempt_id, &attempt)?;
        set_task_state(&tx, &task_id, task_state)?;
        tx.commit()?;
        Ok(())
    }

    pub fn active_attempts(&self) -> Result<Vec<ActiveAttempt>, StoreError> {
        let c = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let mut statement = c.prepare("SELECT attempt_id,task_id,json_extract(payload_json,'$.state'),session_id FROM attempts WHERE json_extract(payload_json,'$.state') IN ('provisioning','running') ORDER BY rowid")?;
        let attempts = statement
            .query_map([], |r| {
                Ok(ActiveAttempt {
                    attempt_id: r.get(0)?,
                    task_id: r.get(1)?,
                    state: r.get(2)?,
                    session_id: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(attempts)
    }

    /// Session identities ever bound to canonical Attempts. The controller uses
    /// this to separate Batch-owned sandboxes from non-Batch service occupancy.
    pub fn attempt_session_ids(&self) -> Result<std::collections::HashSet<String>, StoreError> {
        let c = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let mut statement =
            c.prepare("SELECT DISTINCT session_id FROM attempts WHERE session_id IS NOT NULL")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<std::collections::HashSet<_>, _>>()?;
        Ok(ids)
    }

    pub fn capacity(
        &self,
        global_limit: u32,
        now_ms: i64,
        max_attempts: u32,
        non_batch_running: u32,
        non_batch_provisioning: u32,
    ) -> Result<Capacity, StoreError> {
        let c = self
            .connection
            .lock()
            .expect("controller store lock poisoned");
        let running = count_state(&c, "running")?.saturating_add(non_batch_running);
        let provisioning = count_state(&c, "provisioning")?.saturating_add(non_batch_provisioning);
        let active = running.saturating_add(provisioning);
        let queued_runnable = runnable_count(&c, now_ms, max_attempts)?;
        let mut batches = Vec::new();
        let mut stmt = c.prepare("SELECT batch_id,payload_json FROM batches ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (batch_id, payload) = row?;
            let payload: Value = serde_json::from_str(&payload)?;
            let active: u32 = c.query_row("SELECT COUNT(*) FROM attempts a JOIN tasks t USING(task_id) WHERE t.batch_id=?1 AND json_extract(a.payload_json,'$.state') IN ('provisioning','running')", [&batch_id], |r| r.get(0))?;
            let queued = count_runnable_batch(&c, &batch_id, now_ms, max_attempts)?;
            let _ = payload;
            batches.push(BatchCapacity {
                batch_id,
                active,
                queued,
            });
        }
        Ok(Capacity {
            global_limit,
            running,
            provisioning,
            non_batch_running,
            non_batch_provisioning,
            queued_runnable,
            available_slots: global_limit.saturating_sub(active),
            batches,
        })
    }
}

fn active_count(tx: &Transaction<'_>, batch_id: Option<&str>) -> Result<u32, StoreError> {
    let sql = if batch_id.is_some() {
        "SELECT COUNT(*) FROM attempts a JOIN tasks t USING(task_id) WHERE t.batch_id=?1 AND json_extract(a.payload_json,'$.state') IN ('provisioning','running')"
    } else {
        "SELECT COUNT(*) FROM attempts WHERE json_extract(payload_json,'$.state') IN ('provisioning','running')"
    };
    Ok(match batch_id {
        Some(id) => tx.query_row(sql, [id], |r| r.get(0))?,
        None => tx.query_row(sql, [], |r| r.get(0))?,
    })
}
fn count_state(c: &rusqlite::Connection, state: &str) -> Result<u32, StoreError> {
    Ok(c.query_row(
        "SELECT COUNT(*) FROM attempts WHERE json_extract(payload_json,'$.state')=?1",
        [state],
        |r| r.get(0),
    )?)
}
fn dependencies_satisfied(tx: &Connection, task: &Value) -> Result<bool, StoreError> {
    for dep in task["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let state: Option<String> = tx
            .query_row("SELECT state FROM tasks WHERE task_id=?1", [dep], |r| {
                r.get(0)
            })
            .optional()?;
        if !matches!(state.as_deref(), Some("completed" | "succeeded")) {
            return Ok(false);
        }
    }
    Ok(true)
}
fn set_task_state(tx: &Transaction<'_>, task_id: &str, state: &str) -> Result<(), StoreError> {
    let raw: String = tx.query_row(
        "SELECT payload_json FROM tasks WHERE task_id=?1",
        [task_id],
        |r| r.get(0),
    )?;
    let mut payload: Value = serde_json::from_str(&raw)?;
    payload["state"] = Value::String(state.to_owned());
    let encoded = serde_json::to_string(&payload)?;
    tx.execute(
        "UPDATE tasks SET state=?2,payload_json=?3 WHERE task_id=?1",
        params![task_id, state, encoded],
    )?;
    tx.execute("UPDATE orchestration_resources SET payload_json=?2,updated_at=?3 WHERE resource_type='task' AND resource_id=?1", params![task_id,encoded,chrono::Utc::now().to_rfc3339()])?;
    super::append_resource_change(tx, "task", task_id, &payload)?;
    Ok(())
}
fn persist_attempt(
    tx: &Transaction<'_>,
    attempt_id: &str,
    attempt: &Value,
) -> Result<(), StoreError> {
    let encoded = serde_json::to_string(attempt)?;
    tx.execute(
        "UPDATE attempts SET payload_json=?2 WHERE attempt_id=?1",
        params![attempt_id, encoded],
    )?;
    tx.execute("UPDATE orchestration_resources SET payload_json=?2,updated_at=?3 WHERE resource_type='attempt' AND resource_id=?1", params![attempt_id,encoded,chrono::Utc::now().to_rfc3339()])?;
    super::append_resource_change(tx, "attempt", attempt_id, attempt)?;
    Ok(())
}
fn task_is_runnable(
    task_state: &str,
    latest_attempt: Option<&Value>,
    now_ms: i64,
    max_attempts: u32,
) -> bool {
    if latest_attempt
        .is_some_and(|attempt| attempt["ordinal"].as_u64().unwrap_or(0) >= u64::from(max_attempts))
    {
        return false;
    }
    match task_state {
        "queued" => latest_attempt.is_none_or(|attempt| attempt["state"] == "queued"),
        "retry_wait" => latest_attempt.is_some_and(|attempt| {
            attempt["state"] == "retry_wait"
                && attempt["retry_at_ms"]
                    .as_i64()
                    .is_some_and(|retry_at| retry_at <= now_ms)
        }),
        _ => false,
    }
}

fn runnable_count(c: &Connection, now_ms: i64, max_attempts: u32) -> Result<u32, StoreError> {
    count_runnable(c, None, now_ms, max_attempts)
}

fn count_runnable_batch(
    c: &Connection,
    batch_id: &str,
    now_ms: i64,
    max_attempts: u32,
) -> Result<u32, StoreError> {
    count_runnable(c, Some(batch_id), now_ms, max_attempts)
}

fn count_runnable(
    c: &Connection,
    batch_id: Option<&str>,
    now_ms: i64,
    max_attempts: u32,
) -> Result<u32, StoreError> {
    let sql = match batch_id {
        Some(_) => "SELECT task_id,state,payload_json FROM tasks WHERE batch_id=?1 AND state IN ('queued','retry_wait') ORDER BY rowid",
        None => "SELECT task_id,state,payload_json FROM tasks WHERE state IN ('queued','retry_wait') ORDER BY rowid",
    };
    let mut statement = c.prepare(sql)?;
    let mut count = 0;
    let mut rows = match batch_id {
        Some(id) => statement.query([id])?,
        None => statement.query([])?,
    };
    while let Some(row) = rows.next()? {
        let task_id: String = row.get(0)?;
        let task_state: String = row.get(1)?;
        let task: Value = serde_json::from_str(&row.get::<_, String>(2)?)?;
        let prior: Option<String> = c
            .query_row(
                "SELECT payload_json FROM attempts WHERE task_id=?1 ORDER BY ordinal DESC LIMIT 1",
                [&task_id],
                |r| r.get(0),
            )
            .optional()?;
        let prior: Option<Value> = prior.as_deref().map(serde_json::from_str).transpose()?;
        if task_is_runnable(&task_state, prior.as_ref(), now_ms, max_attempts)
            && dependencies_satisfied(c, &task)?
        {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    type TaskSpec<'a> = (&'a str, Vec<&'a str>);
    type BatchSpec<'a> = (&'a str, u32, Vec<TaskSpec<'a>>);

    fn setup(batch_specs: &[BatchSpec<'_>]) -> (tempfile::TempDir, ControllerStore) {
        let dir = tempdir().unwrap();
        let store = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        for (batch_id, concurrency, items) in batch_specs {
            let ids: Vec<_> = items.iter().map(|(id, _)| (*id).to_owned()).collect();
            let batch = serde_json::json!({"batch_id":batch_id,"project":"demo","repository":"https://example.test/repo","requested_revision":"main","base_commit":"abc","requested_concurrency":concurrency,"accepted_task_ids":ids});
            let tasks: Vec<_> = items.iter().map(|(id,deps)| ((*id).to_owned(),serde_json::json!({"task_id":id,"batch_id":batch_id,"project":"demo","repository":"https://example.test/repo","base_commit":"abc","prompt":format!("work-{id}"),"dependencies":deps,"state":"queued"}))).collect();
            store
                .accept_batch(super::super::BatchAcceptance {
                    key: &format!("key-{batch_id}"),
                    scope: "demo",
                    request: &serde_json::json!({"batch":batch_id}),
                    batch_id,
                    batch: &batch,
                    tasks: &tasks,
                    allow_competing: true,
                })
                .unwrap();
        }
        (dir, store)
    }

    #[test]
    fn twenty_tasks_are_fifo_bounded_and_capacity_matches() {
        let items = (0..20)
            .map(|n| {
                (
                    Box::leak(format!("task-{n:02}").into_boxed_str()) as &str,
                    vec![],
                )
            })
            .collect();
        let (_dir, store) = setup(&[("batch", 4, items)]);
        let first = store.claim_runnable(8, 100, 3, 0).unwrap();
        assert_eq!(first.len(), 4);
        assert_eq!(first[0].task_id, "task-00");
        assert_eq!(first[3].task_id, "task-03");
        let cap = store.capacity(8, 100, 3, 0, 0).unwrap();
        assert_eq!(
            (cap.provisioning, cap.queued_runnable, cap.available_slots),
            (4, 16, 4)
        );
        assert_eq!(cap.batches[0].active, 4);
        let other = ControllerStore::open(_dir.path().join("controller.sqlite3")).unwrap();
        let recovered = other.claim_runnable(8, 100, 3, 0).unwrap();
        assert_eq!(recovered.len(), 4);
        assert!(recovered.iter().all(|attempt| first
            .iter()
            .any(|claimed| { claimed.attempt["attempt_id"] == attempt.attempt["attempt_id"] })));
        assert_eq!(other.capacity(8, 100, 3, 0, 0).unwrap().provisioning, 4);
    }

    #[test]
    fn mixed_batches_obey_batch_and_global_limits_and_dependencies() {
        let (_dir, store) = setup(&[
            ("a", 2, vec![("a1", vec![]), ("a2", vec![]), ("a3", vec![])]),
            (
                "b",
                3,
                vec![("b1", vec![]), ("b2", vec![]), ("b3", vec!["b1"])],
            ),
        ]);
        let claims = store.claim_runnable(4, 0, 3, 0).unwrap();
        assert_eq!(
            claims
                .iter()
                .map(|c| c.task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a1", "a2", "b1", "b2"]
        );
        assert_eq!(
            store
                .capacity(4, 0, 3, 0, 0)
                .unwrap()
                .batches
                .iter()
                .map(|b| b.active)
                .collect::<Vec<_>>(),
            vec![2, 2]
        );
        store
            .set_attempt_and_task_state(
                claims[2].attempt["attempt_id"].as_str().unwrap(),
                "completed",
                "completed",
            )
            .unwrap();
        let refill = store.claim_runnable(4, 0, 3, 0).unwrap();
        assert_eq!(
            refill.iter().filter(|claim| claim.task_id == "b3").count(),
            1
        );
        assert_eq!(store.capacity(4, 0, 3, 0, 0).unwrap().batches[1].active, 2);
    }

    #[test]
    fn concurrent_ticks_cannot_over_admit() {
        let (dir, store) = setup(&[(
            "parallel",
            4,
            (0..20)
                .map(|n| {
                    (
                        Box::leak(format!("p{n:02}").into_boxed_str()) as &str,
                        vec![],
                    )
                })
                .collect(),
        )]);
        let other = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let left_barrier = barrier.clone();
        let left = std::thread::spawn(move || {
            left_barrier.wait();
            store.claim_runnable(8, 0, 3, 0).unwrap().len()
        });
        let right = std::thread::spawn(move || {
            barrier.wait();
            other.claim_runnable(8, 0, 3, 0).unwrap().len()
        });
        let _claimed_results = left.join().unwrap() + right.join().unwrap();
        let capacity = ControllerStore::open(dir.path().join("controller.sqlite3"))
            .unwrap()
            .capacity(8, 0, 3, 0, 0)
            .unwrap();
        assert_eq!(capacity.provisioning, 4);
        assert_eq!(capacity.batches[0].active, 4);
    }

    #[test]
    fn infrastructure_retry_restart_exhaustion_and_execution_no_retry() {
        let (dir, store) = setup(&[
            ("retry", 1, vec![("task", vec![])]),
            ("exec", 1, vec![("code", vec![])]),
        ]);
        let first = store.claim_runnable(2, 100, 2, 0).unwrap();
        store
            .record_attempt_failure(
                first[0].attempt["attempt_id"].as_str().unwrap(),
                FailureClass::Infrastructure,
                "api unavailable",
                100,
                2,
                10,
            )
            .unwrap();
        store
            .record_attempt_failure(
                first[1].attempt["attempt_id"].as_str().unwrap(),
                FailureClass::Execution,
                "test failed",
                100,
                2,
                10,
            )
            .unwrap();
        assert_eq!(store.capacity(2, 100, 2, 0, 0).unwrap().queued_runnable, 0);
        drop(store);
        let reopened = ControllerStore::open(dir.path().join("controller.sqlite3")).unwrap();
        assert_eq!(
            reopened.capacity(2, 109, 2, 0, 0).unwrap().queued_runnable,
            0
        );
        assert_eq!(
            reopened.capacity(2, 110, 2, 0, 0).unwrap().queued_runnable,
            1
        );
        assert!(reopened.claim_runnable(2, 109, 2, 0).unwrap().is_empty());
        let second = reopened.claim_runnable(2, 110, 2, 0).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].attempt["ordinal"], 2);
        assert_eq!(second[0].task_id, "task");
        reopened
            .record_attempt_failure(
                second[0].attempt["attempt_id"].as_str().unwrap(),
                FailureClass::Infrastructure,
                "still unavailable",
                120,
                2,
                10,
            )
            .unwrap();
        assert_eq!(
            reopened.get_resource("task", "task").unwrap().unwrap()["state"],
            "exhausted"
        );
        assert_eq!(
            reopened.get_resource("task", "code").unwrap().unwrap()["state"],
            "failed"
        );
        assert_eq!(reopened.attempts_for_task("task").unwrap().len(), 2);
    }

    #[test]
    fn retry_backoff_is_not_runnable_until_exact_deadline() {
        let (_dir, store) = setup(&[("delayed", 2, vec![("task", vec![])])]);
        let first = store.claim_runnable(2, 100, 3, 0).unwrap();
        store
            .record_attempt_failure(
                first[0].attempt["attempt_id"].as_str().unwrap(),
                FailureClass::Infrastructure,
                "temporary API outage",
                100,
                3,
                20,
            )
            .unwrap();

        let before = store.capacity(2, 119, 3, 0, 0).unwrap();
        assert_eq!(before.queued_runnable, 0);
        assert_eq!(before.batches[0].queued, 0);
        assert!(store.claim_runnable(2, 119, 3, 0).unwrap().is_empty());
        let due = store.capacity(2, 120, 3, 0, 0).unwrap();
        assert_eq!(due.queued_runnable, 1);
        assert_eq!(due.batches[0].queued, 1);
        let after = store.capacity(2, 121, 3, 0, 0).unwrap();
        assert_eq!(after.queued_runnable, 1);
        assert_eq!(after.batches[0].queued, 1);
        let retry = store.claim_runnable(2, 120, 3, 0).unwrap();
        assert_eq!(retry.len(), 1);
        assert_eq!(retry[0].task_id, "task");
        assert_eq!(retry[0].attempt["ordinal"], 2);
    }

    #[test]
    fn completed_attempt_releases_capacity_without_accepting_the_logical_task() {
        let (_dir, store) = setup(&[(
            "review-batch",
            1,
            vec![("first", vec![]), ("second", vec![])],
        )]);
        let first = store.claim_runnable(1, 0, 3, 0).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].task_id, "first");

        store
            .set_attempt_and_task_state(
                first[0].attempt["attempt_id"].as_str().unwrap(),
                "completed",
                "running",
            )
            .unwrap();

        assert_eq!(
            store
                .get_resource("attempt", first[0].attempt["attempt_id"].as_str().unwrap())
                .unwrap()
                .unwrap()["state"],
            "completed"
        );
        assert_eq!(
            store.get_resource("task", "first").unwrap().unwrap()["state"],
            "running"
        );
        let capacity = store.capacity(1, 0, 3, 0, 0).unwrap();
        assert_eq!(capacity.available_slots, 1);
        assert_eq!(capacity.queued_runnable, 1);

        let next = store.claim_runnable(1, 0, 3, 0).unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].task_id, "second");
    }

    #[test]
    fn non_batch_service_occupancy_consumes_global_slots() {
        let (_dir, store) = setup(&[(
            "batch",
            4,
            vec![("one", vec![]), ("two", vec![]), ("three", vec![])],
        )]);
        let claimed = store.claim_runnable(4, 100, 3, 3).unwrap();
        assert_eq!(claimed.len(), 1);
        let capacity = store.capacity(4, 100, 3, 3, 0).unwrap();
        assert_eq!(capacity.non_batch_running, 3);
        assert_eq!(capacity.provisioning, 1);
        assert_eq!(capacity.available_slots, 0);
        assert_eq!(capacity.queued_runnable, 2);
    }
}
