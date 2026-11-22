use anvil_api::{CheckConclusion, CommissionState, EventKind, NewEvent};
use anvild::engine::{Engine, EngineConfig};
use anvild::github::{branch_name, parse_check_runs, parse_pull, parse_ref, pr_body};
use anvild::store::Store;
use serde_json::json;

mod common;
use common::{client, MockGithub};

#[tokio::test]
async fn provision_resolves_creates_branch_and_opens_pr() {
    let mock = MockGithub::spawn(Box::new(|method, path, _| match (method, path) {
        ("POST", "/app/installations/1/access_tokens") => {
            (200, json!({"token": "inst-token"}).to_string())
        }
        ("GET", "/repos/acme/payments/git/ref/heads/main") => {
            (200, json!({"object": {"sha": "a41f2c9"}}).to_string())
        }
        ("GET", "/repos/acme/payments/git/ref/heads/anvil/payments-refactor/invoice-split") => {
            (200, json!({"object": {"sha": "a41f2c9"}}).to_string())
        }
        ("POST", "/repos/acme/payments/git/refs") => (201, "{}".to_owned()),
        ("GET", "/repos/acme/payments/git/commits/a41f2c9") => {
            (200, json!({"tree": {"sha": "tree-1"}}).to_string())
        }
        ("POST", "/repos/acme/payments/git/commits") => (201, json!({"sha": "seed-1"}).to_string()),
        ("PATCH", "/repos/acme/payments/git/refs/heads/anvil/payments-refactor/invoice-split") => {
            (200, json!({"object": {"sha": "seed-1"}}).to_string())
        }
        ("GET", p) if p.starts_with("/repos/acme/payments/pulls?head=") => (200, "[]".to_owned()),
        ("POST", "/repos/acme/payments/pulls") => (201, json!({"number": 7}).to_string()),
        _ => (404, "{}".to_owned()),
    }));

    let provisioned = client(&mock.url())
        .provision(
            "acme/payments",
            "payments-refactor",
            "invoice-split",
            "main",
            "split invoice service",
            "spec text",
        )
        .await
        .unwrap();

    assert_eq!(provisioned.target_sha, "a41f2c9");
    assert_eq!(provisioned.branch, "anvil/payments-refactor/invoice-split");
    assert_eq!(provisioned.pr_number, 7);
}

#[tokio::test]
async fn provision_is_idempotent_when_branch_and_pr_exist() {
    let mock = MockGithub::spawn(Box::new(|method, path, _| match (method, path) {
        ("POST", "/app/installations/1/access_tokens") => {
            (200, json!({"token": "inst-token"}).to_string())
        }
        ("GET", "/repos/acme/payments/git/ref/heads/main") => {
            (200, json!({"object": {"sha": "a41f2c9"}}).to_string())
        }
        ("GET", "/repos/acme/payments/git/ref/heads/anvil/payments-refactor/invoice-split") => (
            200,
            json!({"object": {"sha": "agent-pushed-1"}}).to_string(),
        ),
        ("POST", "/repos/acme/payments/git/refs") => (
            422,
            json!({"message": "Reference already exists"}).to_string(),
        ),
        ("GET", p) if p.starts_with("/repos/acme/payments/pulls?head=") => {
            (200, json!([{"number": 7, "state": "open"}]).to_string())
        }
        _ => (404, "{}".to_owned()),
    }));

    let provisioned = client(&mock.url())
        .provision(
            "acme/payments",
            "payments-refactor",
            "invoice-split",
            "main",
            "split invoice service",
            "spec",
        )
        .await
        .unwrap();
    assert_eq!(provisioned.pr_number, 7);
    assert_eq!(provisioned.branch, "anvil/payments-refactor/invoice-split");
}

#[tokio::test]
async fn external_state_maps_checks_mergeability_and_head_movement() {
    let mock = MockGithub::spawn(Box::new(|method, path, _| match (method, path) {
        ("POST", "/app/installations/1/access_tokens") => {
            (200, json!({"token": "inst-token"}).to_string())
        }
        ("GET", "/repos/acme/payments/pulls/7") => (
            200,
            json!({"number": 7, "state": "open", "mergeable": true,
                       "head": {"sha": "head123"}, "base": {"sha": "target-1"}})
            .to_string(),
        ),
        ("GET", "/repos/acme/payments/pulls/7/commits") => (
            200,
            json!([{"commit": {"message": "anvil: begin"}},
                   {"commit": {"message": "feat: teardown terminal sandboxes"}}])
            .to_string(),
        ),
        ("GET", "/repos/acme/payments/commits/head123/check-runs") => (
            200,
            json!({"check_runs": [
                {"name": "go test", "conclusion": "failure"},
                {"name": "lint", "conclusion": "success"},
                {"name": "race", "conclusion": null}
            ]})
            .to_string(),
        ),
        ("GET", "/repos/acme/payments/git/ref/heads/main") => {
            (200, json!({"object": {"sha": "moved999"}}).to_string())
        }
        _ => (404, "{}".to_owned()),
    }));

    let state = client(&mock.url())
        .external_state("acme/payments", 7, "main", "a41f2c9")
        .await
        .unwrap();
    assert!(state.mergeable);
    assert!(state.head_moved);
    assert_eq!(state.checks.len(), 3);
    assert_eq!(state.checks[0].conclusion, CheckConclusion::Fail);
    assert_eq!(state.checks[1].conclusion, CheckConclusion::Pass);
    assert_eq!(state.checks[2].conclusion, CheckConclusion::Pending);
}

