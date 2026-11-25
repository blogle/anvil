use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anvil_api::{AttentionKind, CommissionState, EventKind, NewCampaign, NewCommission};
use anvild::engine::{apply, Engine, EngineConfig, Transition};
use anvild::harness::{Harness, HarnessError, ScriptedHarness, TurnReceipt};
use anvild::sandbox::{SandboxProvider, SandboxSpec};
#[path = "fixtures/sandbox.rs"]
mod sandbox_fixture;
use sandbox_fixture::TestSandbox;

impl TestSandbox {
    async fn is_running(&self, name: &str) -> Result<bool, anvild::sandbox::SandboxError> {
        Ok(self.handle(name).await?.is_some())
    }
}
use anvild::store::Store;
use serde_json::json;

async fn temp_store() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("secret.key"),
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    )
    .expect("write key");
    let store = Store::open(&dir.path().join("store.db"))
        .await
        .expect("open store");
    (store, dir)
}

fn campaign(name: &str) -> NewCampaign {
    NewCampaign {
        name: name.to_owned(),
        slug: name.to_owned(),
        context: String::new(),
        strategy: json!({}),
    }
}

fn commission(campaign_id: anvil_api::CampaignId, wave: i64) -> NewCommission {
    NewCommission {
        campaign_id,
        title: "invoice split".to_owned(),
        slug: format!("invoice-{wave}"),
        spec: "Extract the invoice line rendering into its own service.".to_owned(),
        repo: "acme/payments".to_owned(),
        target_ref: "main".to_owned(),
        target_sha: "a41f2c".to_owned(),
        wave,
        budget: json!({}),
        strategy: json!({}),
    }
}

fn engine(store: &Store, heartbeat_timeout: Duration, turn_timeout: Duration) -> Engine {
    Engine::new(
        store.clone(),
        EngineConfig {
            tick_interval: Duration::from_secs(10),
            heartbeat_timeout,
            turn_timeout,
            sandbox_teardown_grace: Duration::ZERO,
            ..EngineConfig::default()
        },
    )
}

#[tokio::test]
async fn terminal_commission_sandbox_is_destroyed_once_and_logged() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();
    store
        .insert_attempt(commission_id, &json!({}))
        .await
        .unwrap();
    store
        .set_commission_state(commission_id, CommissionState::Cancelled)
        .await
        .unwrap();

    let sandbox = Arc::new(TestSandbox::default());
    let stable = "anvil-payments-invoice-1";
    let legacy = "anvil-payments-invoice-1-a1";
    for name in [stable, legacy] {
        sandbox
            .start(&SandboxSpec {
                name: name.to_owned(),
                image: "anvil-sandbox:latest".to_owned(),
                workspace: _dir.path().join(name),
                files: BTreeMap::new(),
                env: BTreeMap::new(),
            })
            .await
            .unwrap();
    }
    let within_grace =
        Engine::new(store.clone(), EngineConfig::default()).with_sandbox(sandbox.clone());
    within_grace.tick().await.unwrap();
    for name in [stable, legacy] {
        assert!(sandbox.is_running(name).await.unwrap());
    }
    assert!(store
        .events_since(0, 100)
        .await
        .unwrap()
        .iter()
        .all(|event| { event.kind != EventKind::SandboxDestroyed }));
    let engine = engine(&store, mins(30), hrs(2)).with_sandbox(sandbox.clone());

    engine.tick().await.unwrap();
    for name in [stable, legacy] {
        assert!(!sandbox.is_running(name).await.unwrap());
    }
    let events = store.events_since(0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == EventKind::SandboxDestroyed)
            .count(),
        1
    );

    engine.tick().await.unwrap();
    let events = store.events_since(0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == EventKind::SandboxDestroyed)
            .count(),
        1
    );

    store
        .set_commission_state(commission_id, CommissionState::Active)
        .await
        .unwrap();
    sandbox
        .start(&SandboxSpec {
            name: "anvil-payments-invoice-1".to_owned(),
            image: "anvil-sandbox:latest".to_owned(),
            workspace: _dir.path().join(PathBuf::from("workspace-retry")),
            files: BTreeMap::new(),
            env: BTreeMap::new(),
        })
        .await
        .unwrap();
    store
        .set_commission_state(commission_id, CommissionState::Cancelled)
        .await
        .unwrap();
    engine.tick().await.unwrap();
    let events = store.events_since(0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == EventKind::SandboxDestroyed)
            .count(),
        2
    );
}

