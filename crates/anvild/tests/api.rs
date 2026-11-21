use anvild::http;
use anvild::store::Store;
use serde_json::{json, Value};

async fn daemon() -> (Store, String) {
    let store = Store::open_memory().await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_store = store.clone();
    tokio::spawn(async move {
        axum::serve(listener, http::router(server_store))
            .await
            .unwrap();
    });
    (store, format!("http://{addr}"))
}

async fn post(base: &str, path: &str, body: Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{base}{path}"))
        .json(&body)
        .send()
        .await
        .unwrap()
}

async fn get(base: &str, path: &str) -> reqwest::Response {
    reqwest::Client::new()
        .get(format!("{base}{path}"))
        .send()
        .await
        .unwrap()
}

fn campaign_body() -> Value {
    json!({
        "name": "payments refactor",
        "slug": "payments-refactor",
        "context": "split the monolith",
        "commissions": [{
            "title": "invoice split",
            "slug": "invoice-split",
            "spec": "extract invoice rendering",
            "repo": "acme/payments",
            "target_ref": "main",
            "obligations": ["the payments suite stays green"],
        }],
    })
}

#[tokio::test]
async fn submitting_a_campaign_lands_it_and_its_commissions() {
    let (store, base) = daemon().await;
    let response = post(&base, "/v1/campaigns", campaign_body()).await;
    assert_eq!(response.status(), 201);
    let campaign: Value = response.json().await.unwrap();
    let campaign_id = campaign["id"].as_str().unwrap().to_owned();

    let commissions: Value = get(&base, "/v1/commissions").await.json().await.unwrap();
    assert_eq!(commissions["commissions"].as_array().unwrap().len(), 1);
    assert_eq!(
        commissions["commissions"][0]["campaign_id"]
            .as_str()
            .unwrap(),
        campaign_id
    );
    assert_eq!(commissions["commissions"][0]["state"]["kind"], "pending");

    let detail: Value = get(
        &base,
        &format!(
            "/v1/commissions/{}",
            commissions["commissions"][0]["id"].as_str().unwrap()
        ),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(
        detail["obligations"][0]["text"],
        json!("the payments suite stays green")
    );

    let events = get(&base, "/v1/events?since=0").await;
    assert_eq!(events.status(), 200);
    let _ = events;
    let stored = store.campaigns().await.unwrap();
    assert_eq!(stored.len(), 1);
}

#[tokio::test]
async fn duplicate_slugs_conflict_not_crash() {
    let (_store, base) = daemon().await;
    let first = post(&base, "/v1/campaigns", campaign_body()).await;
    assert_eq!(first.status(), 201);
    let second = post(&base, "/v1/campaigns", campaign_body()).await;
    assert_eq!(second.status(), 409);
}

#[tokio::test]
async fn idempotency_keys_replay_the_first_response() {
    let (store, base) = daemon().await;
    let client = reqwest::Client::new();
    let first = client
        .post(format!("{base}/v1/campaigns"))
        .header("idempotency-key", "submit-1")
        .json(&campaign_body())
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 201);
    let first_id: Value = first.json().await.unwrap();

    let replay = client
        .post(format!("{base}/v1/campaigns"))
        .header("idempotency-key", "submit-1")
        .json(&campaign_body())
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), 200);
    let replay_id: Value = replay.json().await.unwrap();
    assert_eq!(first_id["id"], replay_id["id"]);

    assert_eq!(store.campaigns().await.unwrap().len(), 1);
}