#[tokio::test]
async fn a_rebased_pr_clears_head_movement_even_after_the_target_moves() {
    let mock = MockGithub::spawn(Box::new(|method, path, _| match (method, path) {
        ("POST", "/app/installations/1/access_tokens") => {
            (200, json!({"token": "inst-token"}).to_string())
        }
        ("GET", "/repos/acme/payments/pulls/7") => (
            200,
            json!({"number": 7, "state": "open", "mergeable": true,
                       "head": {"sha": "rebased-1"}, "base": {"sha": "moved-999"}})
            .to_string(),
        ),
        ("GET", "/repos/acme/payments/pulls/7/commits") => (
            200,
            json!([{"commit": {"message": "anvil: begin"}},
                   {"commit": {"message": "make sandbox teardown durable"}}])
            .to_string(),
        ),
        ("GET", "/repos/acme/payments/commits/rebased-1/check-runs") => {
            (200, json!({"total_count": 0, "check_runs": []}).to_string())
        }
        ("GET", "/repos/acme/payments/git/ref/heads/main") => {
            (200, json!({"object": {"sha": "moved-999"}}).to_string())
        }
        _ => (404, "{}".to_owned()),
    }));

    let state = client(&mock.url())
        .external_state("acme/payments", 7, "main", "stale-admission-sha")
        .await
        .unwrap();
    assert!(
        !state.head_moved,
        "the PR base tracks the moved target: the agent already rebased"
    );
}

#[tokio::test]
async fn engine_admission_provisions_branch_pr_and_target_sha() {
    let mock = MockGithub::spawn(Box::new(|method, path, body| match (method, path) {
        ("POST", "/app/installations/1/access_tokens") => {
            (200, json!({"token": "inst-token"}).to_string())
        }
        ("GET", "/repos/acme/payments/git/ref/heads/main") => {
            (200, json!({"object": {"sha": "a41f2c9"}}).to_string())
        }
        ("POST", "/repos/acme/payments/git/refs") => (201, "{}".to_owned()),
        ("GET", "/repos/acme/payments/git/ref/heads/anvil/payments-refactor/invoice-split") => {
            (200, json!({"object": {"sha": "a41f2c9"}}).to_string())
        }
        ("GET", "/repos/acme/payments/git/commits/a41f2c9") => {
            (200, json!({"tree": {"sha": "tree-1"}}).to_string())
        }
        ("POST", "/repos/acme/payments/git/commits") => (201, json!({"sha": "seed-1"}).to_string()),
        ("PATCH", "/repos/acme/payments/git/refs/heads/anvil/payments-refactor/invoice-split") => {
            (200, json!({"object": {"sha": "seed-1"}}).to_string())
        }
        ("GET", p) if p.starts_with("/repos/acme/payments/pulls?head=") => (200, "[]".to_owned()),
        ("POST", "/repos/acme/payments/pulls") => {
            assert_eq!(body["title"], "invoice split");
            assert_eq!(body["draft"], true);
            assert!(body["body"].as_str().unwrap().contains("extract invoices"));
            (201, json!({"number": 7}).to_string())
        }
        _ => (404, "{}".to_owned()),
    }));

    let store = Store::open_memory().await.unwrap();
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
            spec: "extract invoices".to_owned(),
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
        .insert_obligation(commission_id, "the payments suite stays green")
        .await
        .unwrap();

    let engine =
        Engine::new(store.clone(), EngineConfig::default()).with_github(client(&mock.url()));
    let report = engine.tick().await.unwrap();
    assert_eq!(report.admitted, 1);

    let commission = store.commission(commission_id).await.unwrap().unwrap();
    assert_eq!(commission.state, CommissionState::Active);
    assert_eq!(commission.target_sha, "a41f2c9");
    assert_eq!(commission.branch, "anvil/payments-refactor/invoice-split");
    assert_eq!(commission.pr_number, Some(7));

    assert_eq!(
        mock.next_request(),
        "POST /app/installations/1/access_tokens"
    );
}

