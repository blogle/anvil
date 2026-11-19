use std::sync::Arc;

use anvil_api::CommissionState;
use anvild::engine::{Engine, EngineConfig};
use anvild::harness::{Harness, HarnessError, ScriptedHarness, TurnReceipt};
use anvild::sandbox::SandboxProvider;
use anvild::store::Store;
use serde_json::json;

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
async fn a_failed_turn_is_evidence_and_the_loop_continues() {
    let harness = loop_with(
        json!({}),
        vec![Err(HarnessError::ScriptExhausted), receipt("s-2", 3_000)],
    )
    .await;

    harness.engine.tick().await.unwrap();
    settle().await;
    harness.engine.tick().await.unwrap();
    settle().await;

    let received = harness.scripted.received.lock().unwrap().clone();
    assert_eq!(received.len(), 2);
    let commission = harness
        .store
        .commission(harness.commission_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(commission.state, CommissionState::Active);

    let attempts = harness.store.attempts(harness.commission_id).await.unwrap();
    let turns = harness.store.turns(attempts[0].id).await.unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].result.as_ref().unwrap()["status"], json!("error"));
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
