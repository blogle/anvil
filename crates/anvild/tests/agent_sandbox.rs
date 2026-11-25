use std::collections::BTreeMap;

use anvild::sandbox::{AgentSandboxProvider, SandboxProvider, SandboxSpec};
use anvild::store::Store;
use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Pod, Secret};
use kube::{Api, Client};
use serde_json::{json, Value};

async fn exec(args: &[&str]) -> String {
    let output = tokio::process::Command::new("kubectl")
        .args(["exec", "anvil-smoke-smoke", "--"])
        .args(args)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "kubectl exec failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

async fn start_fixture_daemon(client: Client) {
    use k8s_openapi::api::core::v1::Service;
    use kube::api::PostParams;

    let pod: Pod = serde_json::from_value(json!({
        "metadata": {"name": "anvil-smoke-daemon", "labels": {"app": "anvil-smoke-daemon"}},
        "spec": {"automountServiceAccountToken": false, "containers": [{
            "name": "daemon", "image": "docker.io/library/anvil-sandbox:latest", "imagePullPolicy": "Never",
            "command": ["/anvil-smoke/anvild", "--db", "/anvil-smoke/smoke.db", "--bind", "0.0.0.0:8788"],
            "readinessProbe": {"httpGet": {"path": "/v1/commissions", "port": 8788}},
            "volumeMounts": [{"name": "fixture", "mountPath": "/anvil-smoke"}, {"name": "nix", "mountPath": "/nix/store", "readOnly": true}]
        }], "volumes": [
            {"name": "fixture", "hostPath": {"path": "/anvil-smoke", "type": "Directory"}},
            {"name": "nix", "hostPath": {"path": "/nix/store", "type": "Directory"}}
        ]}
    })).unwrap();
    let service: Service = serde_json::from_value(json!({
        "metadata": {"name": "anvil-smoke-daemon"},
        "spec": {"selector": {"app": "anvil-smoke-daemon"}, "ports": [{"port": 8788}]}
    }))
    .unwrap();
    Api::<Pod>::namespaced(client.clone(), "default")
        .create(&PostParams::default(), &pod)
        .await
        .unwrap();
    Api::<Service>::namespaced(client, "default")
        .create(&PostParams::default(), &service)
        .await
        .unwrap();
    let output = tokio::process::Command::new("kubectl")
        .args([
            "wait",
            "--for=condition=Ready",
            "pod/anvil-smoke-daemon",
            "--timeout=60s",
        ])
        .output()
        .await
        .unwrap();
    if !output.status.success() {
        for args in [
            ["describe", "pod/anvil-smoke-daemon"],
            ["logs", "pod/anvil-smoke-daemon"],
        ] {
            let _ = tokio::process::Command::new("kubectl")
                .args(args)
                .status()
                .await;
        }
        panic!(
            "fixture daemon not ready: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test]
#[ignore = "run with just agent-sandbox-smoke in a disposable Kind cluster"]
async fn controller_runs_anvil_image_and_signals_with_a_persistent_workspace() {
    let kubeconfig = std::env::var("KUBECONFIG").expect("explicit disposable kubeconfig");
    let config = kube::config::Kubeconfig::read_from(kubeconfig).unwrap();
    assert!(config
        .current_context
        .as_deref()
        .is_some_and(|context| context.starts_with("kind-anvil-as-")));
    let config = kube::Config::from_custom_kubeconfig(config, &Default::default())
        .await
        .unwrap();
    let client = Client::try_from(config).unwrap();
    let provider = AgentSandboxProvider::new(client.clone(), "default");
    let dir = std::path::PathBuf::from(std::env::var_os("ANVIL_TEST_KIND_FIXTURE").unwrap());
    std::fs::write(dir.join("secret.key"), "01".repeat(32)).unwrap();
    let store = Store::open(&dir.join("smoke.db")).await.unwrap();
    let campaign_id = store
        .insert_campaign(anvil_api::NewCampaign {
            name: "smoke".into(),
            slug: "smoke".into(),
            context: String::new(),
            strategy: json!({}),
        })
        .await
        .unwrap();
    let commission = store
        .insert_commission(anvil_api::NewCommission {
            campaign_id,
            title: "smoke".into(),
            slug: "smoke".into(),
            spec: String::new(),
            repo: "blogle/fieldnotes".into(),
            target_ref: "main".into(),
            target_sha: String::new(),
            wave: 1,
            budget: json!({}),
            strategy: json!({}),
        })
        .await
        .unwrap();
    let attempt = store.insert_attempt(commission, &json!({})).await.unwrap();
    let token = store.issue_commission_token(commission).await.unwrap();
    store
        .set_commission_state(commission, anvil_api::CommissionState::Interactive)
        .await
        .unwrap();
    start_fixture_daemon(client.clone()).await;
    let mut spec = SandboxSpec {
        name: "anvil-smoke-smoke".into(),
        image: "docker.io/library/anvil-sandbox:latest".into(),
        workspace: Default::default(),
        files: BTreeMap::from([("opencode.json".into(), "{}".into())]),
        env: BTreeMap::from([
            (
                "ANVIL_REPO_URL".into(),
                "https://github.com/blogle/fieldnotes.git".into(),
            ),
            ("ANVIL_REPO_BRANCH".into(), "main".into()),
            ("ANVIL_TARGET_REF".into(), "main".into()),
            ("ANVIL_GITHUB_TOKEN".into(), String::new()),
            ("OPENCODE_SERVER_PASSWORD".into(), "first-launch".into()),
            ("ANVILCTL_TOKEN".into(), token),
            (
                "ANVILCTL_URL".into(),
                "http://anvil-smoke-daemon.default.svc.cluster.local:8788".into(),
            ),
        ]),
    };
    let handle = provider.start(&spec).await.unwrap();
    assert_eq!(
        provider.handle(&spec.name).await.unwrap(),
        Some(handle.clone())
    );
    let session: Value = serde_json::from_str(
        &exec(&[
            "/bin/curl",
            "-fsS",
            "--max-time",
            "10",
            "-u",
            "opencode:first-launch",
            "-H",
            "Content-Type: application/json",
            "-d",
            r#"{"title":"Agent Sandbox smoke"}"#,
            &format!("{}/api/session", handle.serve_url),
        ])
        .await,
    )
    .unwrap();
    assert!(session["data"]["id"].as_str().is_some());
    assert_eq!(exec(&["/bin/cat", "/workspace/opencode.json"]).await, "{}");
    exec(&[
        "/bin/nix",
        "--extra-experimental-features",
        "nix-command",
        "store",
        "ping",
        "--store",
        "daemon",
    ])
    .await;
    exec(&["/bin/sh", "-c", "printf retained > /workspace/retry-marker"]).await;
    exec(&[
        "/bin/anvilctl",
        "done",
        "--notes",
        "Agent Sandbox signal probe",
    ])
    .await;
    let attempts = store.attempts(commission).await.unwrap();
    assert_eq!(attempts[0].id, attempt);
    assert!(attempts[0].done_claimed_at.is_some());

    let claims: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), "default");
    let uid = claims.get(&spec.name).await.unwrap().metadata.uid.unwrap();
    provider.destroy(&spec.name).await.unwrap();
    assert!(provider.handle(&spec.name).await.unwrap().is_none());
    let pods: Api<Pod> = Api::namespaced(client.clone(), "default");
    let secrets: Api<Secret> = Api::namespaced(client.clone(), "default");
    assert!(pods.get_opt(&spec.name).await.unwrap().is_none());
    assert!(secrets
        .get_opt(&format!("{}.launch", spec.name))
        .await
        .unwrap()
        .is_none());
    spec.env
        .insert("OPENCODE_SERVER_PASSWORD".into(), "second-launch".into());
    let handle = provider.start(&spec).await.unwrap();
    assert_eq!(
        claims
            .get(&spec.name)
            .await
            .unwrap()
            .metadata
            .uid
            .as_deref(),
        Some(uid.as_str())
    );
    assert_eq!(
        exec(&["/bin/cat", "/workspace/retry-marker"]).await,
        "retained"
    );
    exec(&[
        "/bin/curl",
        "-fsS",
        "--max-time",
        "10",
        "-u",
        "opencode:second-launch",
        &format!("{}/api/info", handle.serve_url),
    ])
    .await;
    store
        .set_commission_state(commission, anvil_api::CommissionState::Cancelled)
        .await
        .unwrap();
    let engine = anvild::engine::Engine::new(
        store.clone(),
        anvild::engine::EngineConfig {
            sandbox_teardown_grace: std::time::Duration::ZERO,
            ..Default::default()
        },
    )
    .with_sandbox(std::sync::Arc::new(AgentSandboxProvider::new(
        client, "default",
    )));
    engine.tick().await.unwrap();
    assert!(provider.handle(&spec.name).await.unwrap().is_none());
    assert!(pods.get_opt(&spec.name).await.unwrap().is_none());
    assert!(secrets
        .get_opt(&format!("{}.launch", spec.name))
        .await
        .unwrap()
        .is_none());
    assert!(claims.get_opt(&spec.name).await.unwrap().is_some());
    engine.tick().await.unwrap();
}
