use anvil_api::{
    AttentionKind, CommissionState, EventKind, NewAttention, NewCampaign, NewCommission, NewEvent,
};
use anvild::store::{Store, StoreError};
use serde_json::{json, Value};

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
        context: "shared brief".to_owned(),
        strategy: json!({"model": "glm-5.3"}),
    }
}

fn commission(campaign_id: anvil_api::CampaignId, wave: i64) -> NewCommission {
    NewCommission {
        campaign_id,
        title: "split invoice service".to_owned(),
        slug: "invoice-split".to_owned(),
        spec: "Extract the invoice line rendering into its own service.".to_owned(),
        repo: "acme/payments".to_owned(),
        target_ref: "main".to_owned(),
        target_sha: "a41f2c".to_owned(),
        wave,
        budget: json!({"attempts": 8}),
        strategy: json!({"model": "glm-5.3"}),
    }
}

#[tokio::test]
async fn campaign_round_trips() {
    let (store, _dir) = temp_store().await;
    let id = store
        .insert_campaign(campaign("payments-refactor"))
        .await
        .unwrap();
    let loaded = store.campaign(id).await.unwrap().expect("campaign exists");
    assert_eq!(loaded.id, id);
    assert_eq!(loaded.name, "payments-refactor");
    assert_eq!(loaded.strategy, json!({"model": "glm-5.3"}));
    assert_eq!(store.campaigns().await.unwrap().len(), 1);
}

#[tokio::test]
async fn provision_and_transition_admits_with_branch_pr_and_resolved_sha() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    store
        .provision_and_transition(
            id,
            CommissionState::Active,
            "resolved999",
            "anvil/payments/invoice-split",
            7,
            &[NewEvent {
                kind: EventKind::CommissionAdmitted,
                campaign_id: Some(campaign_id),
                commission_id: Some(id),
                payload: json!({"branch": "anvil/payments/invoice-split"}),
            }],
        )
        .await
        .unwrap();

    let loaded = store.commission(id).await.unwrap().unwrap();
    assert_eq!(loaded.state, CommissionState::Active);
    assert_eq!(loaded.target_sha, "resolved999");
    assert_eq!(loaded.branch, "anvil/payments/invoice-split");
    assert_eq!(loaded.pr_number, Some(7));

    let events = store.events_since(0, 100).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == EventKind::CommissionAdmitted));
}

#[tokio::test]
async fn commission_starts_pending_and_preserves_state_detail() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    let loaded = store
        .commission(id)
        .await
        .unwrap()
        .expect("commission exists");
    assert_eq!(loaded.state, CommissionState::Pending);
    assert_eq!(loaded.target_ref, "main");
    assert_eq!(loaded.target_sha, "a41f2c");
    assert_eq!(
        loaded.spec,
        "Extract the invoice line rendering into its own service."
    );

    store
        .set_commission_state(
            id,
            CommissionState::Escalated {
                reason: "no progress".into(),
            },
        )
        .await
        .unwrap();
    let loaded = store.commission(id).await.unwrap().unwrap();
    assert_eq!(
        loaded.state,
        CommissionState::Escalated {
            reason: "no progress".into()
        }
    );

    let active = store
        .commissions_in_state(&CommissionState::Active)
        .await
        .unwrap();
    assert!(active.is_empty());
    let escalated = store
        .commissions_in_state(&CommissionState::Escalated {
            reason: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(escalated.len(), 1);
    assert_eq!(escalated[0].id, id);
}

#[tokio::test]
async fn obligations_keep_insertion_order() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    store
        .insert_obligation(commission_id, "extract invoice routes")
        .await
        .unwrap();
    store
        .insert_obligation(commission_id, "keep API contract")
        .await
        .unwrap();
    let obligations = store.obligations(commission_id).await.unwrap();
    assert_eq!(obligations[0].position, 1);
    assert_eq!(obligations[0].text, "extract invoice routes");
    assert_eq!(obligations[1].position, 2);
    assert_eq!(obligations[1].commission_id, commission_id);

    store.drop_obligation(obligations[0].id).await.unwrap();
    let remaining = store.obligations(commission_id).await.unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].position, 2);
}

