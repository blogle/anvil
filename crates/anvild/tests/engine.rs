use std::time::Duration;

use anvil_api::{AttentionKind, CommissionState, EventKind, NewCampaign, NewCommission};
use anvild::engine::{apply, Engine, EngineConfig, Transition};
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
            ..EngineConfig::default()
        },
    )
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
        (S::Active, Transition::Merge),
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
            .end_attempt(attempt, None, json!({"outcome": "reprompt"}))
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
        .end_attempt(first, None, json!({"outcome": "reprompt"}))
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