#[tokio::test]
async fn only_cancelled_and_merged_commissions_are_torn_down() {
    let (store, dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let cancelled = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();
    let merged = store
        .insert_commission(commission(campaign_id, 2))
        .await
        .unwrap();
    let failed = store
        .insert_commission(commission(campaign_id, 3))
        .await
        .unwrap();
    let escalated = store
        .insert_commission(commission(campaign_id, 4))
        .await
        .unwrap();
    store
        .set_commission_state(cancelled, CommissionState::Cancelled)
        .await
        .unwrap();
    store
        .set_commission_state(merged, CommissionState::Merged)
        .await
        .unwrap();
    store
        .set_commission_state(
            failed,
            CommissionState::Failed {
                cause: "test".to_owned(),
            },
        )
        .await
        .unwrap();
    store
        .set_commission_state(
            escalated,
            CommissionState::Escalated {
                reason: "test".to_owned(),
            },
        )
        .await
        .unwrap();

    let sandbox = Arc::new(TestSandbox::default());
    for (name, index) in [
        ("anvil-payments-invoice-1", 1),
        ("anvil-payments-invoice-2", 2),
        ("anvil-payments-invoice-3", 3),
        ("anvil-payments-invoice-4", 4),
    ] {
        sandbox
            .start(&SandboxSpec {
                name: name.to_owned(),
                image: "anvil-sandbox:latest".to_owned(),
                workspace: dir.path().join(format!("workspace-{index}")),
                files: BTreeMap::new(),
                env: BTreeMap::new(),
            })
            .await
            .unwrap();
    }

    engine(&store, mins(30), hrs(2))
        .with_sandbox(sandbox.clone())
        .tick()
        .await
        .unwrap();

    assert!(!sandbox
        .is_running("anvil-payments-invoice-1")
        .await
        .unwrap());
    assert!(!sandbox
        .is_running("anvil-payments-invoice-2")
        .await
        .unwrap());
    assert!(sandbox
        .is_running("anvil-payments-invoice-3")
        .await
        .unwrap());
    assert!(sandbox
        .is_running("anvil-payments-invoice-4")
        .await
        .unwrap());
}

#[test]
fn transition_table_allows_the_documented_paths() {
    use CommissionState as S;
    let cases = vec![
        (S::Pending, Transition::Admit, S::Active),
        (S::Active, Transition::Converge, S::NeedsReview),
        (S::Active, Transition::Pause, S::Interactive),
        (S::Interactive, Transition::Resume, S::Active),
        (S::NeedsReview, Transition::Reopen, S::Active),
        (S::NeedsReview, Transition::Merge, S::Merged),
        (
            S::Escalated { reason: "r".into() },
            Transition::Retry,
            S::Active,
        ),
        (
            S::Failed { cause: "c".into() },
            Transition::Retry,
            S::Active,
        ),
    ];
    for (from, transition, expected) in cases {
        let to = apply(&from, transition).expect("legal transition");
        assert_eq!(to, expected);
    }
}

#[test]
fn transition_table_rejects_illegal_paths() {
    use CommissionState as S;
    let cases = vec![
        (S::Pending, Transition::Merge),
        (S::Pending, Transition::Converge),
        (S::Active, Transition::Admit),
        (S::Interactive, Transition::Converge),
        (S::Merged, Transition::Retry),
        (S::Merged, Transition::Cancel),
        (S::Cancelled, Transition::Retry),
        (S::Escalated { reason: "r".into() }, Transition::Converge),
    ];
    for (from, transition) in cases {
        assert!(
            apply(&from, transition.clone()).is_err(),
            "{from:?} + {transition:?}"
        );
    }
}

#[tokio::test]
async fn first_wave_admits_immediately() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    let report = engine(&store, mins(30), hrs(2)).tick().await.unwrap();
    assert_eq!(report.admitted, 1);

    let loaded = store.commission(commission_id).await.unwrap().unwrap();
    assert_eq!(loaded.state, CommissionState::Active);

    let events = store.events_since(0, 100).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, EventKind::StateChanged);
    assert_eq!(events[0].payload["from"], "pending");
    assert_eq!(events[0].payload["to"], "active");
}