#[tokio::test]
async fn attempts_number_sequentially_and_end() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    let first = store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();
    let second = store
        .insert_attempt(
            commission_id,
            &json!({"name":"default","session":"continuous"}),
        )
        .await
        .unwrap();
    store.touch_attempt(second).await.unwrap();
    store
        .end_attempt(second, Some(41_000), json!({"outcome": "converged"}))
        .await
        .unwrap();

    let attempts = store.attempts(commission_id).await.unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].id, first);
    assert_eq!(attempts[0].n, 1);
    assert_eq!(attempts[0].strategy, json!({"name":"default"}));
    assert!(attempts[0].ended_at.is_none());
    assert_eq!(attempts[1].n, 2);
    assert_eq!(
        attempts[1].strategy,
        json!({"name":"default","session":"continuous"})
    );
    assert!(attempts[1].ended_at.is_some());
    assert!(attempts[1].heartbeat_at >= attempts[0].heartbeat_at);
    assert_eq!(attempts[1].tokens, Some(41_000));
    assert_eq!(attempts[1].outcome, Some(json!({"outcome": "converged"})));
}

#[tokio::test]
async fn turns_record_within_attempt() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();
    let attempt_id = store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();

    let turn_id = store.insert_turn(attempt_id, "sha256:abc").await.unwrap();
    store.insert_turn(attempt_id, "sha256:def").await.unwrap();
    store
        .end_turn(turn_id, Some(12_000), json!({"result": "reprompt"}))
        .await
        .unwrap();

    let turns = store.turns(attempt_id).await.unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].id, turn_id);
    assert_eq!(turns[0].prompt_hash, "sha256:abc");
    assert!(turns[0].ended_at.is_some());
    assert_eq!(turns[0].tokens, Some(12_000));
    assert_eq!(turns[0].result, Some(json!({"result": "reprompt"})));
    assert!(turns[1].ended_at.is_none());
}

#[tokio::test]
async fn closing_in_flight_turns_ends_only_the_undead() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();
    let attempt_id = store
        .insert_attempt(commission_id, &json!({"name":"default"}))
        .await
        .unwrap();
    let first = store.insert_turn(attempt_id, "sha256:abc").await.unwrap();
    store.insert_turn(attempt_id, "sha256:def").await.unwrap();
    store
        .end_turn(first, Some(1_000), json!({"status": "ok"}))
        .await
        .unwrap();

    let closed = store.close_in_flight_turns().await.unwrap();
    assert_eq!(closed, 1);

    let turns = store.turns(attempt_id).await.unwrap();
    assert_eq!(turns[0].tokens, Some(1_000));
    assert!(turns[1].ended_at.is_some());
    assert_eq!(
        turns[1].result.as_ref().unwrap()["error"],
        json!("daemon restarted while the turn was in flight")
    );

    let again = store.close_in_flight_turns().await.unwrap();
    assert_eq!(again, 0);
}

#[tokio::test]
async fn commission_token_spend_sums_across_attempts() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();
    let first = store
        .insert_attempt(commission_id, &json!({}))
        .await
        .unwrap();
    let second = store
        .insert_attempt(commission_id, &json!({}))
        .await
        .unwrap();
    let t1 = store.insert_turn(first, "sha256:one").await.unwrap();
    let t2 = store.insert_turn(first, "sha256:two").await.unwrap();
    let t3 = store.insert_turn(second, "sha256:three").await.unwrap();
    store
        .end_turn(t1, Some(1_000), json!({"status": "ok"}))
        .await
        .unwrap();
    store
        .end_turn(t2, Some(2_000), json!({"status": "ok"}))
        .await
        .unwrap();
    store
        .end_turn(t3, Some(4_000), json!({"status": "ok"}))
        .await
        .unwrap();

    let spent = store.commission_tokens_spent(commission_id).await.unwrap();
    assert_eq!(spent, 7_000);

    store
        .set_commission_budget(commission_id, &json!({"tokens": 10_000}))
        .await
        .unwrap();
    let commission = store.commission(commission_id).await.unwrap().unwrap();
    assert_eq!(commission.budget["tokens"], json!(10_000));
}

