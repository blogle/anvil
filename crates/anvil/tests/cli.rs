use std::process::Command;

use anvild::store::Store;

async fn daemon() -> (Store, String) {
    let store = Store::open_memory().await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_store = store.clone();
    tokio::spawn(async move {
        axum::serve(listener, anvild::http::router(server_store))
            .await
            .unwrap();
    });
    (store, format!("http://{addr}"))
}

fn campaign_yaml() -> String {
    r#"
name: payments refactor
slug: payments-refactor
context: split the monolith service by service
commissions:
  - title: invoice split
    slug: invoice-split
    spec: extract invoice rendering into its own service
    repo: acme/payments
    target_ref: main
    obligations:
      - the payments suite stays green
"#
    .trim()
    .to_owned()
}

fn run_anvil(base: &str, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_anvil"))
        .env("ANVIL_URL", base)
        .args(args)
        .output()
        .expect("anvil binary runs")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_cli_walks_the_m1_loop() {
    let (_store, base) = daemon().await;
    let dir = tempfile::tempdir().unwrap();
    let campaign_file = dir.path().join("campaign.yaml");
    std::fs::write(&campaign_file, campaign_yaml()).unwrap();

    let submit = run_anvil(
        &base,
        &["campaign", "submit", campaign_file.to_str().unwrap()],
    );
    assert!(
        submit.status.success(),
        "{}",
        String::from_utf8_lossy(&submit.stderr)
    );
    let stdout = String::from_utf8_lossy(&submit.stdout);
    assert!(stdout.contains("payments-refactor"));

    let resubmit = run_anvil(
        &base,
        &["campaign", "submit", campaign_file.to_str().unwrap()],
    );
    assert!(resubmit.status.success());
    assert!(String::from_utf8_lossy(&resubmit.stdout).contains("content hash matched"));

    let ps = run_anvil(&base, &["ps"]);
    assert!(ps.status.success());
    let ps_text = String::from_utf8_lossy(&ps.stdout);
    assert!(ps_text.contains("COMMISSION"));
    assert!(ps_text.contains("invoice split"));
    assert!(ps_text.contains("pending"));

    let commissions = serde_json::from_str::<serde_json::Value>(&String::from_utf8_lossy(
        &run_anvil(&base, &["ps", "--json"]).stdout,
    ))
    .unwrap();
    let commission_id = commissions["commissions"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let status = run_anvil(&base, &["status", &commission_id]);
    assert!(status.status.success());
    let status_text = String::from_utf8_lossy(&status.stdout);
    assert!(status_text.contains("the payments suite stays green"));

    let logs = run_anvil(&base, &["logs", &commission_id]);
    assert!(logs.status.success());
    assert!(String::from_utf8_lossy(&logs.stdout).contains("campaign-created"));

    let revise = run_anvil(
        &base,
        &[
            "revise",
            &commission_id,
            "--add-obligation",
            "add integration coverage",
        ],
    );
    assert!(revise.status.success());

    let inbox = run_anvil(&base, &["inbox"]);
    assert!(inbox.status.success());
    assert!(String::from_utf8_lossy(&inbox.stdout).contains("inbox is clear"));

    let cancel = run_anvil(&base, &["cancel", &commission_id]);
    assert!(cancel.status.success());
    let again = run_anvil(&base, &["cancel", &commission_id]);
    assert_eq!(again.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&again.stderr).contains("409"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_cli_dismisses_one_or_all_inbox_items() {
    let (store, base) = daemon().await;
    let dir = tempfile::tempdir().unwrap();
    let campaign_file = dir.path().join("campaign.yaml");
    std::fs::write(&campaign_file, campaign_yaml()).unwrap();
    let submit = run_anvil(
        &base,
        &["campaign", "submit", campaign_file.to_str().unwrap()],
    );
    assert!(submit.status.success());
    let commissions = store.commissions().await.unwrap();
    let commission = commissions[0].id;
    store.agent_attention(commission, "first").await.unwrap();
    store.agent_attention(commission, "second").await.unwrap();

    let inbox =
        serde_json::from_slice::<serde_json::Value>(&run_anvil(&base, &["inbox", "--json"]).stdout)
            .unwrap();
    let first = inbox["attention"][0]["id"].as_str().unwrap();
    let dismiss = run_anvil(&base, &["inbox", "dismiss", first]);
    assert!(dismiss.status.success());
    assert_eq!(store.open_attention().await.unwrap().len(), 1);

    let dismiss_all = run_anvil(&base, &["inbox", "dismiss", "--all"]);
    assert!(dismiss_all.status.success());
    assert!(store.open_attention().await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_cli_onboards_credentials_without_echoing_them() {
    let (store, base) = daemon().await;
    let add = run_anvil(
        &base,
        &["auth", "add", "ANTHROPIC_API_KEY", "--secret", "sk-test"],
    );
    assert!(add.status.success());

    let list = run_anvil(&base, &["auth", "list"]);
    assert!(list.status.success());
    let listing = String::from_utf8_lossy(&list.stdout);
    assert!(listing.contains("ANTHROPIC_API_KEY"));
    assert!(!listing.contains("sk-test"));

    let stored = store.credential("ANTHROPIC_API_KEY").await.unwrap();
    assert_eq!(stored.as_deref(), Some("sk-test"));
}

#[tokio::test(flavor = "multi_thread")]
async fn re_adding_a_credential_updates_its_value() {
    let (store, base) = daemon().await;
    let first = run_anvil(
        &base,
        &["auth", "add", "github-installation-id", "--secret", "first"],
    );
    assert!(first.status.success());
    let second = run_anvil(
        &base,
        &[
            "auth",
            "add",
            "github-installation-id",
            "--secret",
            "second",
        ],
    );
    assert!(second.status.success());

    let stored = store.credential("github-installation-id").await.unwrap();
    assert_eq!(stored.as_deref(), Some("second"));
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_add_reads_multiline_pem_from_stdin() {
    let (store, base) = daemon().await;
    let binary = env!("CARGO_BIN_EXE_anvil");
    let mut child = Command::new(binary)
        .env("ANVIL_URL", &base)
        .args(["auth", "add", "github-app-private-key"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write as _;
    let pem =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nmore lines\n-----END RSA PRIVATE KEY-----\n";
    child
        .stdin
        .take()
        .unwrap()
        .write_all(pem.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stored = store
        .credential("github-app-private-key")
        .await
        .unwrap()
        .expect("credential exists");
    assert!(stored.starts_with("-----BEGIN RSA PRIVATE KEY-----"));
    assert!(stored.ends_with("-----END RSA PRIVATE KEY-----"));
    assert_eq!(stored.lines().count(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_urls_and_missing_files_exit_explicitly() {
    let (_store, base) = daemon().await;
    let unreachable = Command::new(env!("CARGO_BIN_EXE_anvil"))
        .env("ANVIL_URL", "http://127.0.0.1:1")
        .args(["ps"])
        .output()
        .unwrap();
    assert_eq!(unreachable.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&unreachable.stderr).contains("could not reach"));

    let missing = run_anvil(&base, &["campaign", "submit", "/nope/missing.yaml"]);
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("cannot read"));

    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("bad.yaml");
    std::fs::write(&bad, "not: [valid").unwrap();
    let yaml_error = run_anvil(&base, &["campaign", "submit", bad.to_str().unwrap()]);
    assert_eq!(yaml_error.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&yaml_error.stderr).contains("invalid yaml"));
}
