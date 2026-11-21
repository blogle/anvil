use std::sync::Arc;

use anvil_api::CommissionState;
use anvild::engine::{Engine, EngineConfig};
use anvild::harness::{Harness, HarnessError, ScriptedHarness, TurnReceipt};
use anvild::sandbox::SandboxProvider;
use anvild::store::Store;
use serde_json::{json, Value};

fn receipt(session: &str, tokens: i64) -> Result<TurnReceipt, HarnessError> {
    Ok(TurnReceipt {
        session: session.to_owned(),
        tokens: Some(tokens),
    })
}

struct Loop {
    store: Store,
    engine: Engine,
    scripted: ScriptedHarness,
    workspace: std::path::PathBuf,
    campaign_id: anvil_api::CampaignId,
    commission_id: anvil_api::CommissionId,
}

async fn loop_with(
    strategy: serde_json::Value,
    script: Vec<Result<TurnReceipt, HarnessError>>,
) -> Loop {
    let store = Store::open_memory().await.unwrap();
    let campaign_id = store
        .insert_campaign(anvil_api::NewCampaign {
            name: "payments refactor".to_owned(),
            slug: "payments-refactor".to_owned(),
            context: "split the monolith service by service".to_owned(),
            strategy: json!({}),
        })
        .await
        .unwrap();
    let commission_id = store
        .insert_commission(anvil_api::NewCommission {
            campaign_id,
            title: "invoice split".to_owned(),
            slug: "invoice-split".to_owned(),
            spec: "extract invoice rendering".to_owned(),
            repo: "acme/payments".to_owned(),
            target_ref: "main".to_owned(),
            target_sha: String::new(),
            wave: 1,
            budget: json!({}),
            strategy,
        })
        .await
        .unwrap();
    store
        .insert_obligation(commission_id, "the payments suite stays green")
        .await
        .unwrap();

    let workspace = tempfile::tempdir().unwrap().keep();
    let config = EngineConfig {
        state_dir: workspace.clone(),
        daemon_url: "http://127.0.0.1:8788".to_owned(),
        ..EngineConfig::default()
    };

    let scripted = ScriptedHarness::new(script);
    let engine = Engine::new(store.clone(), config)
        .with_sandbox(Arc::new(SandboxProvider::Memory(Default::default())))
        .with_harness(Arc::new(Harness::Scripted(scripted.clone())));
    Loop {
        store,
        engine,
        scripted,
        workspace: workspace.join("workspaces").join("invoice-split"),
        campaign_id,
        commission_id,
    }
}

async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

#[tokio::test]
async fn a_commission_runs_a_turn_and_converges_on_done() {
    let harness = loop_with(json!({}), vec![receipt("s-1", 12_000)]).await;

    let report = harness.engine.tick().await.unwrap();
    assert_eq!(report.admitted, 1);
    settle().await;

    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].strategy, json!({}));
    let turns = harness.store.turns(attempts[0].id).await.unwrap();
    assert_eq!(turns.len(), 1);
    assert!(turns[0].ended_at.is_some());
    assert_eq!(turns[0].tokens, Some(12_000));
    assert_eq!(turns[0].result.as_ref().unwrap()["session"], json!("s-1"));

    let received = harness.scripted.received.lock().unwrap().clone();
    let prompt = &received[0].1;
    assert!(prompt.contains("extract invoice rendering"));
    assert!(prompt.contains("the payments suite stays green"));
    assert!(prompt.contains("anvilctl done"));

    let sandbox_files: Vec<std::path::PathBuf> = std::fs::read_dir(&harness.workspace)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .collect();
    assert!(
        sandbox_files
            .iter()
            .any(|path| path.file_name().is_some_and(|name| name == "opencode.json")),
        "provider config materialized into the workspace"
    );

    harness
        .store
        .claim_done(harness.commission_id, Some("suite green"))
        .await
        .unwrap();
    harness.engine.tick().await.unwrap();

    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(commission.state, CommissionState::NeedsReview);

    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    assert!(attempts[0].ended_at.is_some());
    assert_eq!(attempts[0].tokens, Some(12_000));
    assert_eq!(attempts[0].outcome, Some(json!({"converged": true})));

    let attention = harness.store.open_attention().await.unwrap();
    assert_eq!(attention.len(), 1);
    assert_eq!(attention[0].kind, anvil_api::AttentionKind::ReviewReady);
}

