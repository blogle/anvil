use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anvil_api::{CommissionState, EventKind, NewCampaign, NewCommission};
use anvild::engine::{Engine, EngineConfig};
use anvild::harness::{Harness, ScriptedHarness, TurnReceipt};
use anvild::sandbox::SandboxProvider;
use anvild::store::Store;
use serde_json::json;

mod common;

#[tokio::test]
async fn failed_checks_reprompt_with_reported_evidence_then_green_checks_converge() {
    let live = std::env::var_os("ANVIL_TEST_PODMAN").is_some();
    let dir = tempfile::tempdir().unwrap();
    let slug = format!("feedback-{}", anvil_api::CampaignId::new());
    let slug = &slug[..21];
    let sandbox_name = format!("anvil-{slug}-invoice");
    let sandbox = Arc::new(if live {
        SandboxProvider::Podman(Default::default())
    } else {
        SandboxProvider::Memory(Default::default())
    });
    let _cleanup = ContainerCleanup(live.then_some(sandbox_name.clone()));
    if live {
        let repo = dir.path().join("workspaces/invoice/repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(&repo)
            .args(["init", "--quiet", "--initial-branch=work"])
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .current_dir(&repo)
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "Fixture base"
            ])
            .status()
            .unwrap()
            .success());
    }

    let green = Arc::new(AtomicBool::new(false));
    let check = green.clone();
    let github = common::MockGithub::spawn(Box::new(move |method, path, _| {
        let body = match (method, path) {
            ("POST", "/app/installations/1/access_tokens") => json!({"token":"fixture"}),
            ("GET", "/repos/acme/payments/pulls/7") => {
                json!({"number":7,"state":"open","mergeable":true,"base":{"sha":"base"},"head":{"sha":"head"}})
            }
            ("GET", "/repos/acme/payments/git/ref/heads/main") => json!({"object":{"sha":"base"}}),
            ("GET", "/repos/acme/payments/pulls/7/commits") => {
                json!([{"commit":{"message":"Add invoice tests"}}])
            }
            ("GET", "/repos/acme/payments/commits/head/check-runs") => {
                json!({"check_runs":[{"name":"invoice suite","status":"completed","conclusion": if check.load(Ordering::SeqCst) { "success" } else { "failure" }}]})
            }
            _ => return (404, "{}".into()),
        };
        (200, body.to_string())
    }));
    let store = Store::open_memory().await.unwrap();
    let campaign = store
        .insert_campaign(NewCampaign {
            name: "Payments".into(),
            slug: slug.into(),
            context: String::new(),
            strategy: json!({}),
        })
        .await
        .unwrap();
    let commission = store
        .insert_commission(NewCommission {
            campaign_id: campaign,
            title: "Invoice".into(),
            slug: "invoice".into(),
            spec: "Extract invoice rendering".into(),
            repo: "acme/payments".into(),
            target_ref: "main".into(),
            target_sha: "base".into(),
            wave: 1,
            budget: json!({}),
            strategy: json!({}),
        })
        .await
        .unwrap();
    store
        .provision_and_transition(commission, CommissionState::Active, "base", "work", 7, &[])
        .await
        .unwrap();
    let obligation = store
        .insert_obligation(commission, "Preserve invoice totals")
        .await
        .unwrap();
    let missing = store
        .insert_obligation(commission, "Document rounding")
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = anvild::http::router(store.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let harness = ScriptedHarness::new(
        (0..2)
            .map(|_| {
                Ok(TurnReceipt {
                    session: "fixture".into(),
                    tokens: Some(10),
                })
            })
            .collect(),
    );
    let engine = Engine::new(
        store.clone(),
        EngineConfig {
            state_dir: dir.path().into(),
            daemon_url: format!("http://10.0.2.2:{port}"),
            sandbox_image: std::env::var("ANVIL_TEST_SANDBOX_IMAGE")
                .unwrap_or_else(|_| "anvil-sandbox:latest".into()),
            ..EngineConfig::default()
        },
    )
    .with_github(common::client(&github.url()))
    .with_sandbox(sandbox.clone())
    .with_harness(Arc::new(Harness::Scripted(harness.clone())));

    engine.tick().await.unwrap();
    assert_eq!(
        github.next_request(),
        "POST /app/installations/1/access_tokens"
    );
    let attempt = store.attempts(commission).await.unwrap()[0].id;
    wait_for_turns(&store, attempt, 1, live).await;
    if live {
        let id = obligation.to_string();
        for args in [
            &["report", &id, "--evidence", "commit abc123"][..],
            &["done"][..],
        ] {
            let output = tokio::process::Command::new("podman")
                .args(["exec", &sandbox_name, "/bin/anvilctl"])
                .args(args)
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    } else {
        let token = store.issue_commission_token(commission).await.unwrap();
        for (path, body) in [
            (
                format!("obligations/{obligation}"),
                json!({"action":"complete","evidence":"commit abc123"}),
            ),
            ("done".into(), json!({})),
        ] {
            reqwest::Client::new()
                .post(format!("http://127.0.0.1:{port}/v1/signals/{path}"))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
    }
    engine.tick().await.unwrap();
    wait_for_turns(&store, attempt, 2, live).await;
    let prompt = harness.received.lock().unwrap()[1].1.clone();
    assert!(prompt.contains("check failed: invoice suite"));
    assert!(prompt.contains("Agent claim (unverified): commit abc123"));
    assert!(prompt.contains(&format!(
        "Document rounding (ID: {missing})\n   No agent claim yet."
    )));
    assert!(store
        .events_since(0, 100)
        .await
        .unwrap()
        .iter()
        .any(|event| event.kind == EventKind::GapDetected
            && event.payload["gaps"] == json!(["check failed: invoice suite"])));
    assert_eq!(
        store.commission(commission).await.unwrap().unwrap().state,
        CommissionState::Active
    );

    green.store(true, Ordering::SeqCst);
    store.claim_done(commission, None).await.unwrap();
    engine.tick().await.unwrap();
    assert_eq!(
        store.commission(commission).await.unwrap().unwrap().state,
        CommissionState::NeedsReview
    );
    assert_eq!(harness.received.lock().unwrap().len(), 2);
    assert_eq!(
        store.open_attention().await.unwrap()[0].kind,
        anvil_api::AttentionKind::ReviewReady
    );
    if live {
        sandbox.destroy(&sandbox_name).await.unwrap();
    }
}

async fn wait_for_turns(store: &Store, attempt: anvil_api::AttemptId, count: usize, live: bool) {
    tokio::time::timeout(
        std::time::Duration::from_secs(if live { 130 } else { 5 }),
        async {
            loop {
                let turns = store.turns(attempt).await.unwrap();
                if turns.len() == count && turns.iter().all(|turn| turn.ended_at.is_some()) {
                    assert_eq!(
                        turns[count - 1].result.as_ref().unwrap()["status"],
                        "ok",
                        "{:?}",
                        turns[count - 1].result
                    );
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        },
    )
    .await
    .expect("turn should finish");
}

struct ContainerCleanup(Option<String>);

impl Drop for ContainerCleanup {
    fn drop(&mut self) {
        if let Some(name) = &self.0 {
            let _ = std::process::Command::new("podman")
                .args(["rm", "-f", name])
                .output();
        }
    }
}
