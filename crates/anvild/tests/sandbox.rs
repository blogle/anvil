use std::collections::BTreeMap;
use std::path::PathBuf;

use anvild::sandbox::{run_args, PodmanProvider, SandboxError, SandboxSpec};

fn spec(name: &str) -> SandboxSpec {
    SandboxSpec {
        name: name.to_owned(),
        image: "anvil-sandbox:latest".to_owned(),
        workspace: PathBuf::from("/tmp/anvil-workspaces/invoice-split"),
        files: BTreeMap::from([(
            "opencode.json".to_owned(),
            "{\"model\":\"glm-5.3\"}".to_owned(),
        )]),
        env: BTreeMap::from([
            (
                "ANVIL_REPO_URL".to_owned(),
                "https://github.com/blogle/anvil.git".to_owned(),
            ),
            (
                "ANVIL_REPO_BRANCH".to_owned(),
                "anvil/payments/invoice-split".to_owned(),
            ),
            (
                "ANVIL_GITHUB_TOKEN".to_owned(),
                "ghp-ephemeral-token".to_owned(),
            ),
        ]),
    }
}

#[test]
fn podman_argv_binds_nix_mounts_workspace_env_and_port() {
    let args = run_args(
        &spec("anvil-invoice-split"),
        std::path::Path::new("/nix/store"),
        std::path::Path::new("/nix/var/nix/daemon-socket"),
    );
    let joined = args.join("\u{1f}");
    assert!(joined.contains("run\u{1f}-d\u{1f}--name\u{1f}anvil-invoice-split"));
    assert!(joined.contains("-v\u{1f}/nix/store:/nix/store:ro"));
    assert!(joined.contains("-v\u{1f}/nix/var/nix/daemon-socket:/nix/var/nix/daemon-socket"));
    assert!(joined.contains("-v\u{1f}/tmp/anvil-workspaces/invoice-split:/workspace"));
    assert!(joined.contains("-e\u{1f}ANVIL_GITHUB_TOKEN=ghp-ephemeral-token"));
    assert!(joined.contains("-e\u{1f}NIX_REMOTE=daemon"));
    assert!(joined.contains("-p\u{1f}127.0.0.1::4096"));
    assert!(joined.ends_with("anvil-sandbox:latest"));
    let nix_remote_index = joined
        .match_indices("NIX_REMOTE=daemon")
        .next()
        .map(|(i, _)| i)
        .unwrap();
    let branch_index = joined
        .match_indices("ANVIL_REPO_BRANCH")
        .next()
        .map(|(i, _)| i)
        .unwrap();
    assert!(branch_index < nix_remote_index, "env is deterministic");
}

#[tokio::test]
async fn start_rejects_names_podman_cannot_own() {
    for name in [
        "",
        "UPPER",
        "with_underscore",
        "with space",
        &"x".repeat(65),
    ] {
        let provider = PodmanProvider::default();
        let error = provider.start(&spec(name)).await.unwrap_err();
        assert!(matches!(error, SandboxError::InvalidName { .. }), "{name}");
    }
}

#[tokio::test]
async fn podman_contract_test() {
    if std::env::var("ANVIL_TEST_PODMAN").is_err() {
        eprintln!("skipping: ANVIL_TEST_PODMAN is not set");
        return;
    }
    let provider = PodmanProvider::default();
    let mut context = spec(&format!("anvil-test-{}", std::process::id()));
    context.workspace = tempfile::tempdir().unwrap().keep();
    context
        .env
        .insert("ANVIL_TARGET_REF".to_owned(), "main".to_owned());
    context.env.insert(
        "ANVIL_REPO_URL".to_owned(),
        "https://github.com/blogle/fieldnotes.git".to_owned(),
    );
    context
        .env
        .insert("ANVIL_REPO_BRANCH".to_owned(), "main".to_owned());
    context
        .env
        .insert("ANVIL_GITHUB_TOKEN".to_owned(), String::new());
    context.env.insert(
        "OPENCODE_SERVER_PASSWORD".to_owned(),
        "contract-test-password".to_owned(),
    );
    context.image = std::env::var("ANVIL_TEST_SANDBOX_IMAGE")
        .unwrap_or_else(|_| "anvil-sandbox:latest".to_owned());

    let handle = provider.start(&context).await.expect("sandbox starts");
    assert!(handle.serve_url.starts_with("http://127.0.0.1:"));
    assert!(provider.is_running(&handle.name).await.unwrap());

    let client = reqwest::Client::new();
    let info = client
        .get(format!("{}/api/info", handle.serve_url))
        .basic_auth("opencode", Some("contract-test-password"))
        .send()
        .await
        .expect("serve answers");
    assert!(info.status().is_success());

    let session = client
        .post(format!("{}/api/session", handle.serve_url))
        .basic_auth("opencode", Some("contract-test-password"))
        .json(&serde_json::json!({"title": "anvil contract probe"}))
        .send()
        .await
        .expect("session create answers")
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let session_id = session["data"]["id"].as_str().expect("session id");

    let wait = client
        .post(format!(
            "{}/api/experimental/session/{session_id}/wait",
            handle.serve_url
        ))
        .basic_auth("opencode", Some("contract-test-password"))
        .send()
        .await
        .expect("session wait answers");
    assert!(wait.status().is_success());

    let unauthorized = client
        .get(format!("{}/api/info", handle.serve_url))
        .send()
        .await
        .expect("serve answers without auth too");
    assert_eq!(
        unauthorized.status().as_u16(),
        401,
        "got {}",
        unauthorized.status()
    );

    provider.destroy(&handle.name).await.unwrap();
    assert!(!provider.is_running(&handle.name).await.unwrap());
}