#[tokio::test]
async fn a_commission_with_oauth_strategy_materializes_auth_json_into_the_workspace() {
    let harness = loop_with(
        json!({"model": "chatgpt/gpt-5", "opencode_auth": "chatgpt"}),
        vec![receipt("s-1", 1_000)],
    )
    .await;
    harness
        .store
        .put_credential(
            "opencode-auth:chatgpt",
            "{\"chatgpt\":{\"type\":\"oauth\",\"access_token\":\"tok\"}}",
        )
        .await
        .unwrap();

    harness.engine.tick().await.unwrap();
    settle().await;

    let auth_json = std::fs::read_to_string(
        harness
            .workspace
            .join("home/.local/share/opencode/auth.json"),
    )
    .unwrap();
    assert!(auth_json.contains("oauth"));
    assert!(auth_json.contains("chatgpt"));
}

#[tokio::test]
async fn a_turn_ending_without_done_reprompts_with_a_gap() {
    let harness = loop_with(
        json!({}),
        vec![receipt("s-1", 1_000), receipt("s-1", 2_000)],
    )
    .await;

    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();
    settle().await;

    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 2);
    assert!(received[1]
        .1
        .contains("the previous turn ended without claiming done"));

    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    assert!(attempts[0].ended_at.is_none());
    let turns = harness.store.turns(attempts[0].id).await.unwrap();
    assert_eq!(turns.len(), 2);
}

#[tokio::test]
async fn a_failed_turn_is_an_env_failure_and_halts_the_commission() {
    let harness = loop_with(
        json!({}),
        vec![Err(HarnessError::ScriptExhausted), receipt("s-2", 3_000)],
    )
    .await;

    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();

    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 1);
    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        commission.state,
        CommissionState::Failed { ref cause } if cause.contains("environment failure")
    ));

    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    let turns = harness.store.turns(attempts[0].id).await.unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].result.as_ref().unwrap()["status"], json!("error"));
    assert!(attempts[0]
        .outcome
        .as_ref()
        .and_then(|o| o.get("error"))
        .and_then(Value::as_str)
        .unwrap()
        .contains("harness:"));
    let attention = harness.store.open_attention().await.unwrap();
    assert_eq!(attention[0].kind, anvil_api::AttentionKind::EnvFailure);
}

#[tokio::test]
async fn an_env_failed_attempt_halts_the_commission() {
    let harness = loop_with(json!({}), vec![receipt("s-1", 1_000)]).await;
    harness.engine.tick().await.unwrap();
    settle().await;

    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    harness
        .store
        .end_attempt(attempts[0].id, None, json!({"error": "sandbox: boom"}))
        .await
        .unwrap();

    harness.engine.tick().await.unwrap();
    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        commission.state,
        CommissionState::Failed { ref cause } if cause.contains("environment failure")
    ));
    let attention = harness.store.open_attention().await.unwrap();
    assert_eq!(attention[0].kind, anvil_api::AttentionKind::EnvFailure);
}

#[tokio::test]
async fn a_stale_attempt_without_turns_is_discarded_and_a_fresh_one_starts() {
    let harness = loop_with(
        json!({}),
        vec![receipt("s-1", 1_000), receipt("s-2", 2_000)],
    )
    .await;
    harness
        .store
        .insert_attempt(harness.commission_id, &json!({}))
        .await
        .unwrap();

    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();
    settle().await;

    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].outcome.as_ref().unwrap()["stale"], json!(true));
    assert!(attempts[0].ended_at.is_some());
    assert!(attempts[1].ended_at.is_none());
    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 1);
}

#[tokio::test]
async fn a_retry_after_a_harness_failure_starts_a_fresh_attempt() {
    let harness = loop_with(
        json!({}),
        vec![Err(HarnessError::ScriptExhausted), receipt("s-9", 5_000)],
    )
    .await;
    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();

    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(commission.state, CommissionState::Failed { .. }));

    let to = anvil_api::CommissionState::Active;
    let event = anvil_api::NewEvent {
        kind: anvil_api::EventKind::StateChanged,
        campaign_id: Some(harness.campaign_id),
        commission_id: Some(harness.commission_id),
        payload: json!({"via": "retry"}),
    };
    harness
        .store
        .transition_commission(harness.commission_id, to, &[event], None)
        .await
        .unwrap();
    harness.engine.tick().await.unwrap();
    settle().await;

    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    assert_eq!(attempts.len(), 2);
    assert!(attempts[1].ended_at.is_none());
    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 2);
    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(commission.state, CommissionState::Active);
}

#[tokio::test]
async fn a_turn_budget_stops_the_reprompt_loop() {
    let harness = loop_with(
        json!({}),
        vec![receipt("s-1", 1_000), receipt("s-2", 2_000)],
    )
    .await;
    harness
        .store
        .set_commission_budget(harness.commission_id, &json!({"turns": 1}))
        .await
        .unwrap();

    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();

    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        commission.state,
        CommissionState::Escalated { ref reason } if reason.contains("turn budget exhausted")
    ));
    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 1);
    let attention = harness.store.open_attention().await.unwrap();
    assert!(attention
        .iter()
        .any(|a| a.kind == anvil_api::AttentionKind::BudgetExhausted));
}

