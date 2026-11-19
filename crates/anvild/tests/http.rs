use anvild::http;
use anvild::store::Store;
use serde_json::json;

async fn spawn(store: Store) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, http::router(store)).await.unwrap();
    });
    format!("http://{addr}")
}

async fn setup() -> (Store, String, anvil_api::CommissionId) {
    let store = Store::open_memory().await.unwrap();
    let campaign_id = store
        .insert_campaign(anvil_api::NewCampaign {
            name: "payments refactor".to_owned(),
            slug: "payments-refactor".to_owned(),
            context: String::new(),
            strategy: json!({}),
        })
        .await
        .unwrap();
    let commission_id = store
        .insert_commission(anvil_api::NewCommission {
            campaign_id,
            title: "invoice split".to_owned(),
            slug: "invoice-split".to_owned(),
            spec: String::new(),
            repo: "acme/payments".to_owned(),
            target_ref: "main".to_owned(),
            target_sha: String::new(),
            wave: 1,
            budget: json!({}),
            strategy: json!({}),
        })
        .await
        .unwrap();
    store
        .insert_attempt(commission_id, &json!({"name": "default"}))
        .await
        .unwrap();
    let base = spawn(store.clone()).await;
    (store, base, commission_id)
}

#[tokio::test]
async fn done_claim_reaches_the_running_attempt() {
    let (store, base, commission_id) = setup().await;
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/signals/done"))
        .bearer_auth(&token_of(&store, commission_id).await)
        .json(&json!({"notes": "suite green"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);

    let attempts = store.attempts(commission_id).await.unwrap();
    assert!(attempts[0].done_claimed_at.is_some());

    let events = store.events_since(0, 100).await.unwrap();
    let claimed = events
        .iter()
        .find(|event| event.kind == anvil_api::EventKind::DoneClaimed)
        .unwrap();
    assert_eq!(claimed.payload["notes"], json!("suite green"));

    let again = reqwest::Client::new()
        .post(format!("{base}/v1/signals/done"))
        .bearer_auth(&token_of(&store, commission_id).await)
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 204);
    let events = store.events_since(0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == anvil_api::EventKind::DoneClaimed)
            .count(),
        1
    );
}

#[tokio::test]
async fn attention_becomes_an_open_attention_item_and_event() {
    let (store, base, commission_id) = setup().await;
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/signals/attention"))
        .bearer_auth(&token_of(&store, commission_id).await)
        .json(&json!({"message": "the flake is broken upstream"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);

    let attention = store.open_attention().await.unwrap();
    assert_eq!(attention.len(), 1);
    assert_eq!(attention[0].kind, anvil_api::AttentionKind::AgentAttention);
    assert_eq!(attention[0].commission_id, commission_id);
    assert_eq!(
        attention[0].payload["message"],
        json!("the flake is broken upstream")
    );

    let events = store.events_since(0, 100).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == anvil_api::EventKind::AttentionRaised));
}

#[tokio::test]
async fn signals_without_a_valid_token_are_unauthorized() {
    let (_store, base, _commission_id) = setup().await;
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/signals/done"))
        .bearer_auth("not-a-token")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    let response = reqwest::Client::new()
        .post(format!("{base}/v1/signals/attention"))
        .json(&json!({"message": "x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn done_without_a_running_attempt_conflicts() {
    let store = Store::open_memory().await.unwrap();
    let campaign_id = store
        .insert_campaign(anvil_api::NewCampaign {
            name: "x".to_owned(),
            slug: "x".to_owned(),
            context: String::new(),
            strategy: json!({}),
        })
        .await
        .unwrap();
    let commission_id = store
        .insert_commission(anvil_api::NewCommission {
            campaign_id,
            title: "x".to_owned(),
            slug: "x".to_owned(),
            spec: String::new(),
            repo: "acme/payments".to_owned(),
            target_ref: "main".to_owned(),
            target_sha: String::new(),
            wave: 1,
            budget: json!({}),
            strategy: json!({}),
        })
        .await
        .unwrap();
    let token = store.issue_commission_token(commission_id).await.unwrap();
    let base = spawn(store).await;

    let response = reqwest::Client::new()
        .post(format!("{base}/v1/signals/done"))
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
}

async fn token_of(store: &Store, commission: anvil_api::CommissionId) -> String {
    store.issue_commission_token(commission).await.unwrap()
}