#[tokio::test]
async fn events_append_in_batches_with_monotonic_cursor() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    store
        .append_events(&[
            NewEvent {
                kind: EventKind::CommissionAdmitted,
                campaign_id: Some(campaign_id),
                commission_id: Some(commission_id),
                payload: json!({}),
            },
            NewEvent {
                kind: EventKind::AttemptStarted,
                campaign_id: None,
                commission_id: Some(commission_id),
                payload: json!({"n": 1}),
            },
        ])
        .await
        .unwrap();

    let first = store.events_since(0, 100).await.unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].kind, EventKind::CommissionAdmitted);
    assert_eq!(first[1].kind, EventKind::AttemptStarted);
    assert_eq!(first[1].payload, json!({"n": 1}));
    assert!(first[0].seq < first[1].seq);

    let cursor = first[1].seq;
    store
        .append_events(&[NewEvent {
            kind: EventKind::ChecksFailed,
            campaign_id: None,
            commission_id: Some(commission_id),
            payload: json!({"checks": ["integration"]}),
        }])
        .await
        .unwrap();

    let incremental = store.events_since(cursor, 100).await.unwrap();
    assert_eq!(incremental.len(), 1);
    assert_eq!(incremental[0].kind, EventKind::ChecksFailed);
    assert!(incremental[0].seq > cursor);

    assert!(store
        .events_since(incremental[0].seq, 100)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn attention_opens_and_dismisses() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let commission_id = store
        .insert_commission(commission(campaign_id, 1))
        .await
        .unwrap();

    let id = store
        .raise_attention(NewAttention {
            commission_id,
            kind: AttentionKind::ReviewReady,
            payload: json!({"pr": 481}),
        })
        .await
        .unwrap();

    let open = store.open_attention().await.unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].id, id);
    assert_eq!(open[0].kind, AttentionKind::ReviewReady);

    store.dismiss_attention(id).await.unwrap();
    assert!(store.open_attention().await.unwrap().is_empty());

    let dismissed_twice = store.dismiss_attention(id).await;
    assert!(matches!(dismissed_twice, Err(StoreError::Missing { .. })));
}

#[tokio::test]
async fn config_and_credentials_upsert() {
    let (store, _dir) = temp_store().await;
    store.set_config("concurrency", "8").await.unwrap();
    assert_eq!(
        store.config("concurrency").await.unwrap().as_deref(),
        Some("8")
    );
    store.set_config("concurrency", "4").await.unwrap();
    assert_eq!(
        store.config("concurrency").await.unwrap().as_deref(),
        Some("4")
    );
    assert_eq!(store.config("missing").await.unwrap(), None);

    store
        .put_credential("github-app", "secret-1")
        .await
        .unwrap();
    store
        .put_credential("github-app", "secret-2")
        .await
        .unwrap();
    assert_eq!(
        store.credential("github-app").await.unwrap().as_deref(),
        Some("secret-2")
    );
    assert_eq!(store.credential("missing").await.unwrap(), None);
}

#[tokio::test]
async fn missing_rows_are_explicit_failures() {
    let (store, _dir) = temp_store().await;
    let missing = anvil_api::CommissionId::new();
    let result = store
        .set_commission_state(missing, CommissionState::Active)
        .await;
    assert!(matches!(result, Err(StoreError::Missing { .. })));
}

#[tokio::test]
async fn memory_store_works() {
    let store = Store::open_memory().await.expect("open memory store");
    let id = store.insert_campaign(campaign("payments")).await.unwrap();
    assert_eq!(store.campaigns().await.unwrap().len(), 1);
    assert!(store.campaign(id).await.unwrap().is_some());
}

#[tokio::test]
async fn strategy_and_budget_survive_as_json() {
    let (store, _dir) = temp_store().await;
    let campaign_id = store.insert_campaign(campaign("payments")).await.unwrap();
    let mut new = commission(campaign_id, 2);
    new.strategy = json!({"model": "sol", "thinking": "high"});
    new.budget = Value::Null;
    let id = store.insert_commission(new).await.unwrap();
    let loaded = store.commission(id).await.unwrap().unwrap();
    assert_eq!(loaded.strategy, json!({"model": "sol", "thinking": "high"}));
    assert_eq!(loaded.budget, Value::Null);
}