#[tokio::test]
async fn a_token_budget_stops_the_commission_before_more_turns() {
    let harness = loop_with(
        json!({}),
        vec![receipt("s-1", 8_000), receipt("s-2", 2_000)],
    )
    .await;
    harness
        .store
        .set_commission_budget(harness.commission_id, &json!({"tokens": 6_000}))
        .await
        .unwrap();

    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();

    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        commission.state,
        CommissionState::Escalated { ref reason } if reason.contains("token budget exhausted")
    ));
    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 1);
}

#[tokio::test]
async fn the_same_gap_three_times_escalates_instead_of_repromting() {
    let harness = loop_with(
        json!({}),
        vec![
            receipt("s-1", 1_000),
            receipt("s-2", 1_000),
            receipt("s-3", 1_000),
            receipt("s-4", 1_000),
        ],
    )
    .await;

    for _ in 0..5 {
        harness.engine.tick().await.unwrap();
        settle().await;
    }

    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        commission.state,
        CommissionState::Escalated { ref reason } if reason.contains("same gap")
    ));
    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 3);
    let attention = harness.store.open_attention().await.unwrap();
    assert!(attention
        .iter()
        .any(|a| a.kind == anvil_api::AttentionKind::AttemptStalled));
}

#[tokio::test]
async fn continuous_sessions_roll_over_after_their_token_budget() {
    let harness = loop_with(
        json!({"session_tokens": 5_000}),
        vec![receipt("s-1", 6_000), receipt("s-2", 1_000)],
    )
    .await;

    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();
    settle().await;

    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 2);
    assert_eq!(received[0].0, None);
    assert_eq!(
        received[1].0, None,
        "the rolled-over session must start fresh"
    );
    assert!(received[1]
        .1
        .contains("the prior session crossed its 5000-token budget"));
}

#[tokio::test]
async fn an_attempt_with_an_in_flight_turn_is_not_heartbeat_stalled() {
    let store = Store::open_memory().await.unwrap();
    let workspace = tempfile::tempdir().unwrap().keep();
    let config = EngineConfig {
        state_dir: workspace.clone(),
        daemon_url: "http://127.0.0.1:8788".to_owned(),
        heartbeat_timeout: std::time::Duration::from_millis(1),
        ..EngineConfig::default()
    };
    let scripted = ScriptedHarness::new(vec![receipt("s-1", 1_000)]);
    let engine = Engine::new(store.clone(), config)
        .with_sandbox(Arc::new(SandboxProvider::Memory(Default::default())))
        .with_harness(Arc::new(Harness::Scripted(scripted.clone())));

    let campaign_id = store
        .insert_campaign(anvil_api::NewCampaign {
            name: "payments refactor".to_owned(),
            slug: "payments-refactor".to_owned(),
            context: "split the monolith".to_owned(),
            strategy: json!({}),
        })
        .await
        .unwrap();
    let commission_id = store
        .insert_commission(anvil_api::NewCommission {
            campaign_id,
            title: "invoice split".to_owned(),
            slug: "invoice-split".to_owned(),
            spec: "extract invoice rendering".to_owned(),
            repo: "acme/payments".to_owned(),
            target_ref: "main".to_owned(),
            target_sha: String::new(),
            wave: 1,
            budget: json!({}),
            strategy: json!({}),
        })
        .await
        .unwrap();

    let attempt_id = store
        .insert_attempt(commission_id, &json!({}))
        .await
        .unwrap();
    store
        .insert_turn(attempt_id, "sha256:in-flight")
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    engine.tick().await.unwrap();
    let commission = store.commission(commission_id).await.unwrap().unwrap();
    assert!(
        matches!(commission.state, CommissionState::Active),
        "an in-flight turn is progress, not a stall"
    );
}

#[tokio::test]
async fn continuous_sessions_reuse_the_last_turn_session() {
    let harness = loop_with(
        json!({"session": "continuous"}),
        vec![receipt("s-1", 1_000), receipt("s-1", 2_000)],
    )
    .await;

    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();
    settle().await;

    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 2);
    assert_eq!(received[0].0, None);
    assert_eq!(received[1].0, Some("s-1".to_owned()));
}

#[tokio::test]
async fn interactive_commissions_are_not_driven() {
    let harness = loop_with(json!({}), vec![receipt("s-1", 1_000)]).await;
    harness.engine.tick().await.unwrap();
    settle().await;

    harness
        .store
        .transition_commission(
            harness.commission_id,
            anvil_api::CommissionState::Interactive,
            &[],
            None,
        )
        .await
        .unwrap();

    harness.engine.tick().await.unwrap();
    settle().await;
    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    assert_eq!(attempts.len(), 1, "no new attempt while interactive");
}