#[tokio::test]
async fn operator_actions_transition_and_conflict_explicitly() {
    let (_store, base) = daemon().await;
    let campaign: Value = post(&base, "/v1/campaigns", campaign_body())
        .await
        .json()
        .await
        .unwrap();
    let _ = campaign;
    let commissions: Value = get(&base, "/v1/commissions").await.json().await.unwrap();
    let commission_id = commissions["commissions"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let cancel = reqwest::Client::new()
        .delete(format!("{base}/v1/commissions/{commission_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(cancel.status(), 204);

    let again = reqwest::Client::new()
        .delete(format!("{base}/v1/commissions/{commission_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 409);

    let bogus = post(
        &base,
        &format!("/v1/commissions/{commission_id}"),
        json!({"action": "self-destruct"}),
    )
    .await;
    assert_eq!(bogus.status(), 400);
}

#[tokio::test]
async fn obligations_can_be_added_and_dropped() {
    let (_store, base) = daemon().await;
    let _campaign: Value = post(&base, "/v1/campaigns", campaign_body())
        .await
        .json()
        .await
        .unwrap();
    let commissions: Value = get(&base, "/v1/commissions").await.json().await.unwrap();
    let commission_id = commissions["commissions"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let added = post(
        &base,
        &format!("/v1/commissions/{commission_id}/obligations"),
        json!({"text": "add integration coverage"}),
    )
    .await;
    assert_eq!(added.status(), 201);

    let detail: Value = get(&base, &format!("/v1/commissions/{commission_id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail["obligations"].as_array().unwrap().len(), 2);

    let obligation_id = detail["obligations"][0]["id"].as_str().unwrap().to_owned();
    let dropped = reqwest::Client::new()
        .delete(format!("{base}/v1/obligations/{obligation_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(dropped.status(), 204);
}

#[tokio::test]
async fn inbox_lists_and_dismisses_attention() {
    let (store, base) = daemon().await;
    let campaign: Value = post(&base, "/v1/campaigns", campaign_body())
        .await
        .json()
        .await
        .unwrap();
    let commissions: Value = get(&base, "/v1/commissions").await.json().await.unwrap();
    let commission_id = commissions["commissions"][0]["id"].as_str().unwrap();
    let commission_id: anvil_api::CommissionId = commission_id.parse().unwrap();
    let _ = campaign;
    store
        .agent_attention(commission_id, "the flake is broken")
        .await
        .unwrap();

    let inbox: Value = get(&base, "/v1/inbox").await.json().await.unwrap();
    assert_eq!(inbox["attention"].as_array().unwrap().len(), 1);
    assert_eq!(inbox["attention"][0]["kind"], json!("agent-attention"));

    let attention_id = inbox["attention"][0]["id"].as_str().unwrap().to_owned();
    let dismissed = post(
        &base,
        &format!("/v1/inbox/{attention_id}/dismiss"),
        json!({}),
    )
    .await;
    assert_eq!(dismissed.status(), 204);

    let inbox: Value = get(&base, "/v1/inbox").await.json().await.unwrap();
    assert_eq!(inbox["attention"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn the_events_stream_is_sse_with_typed_frames() {
    let (store, base) = daemon().await;
    let _campaign: Value = post(&base, "/v1/campaigns", campaign_body())
        .await
        .json()
        .await
        .unwrap();
    let _ = store;

    let client = reqwest::Client::new();
    let mut response = client
        .get(format!("{base}/v1/events?since=0"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()["content-type"].to_str().unwrap(),
        "text/event-stream"
    );

    let mut buffer = String::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                if buffer.contains("campaign-created") {
                    break;
                }
            }
            _ => break,
        }
    }
    assert!(buffer.contains("event: campaign-created"), "{buffer}");
    assert!(buffer.contains("\"seq\":1"), "{buffer}");
}

#[tokio::test]
async fn cursor_gets_return_only_newer_commissions() {
    let (_store, base) = daemon().await;
    let _campaign: Value = post(&base, "/v1/campaigns", campaign_body())
        .await
        .json()
        .await
        .unwrap();
    let commissions: Value = get(&base, "/v1/commissions").await.json().await.unwrap();
    let updated_at = commissions["commissions"][0]["updated_at"]
        .as_i64()
        .unwrap();

    let fresh: Value = get(&base, "/v1/commissions?since=0")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(fresh["commissions"].as_array().unwrap().len(), 1);
    let none: Value = get(&base, &format!("/v1/commissions?since={updated_at}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(none["commissions"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn retry_requeues_unprovisioned_commissions_and_resumes_provisioned_ones() {
    let (store, base) = daemon().await;
    let campaign: Value = post(&base, "/v1/campaigns", campaign_body())
        .await
        .json()
        .await
        .unwrap();
    let campaign_id = campaign["id"].as_str().unwrap().to_owned();
    let commissions: Value = get(&base, "/v1/commissions").await.json().await.unwrap();
    let commission_id: anvil_api::CommissionId = commissions["commissions"][0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let state_changed = || anvil_api::NewEvent {
        kind: anvil_api::EventKind::StateChanged,
        campaign_id: Some(campaign_id.parse().unwrap()),
        commission_id: Some(commission_id),
        payload: json!({"to": "failed"}),
    };

    store
        .transition_commission(
            commission_id,
            anvil_api::CommissionState::Failed {
                cause: "sandbox: boom".to_owned(),
            },
            &[state_changed()],
            None,
        )
        .await
        .unwrap();

    let requeue = post(
        &base,
        &format!("/v1/commissions/{commission_id}"),
        json!({"action": "retry"}),
    )
    .await;
    assert_eq!(requeue.status(), 204);
    let detail: Value = get(&base, &format!("/v1/commissions/{commission_id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail["commission"]["state"]["kind"], json!("pending"));

    store
        .provision_and_transition(
            commission_id,
            anvil_api::CommissionState::Failed {
                cause: "harness: boom".to_owned(),
            },
            "resolved999",
            "anvil/payments/invoice-split",
            7,
            &[state_changed()],
        )
        .await
        .unwrap();

    let resume = post(
        &base,
        &format!("/v1/commissions/{commission_id}"),
        json!({"action": "retry"}),
    )
    .await;
    assert_eq!(resume.status(), 204);
    let detail: Value = get(&base, &format!("/v1/commissions/{commission_id}"))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail["commission"]["state"]["kind"], json!("active"));
}

#[tokio::test]
async fn retry_with_a_model_sets_the_next_attempts_tier() {
    let (store, base) = daemon().await;
    let campaign: Value = post(&base, "/v1/campaigns", campaign_body())
        .await
        .json()
        .await
        .unwrap();
    let _campaign_id = campaign["id"].as_str().unwrap().to_owned();
    let commissions: Value = get(&base, "/v1/commissions").await.json().await.unwrap();
    let commission_id: anvil_api::CommissionId = commissions["commissions"][0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let event = anvil_api::NewEvent {
        kind: anvil_api::EventKind::StateChanged,
        campaign_id: Some(campaign["id"].as_str().unwrap().parse().unwrap()),
        commission_id: Some(commission_id),
        payload: json!({"to": "failed"}),
    };
    store
        .transition_commission(
            commission_id,
            anvil_api::CommissionState::Failed {
                cause: "harness: boom".to_owned(),
            },
            &[event],
            None,
        )
        .await
        .unwrap();

    let retry = post(
        &base,
        &format!("/v1/commissions/{commission_id}"),
        json!({"action": "retry", "model": "openai/gpt-6.1-luna#high"}),
    )
    .await;
    assert_eq!(retry.status(), 204);

    let commission = store.commission(commission_id).await.unwrap().unwrap();
    assert_eq!(
        commission.strategy["model"],
        json!("openai/gpt-6.1-luna#high")
    );
}