#[tokio::test]
async fn engine_admission_failure_fails_the_commission_with_attention() {
    let mock = MockGithub::spawn(Box::new(|method, path, _| match (method, path) {
        ("POST", "/app/installations/1/access_tokens") => {
            (200, json!({"token": "inst-token"}).to_string())
        }
        ("GET", "/repos/acme/payments/git/ref/heads/main") => {
            (500, json!({"message": "boom"}).to_string())
        }
        _ => (404, "{}".to_owned()),
    }));

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

    let engine =
        Engine::new(store.clone(), EngineConfig::default()).with_github(client(&mock.url()));
    engine.tick().await.unwrap();

    let commission = store.commission(commission_id).await.unwrap().unwrap();
    assert!(matches!(
        commission.state,
        CommissionState::Failed { ref cause } if cause.contains("provisioning failed")
    ));
    let attention = store.open_attention().await.unwrap();
    assert_eq!(attention.len(), 1);
    assert_eq!(attention[0].kind, anvil_api::AttentionKind::EnvFailure);
}

#[test]
fn branch_names_and_slugs_validate() {
    assert_eq!(
        branch_name("payments-refactor", "invoice-split").unwrap(),
        "anvil/payments-refactor/invoice-split"
    );
    assert!(branch_name("UPPER", "ok").is_err());
    assert!(branch_name("ok", "with space").is_err());
    assert!(branch_name("ok", "").is_err());
}

#[test]
fn parsers_map_github_payloads() {
    assert_eq!(
        parse_ref(&json!({"object": {"sha": "abc"}})),
        Some("abc".to_owned())
    );
    assert_eq!(parse_ref(&json!({})), None);

    let checks = parse_check_runs(&json!({"check_runs": [
        {"name": "go test", "conclusion": "timed_out"},
        {"name": "lint", "conclusion": "neutral"}
    ]}));
    assert_eq!(checks.len(), 2);
    assert_eq!(checks[0].conclusion, CheckConclusion::Fail);
    assert_eq!(checks[1].conclusion, CheckConclusion::Inconclusive);

    let pull = parse_pull(&json!({"number": 7, "state": "open", "mergeable": null,
                                  "head": {"sha": "x"}, "base": {"sha": "y"}}))
    .unwrap();
    assert!(!pull.mergeable);
    assert!(pull.open);
    assert_eq!(pull.base_sha, "y");

    let body = pr_body("extract invoices", &["suite stays green".to_owned()]);
    assert!(body.contains("extract invoices"));
    assert!(body.contains("- suite stays green"));
}

#[tokio::test]
async fn merged_prs_settle_their_commissions_terminal() {
    let mock = MockGithub::spawn(Box::new(|method, path, _| match (method, path) {
        ("POST", "/app/installations/1/access_tokens") => {
            (200, json!({"token": "inst-token"}).to_string())
        }
        ("GET", "/repos/acme/payments/pulls/7") => (
            200,
            json!({"number": 7, "state": "closed", "merged": true,
                       "head": {"sha": "head123"}, "base": {"sha": "target-1"}})
            .to_string(),
        ),
        _ => (404, "{}".to_owned()),
    }));

    let store = Store::open_memory().await.unwrap();
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
            spec: "extract invoices".to_owned(),
            repo: "acme/payments".to_owned(),
            target_ref: "main".to_owned(),
            target_sha: "a41f2c9".to_owned(),
            wave: 1,
            budget: json!({}),
            strategy: json!({}),
        })
        .await
        .unwrap();

    let event = |to: &str| NewEvent {
        kind: EventKind::StateChanged,
        campaign_id: Some(campaign_id),
        commission_id: Some(commission_id),
        payload: json!({"to": to}),
    };
    store
        .provision_and_transition(
            commission_id,
            CommissionState::NeedsReview,
            "a41f2c9",
            "anvil/payments-refactor/invoice-split",
            7,
            &[event("needs-review")],
        )
        .await
        .unwrap();

    let engine =
        Engine::new(store.clone(), EngineConfig::default()).with_github(client(&mock.url()));
    let report = engine.tick().await.unwrap();

    assert_eq!(report.merged, 1);
    let commission = store.commission(commission_id).await.unwrap().unwrap();
    assert_eq!(commission.state, CommissionState::Merged);

    store
        .transition_commission(
            commission_id,
            CommissionState::Escalated {
                reason: "stalled while the operator merged it anyway".to_owned(),
            },
            &[event("escalated")],
            None,
        )
        .await
        .unwrap();
    let report = engine.tick().await.unwrap();

    assert_eq!(report.merged, 1);
    let commission = store.commission(commission_id).await.unwrap().unwrap();
    assert_eq!(
        commission.state,
        CommissionState::Merged,
        "a merged PR makes even an escalation moot"
    );
}