#[tokio::test]
async fn later_wave_waits_for_earlier_wave() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let first = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();
    let second = store
        .insert_commission(commission(campaign_id, 2))
        .await
        .unwrap();

    let engine = engine(&store, mins(30), hrs(2));
    engine.tick().await.unwrap();

    let report = engine.tick().await.unwrap();
    assert_eq!(report.admitted, 0);
    assert_eq!(
        store.commission(second).await.unwrap().unwrap().state,
        CommissionState::Pending
    );
    assert_eq!(
        store.commission(first).await.unwrap().unwrap().state,
        CommissionState::Active
    );
}

#[tokio::test]
async fn escalated_first_wave_does_not_block_the_second() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let first = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();
    let second = store
        .insert_commission(commission(campaign_id, 2))
        .await
        .unwrap();

    let engine = engine(&store, mins(30), hrs(2));
    engine.tick().await.unwrap();

    store
        .set_commission_state(
            first,
            CommissionState::Escalated {
                reason: "operator triage".into(),
            },
        )
        .await
        .unwrap();

    let report = engine.tick().await.unwrap();
    assert_eq!(report.admitted, 1);
    assert_eq!(
        store.commission(second).await.unwrap().unwrap().state,
        CommissionState::Active
    );
}

#[tokio::test]
async fn interactive_first_wave_blocks_the_second() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let first = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();
    store
        .insert_commission(commission(campaign_id, 2))
        .await
        .unwrap();

    let engine = engine(&store, mins(30), hrs(2));
    engine.tick().await.unwrap();

    store
        .set_commission_state(first, CommissionState::Interactive)
        .await
        .unwrap();

    let report = engine.tick().await.unwrap();
    assert_eq!(report.admitted, 0);
}

#[tokio::test]
async fn stale_attempt_heartbeat_escalates_with_events_and_attention() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    let engine = engine(&store, Duration::from_millis(40), hrs(2));
    engine.tick().await.unwrap();
    store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(80)).await;
    let report = engine.tick().await.unwrap();
    assert_eq!(report.escalated, 1);

    let loaded = store.commission(commission_id).await.unwrap().unwrap();
    assert!(matches!(
        loaded.state,
        CommissionState::Escalated { ref reason } if reason.contains("heartbeat")
    ));

    let attention = store.open_attention().await.unwrap();
    assert_eq!(attention.len(), 1);
    assert_eq!(attention[0].kind, AttentionKind::AttemptStalled);
    assert_eq!(attention[0].commission_id, commission_id);

    let events = store.events_since(0, 100).await.unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].payload["to"], "escalated");
}

#[tokio::test]
async fn fresh_attempt_heartbeats_do_not_escalate() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    let engine = engine(&store, mins(30), hrs(2));
    engine.tick().await.unwrap();
    store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();

    let report = engine.tick().await.unwrap();
    assert_eq!(report.escalated, 0);
    assert_eq!(
        store
            .commission(commission_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        CommissionState::Active
    );
}

#[tokio::test]
async fn stale_unfinished_turn_escalates() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    let engine = engine(&store, mins(30), Duration::from_millis(40));
    engine.tick().await.unwrap();
    let attempt_id = store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();
    store.insert_turn(attempt_id, "sha256:abc").await.unwrap();

    tokio::time::sleep(Duration::from_millis(80)).await;
    let report = engine.tick().await.unwrap();
    assert_eq!(report.escalated, 1);

    let loaded = store.commission(commission_id).await.unwrap().unwrap();
    assert!(matches!(
        loaded.state,
        CommissionState::Escalated { ref reason } if reason.contains("turn")
    ));
    let attention = store.open_attention().await.unwrap();
    assert_eq!(attention[0].kind, AttentionKind::AttemptStalled);
}

