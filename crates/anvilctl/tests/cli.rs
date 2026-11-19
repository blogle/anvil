use std::process::Command;

use anvil_api::{AttentionKind, EventKind};
use anvilctl::{attention, done, SignalError};
use anvild::store::Store;
use serde_json::json;

async fn daemon() -> (Store, String, anvil_api::CommissionId, String) {
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
    let token = store.issue_commission_token(commission_id).await.unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_store = store.clone();
    tokio::spawn(async move {
        axum::serve(listener, anvild::http::router(server_store))
            .await
            .unwrap();
    });
    let base = format!("http://{addr}");
    (store, base, commission_id, token)
}

#[tokio::test]
async fn done_and_attention_reach_the_daemon() {
    let (store, base, commission_id, token) = daemon().await;
    done(&base, &token, Some("suite green")).await.unwrap();
    attention(&base, &token, "the flake is broken")
        .await
        .unwrap();

    let attempts = store.attempts(commission_id).await.unwrap();
    assert!(attempts[0].done_claimed_at.is_some());
    let events = store.events_since(0, 100).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.kind == EventKind::DoneClaimed));
    let attention = store.open_attention().await.unwrap();
    assert_eq!(attention[0].kind, AttentionKind::AgentAttention);
}

#[tokio::test]
async fn a_rejected_token_is_an_explicit_error() {
    let (_store, base, _commission_id, _token) = daemon().await;
    assert!(matches!(
        done(&base, "bogus-token", None).await,
        Err(SignalError::Rejected)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_binary_reads_env_and_reports_failures() {
    let (_store, base, _commission_id, token) = daemon().await;
    let binary = env!("CARGO_BIN_EXE_anvilctl");

    let ok = Command::new(binary)
        .env("ANVILCTL_URL", &base)
        .env("ANVILCTL_TOKEN", &token)
        .args(["done", "--notes", "suite green"])
        .output()
        .unwrap();
    assert!(ok.status.success(), "{:?}", ok);

    let rejected = Command::new(binary)
        .env("ANVILCTL_URL", &base)
        .env("ANVILCTL_TOKEN", "bogus")
        .args(["done"])
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("rejected"));

    let missing_env = Command::new(binary)
        .env_remove("ANVILCTL_URL")
        .env_remove("ANVILCTL_TOKEN")
        .args(["done"])
        .output()
        .unwrap();
    assert_eq!(missing_env.status.code(), Some(2));
}