#[tokio::test]
async fn completed_turns_do_not_escalate() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    let engine = engine(&store, mins(30), Duration::from_millis(40));
    engine.tick().await.unwrap();
    let attempt_id = store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();
    let turn_id = store.insert_turn(attempt_id, "sha256:abc").await.unwrap();
    store
        .end_turn(turn_id, None, json!({"result": "reprompt"}))
        .await
        .unwrap();

    let report = engine.tick().await.unwrap();
    assert_eq!(report.escalated, 0);
}

#[tokio::test]
async fn exhausted_attempt_budget_escalates() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let mut new = commission(campaign_id, 1);
    new.budget = json!({"attempts": 2});
    let commission_id = store.insert_commission(new).await.unwrap();

    let engine = engine(&store, mins(30), hrs(2));
    engine.tick().await.unwrap();

    for _ in 0..2 {
        let attempt = store
            .insert_attempt(commission_id, &json!({"name":"default"}))
            .await
            .unwrap();
        store
            .end_attempt(attempt, json!({"outcome": "reprompt"}))
            .await
            .unwrap();
    }

    let report = engine.tick().await.unwrap();
    assert_eq!(report.escalated, 1);

    let attention = store.open_attention().await.unwrap();
    assert_eq!(attention.len(), 1);
    assert_eq!(attention[0].kind, AttentionKind::BudgetExhausted);
    let loaded = store.commission(commission_id).await.unwrap().unwrap();
    assert!(matches!(loaded.state, CommissionState::Escalated { .. }));
}

#[tokio::test]
async fn running_attempt_keeps_budget_unescalated() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let mut new = commission(campaign_id, 1);
    new.budget = json!({"attempts": 2});
    let commission_id = store.insert_commission(new).await.unwrap();

    let engine = engine(&store, mins(30), hrs(2));
    engine.tick().await.unwrap();

    let first = store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();
    store
        .end_attempt(first, json!({"outcome": "reprompt"}))
        .await
        .unwrap();
    store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();

    let report = engine.tick().await.unwrap();
    assert_eq!(report.escalated, 0);
}

fn mins(n: u64) -> Duration {
    Duration::from_secs(60 * n)
}

fn hrs(n: u64) -> Duration {
    Duration::from_secs(3600 * n)
}

fn receipt(session: &str, tokens: i64) -> Result<TurnReceipt, HarnessError> {
    Ok(TurnReceipt {
        session: session.to_owned(),
        tokens: Some(tokens),
    })
}

#[tokio::test]
async fn a_failed_teardown_does_not_stop_unrelated_progress() {
    let (store, dir) = temp_store().await;
    let dirty_campaign = store.insert_campaign(campaign("dirty_work")).await.unwrap();
    let dirty = store
        .insert_commission(commission(dirty_campaign, 1))
        .await
        .unwrap();
    store
        .set_commission_state(dirty, CommissionState::Cancelled)
        .await
        .unwrap();

    let live_campaign = store.insert_campaign(campaign("healthy")).await.unwrap();
    let live = store
        .insert_commission(commission(live_campaign, 1))
        .await
        .unwrap();

    let scripted = ScriptedHarness::new(vec![receipt("s-1", 1_000)]);
    let engine = Engine::new(
        store.clone(),
        EngineConfig {
            state_dir: dir.path().to_owned(),
            sandbox_teardown_grace: Duration::ZERO,
            ..EngineConfig::default()
        },
    )
    .with_sandbox(Arc::new(TestSandbox::default()))
    .with_harness(Arc::new(Harness::Scripted(scripted)));

    engine.tick().await.unwrap();

    let live_attempts = store.attempts(live).await.unwrap();
    assert_eq!(
        live_attempts.len(),
        1,
        "an active commission must still be driven the same tick a teardown fails"
    );
    let events = store.events_since(0, 100).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == EventKind::SandboxDestroyFailed
            && event.commission_id == Some(dirty)));
    assert!(!events.iter().any(
        |event| event.kind == EventKind::SandboxDestroyed && event.commission_id == Some(dirty)
    ));

    engine.tick().await.unwrap();
    let events = store.events_since(0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == EventKind::SandboxDestroyFailed
                && event.commission_id == Some(dirty))
            .count(),
        2,
        "the marker stays unset, so a failed removal retries on later ticks"
    );
}

async fn wait_for_finished_turn(store: &Store, attempt: anvil_api::AttemptId) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if store
                .turns(attempt)
                .await
                .unwrap()
                .last()
                .is_some_and(|turn| turn.ended_at.is_some())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn should finish");
}

#[tokio::test]
async fn a_failed_replacement_ends_the_attempt_without_running_the_harness() {
    let (store, dir) = temp_store().await;
    let campaign = store
        .insert_campaign(campaign("invalid_slug"))
        .await
        .unwrap();
    let commission = store
        .insert_commission(commission(campaign, 1))
        .await
        .unwrap();
    let scripted = ScriptedHarness::new(vec![receipt("unexpected", 1)]);
    let engine = Engine::new(
        store.clone(),
        EngineConfig {
            state_dir: dir.path().to_owned(),
            ..EngineConfig::default()
        },
    )
    .with_sandbox(Arc::new(TestSandbox::default()))
    .with_harness(Arc::new(Harness::Scripted(scripted.clone())));

    engine.tick().await.unwrap();
    let attempt = store.attempts(commission).await.unwrap()[0].id;
    wait_for_finished_turn(&store, attempt).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let attempts = store.attempts(commission).await.unwrap();
            if attempts[0].ended_at.is_some() {
                assert!(attempts[0].outcome.as_ref().unwrap()["error"].as_str().unwrap()
                    .starts_with("sandbox: could not remove anvil-invalid_slug-invoice-1 before starting the attempt"));
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("attempt should end after failed removal");
    assert!(scripted.received.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_retry_recreates_the_sandbox_with_updated_configuration() {
    let (store, dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(anvil_api::NewCommission {
            campaign_id,
            title: "invoice split".to_owned(),
            slug: "invoice-1".to_owned(),
            spec: "Extract the invoice line rendering.".to_owned(),
            repo: "acme/payments".to_owned(),
            target_ref: "main".to_owned(),
            target_sha: String::new(),
            wave: 1,
            budget: json!({"turns": 1}),
            strategy: json!({"model": "openai/first"}),
        })
        .await
        .unwrap();

    let scripted = ScriptedHarness::new(vec![receipt("s-1", 1_000), receipt("s-2", 1_000)]);
    let engine = Engine::new(
        store.clone(),
        EngineConfig {
            heartbeat_timeout: mins(30),
            turn_timeout: hrs(2),
            state_dir: dir.path().to_owned(),
            ..EngineConfig::default()
        },
    )
    .with_sandbox(Arc::new(TestSandbox::default()))
    .with_harness(Arc::new(Harness::Scripted(scripted)));

    engine.tick().await.unwrap();
    wait_for_finished_turn(&store, store.attempts(commission_id).await.unwrap()[0].id).await;
    engine.tick().await.unwrap();
    let commission = store.commission(commission_id).await.unwrap().unwrap();
    assert!(matches!(
        commission.state,
        CommissionState::Escalated { .. }
    ));
    let opencode =
        std::fs::read_to_string(dir.path().join("workspaces/invoice-1/opencode.json")).unwrap();
    assert!(opencode.contains("openai/first"));

    store
        .set_commission_strategy(commission_id, &json!({"model": "openai/second"}))
        .await
        .unwrap();
    let event = anvil_api::NewEvent {
        kind: EventKind::StateChanged,
        campaign_id: Some(campaign_id),
        commission_id: Some(commission_id),
        payload: json!({"via": "retry"}),
    };
    store
        .transition_commission(commission_id, CommissionState::Active, &[event], None)
        .await
        .unwrap();

    engine.tick().await.unwrap();
    wait_for_finished_turn(&store, store.attempts(commission_id).await.unwrap()[1].id).await;

    let opencode =
        std::fs::read_to_string(dir.path().join("workspaces/invoice-1/opencode.json")).unwrap();
    assert!(
        opencode.contains("openai/second"),
        "the retried attempt must run with its updated configuration"
    );
}
