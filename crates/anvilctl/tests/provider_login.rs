use httpmock::{Method::GET, MockServer};
use std::process::{Command, Stdio};

#[test]
fn legacy_provider_login_warns_before_prompting() {
    let server = MockServer::start();
    let providers = server.mock(|when, then| {
        when.method(GET).path("/v1/providers");
        then.status(503).body("provider discovery unavailable");
    });
    let login = server.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/v1/providers/example/login");
        then.status(500);
    });

    let output = Command::new(env!("CARGO_BIN_EXE_anvilctl"))
        .args([
            "--server",
            &server.base_url(),
            "providers",
            "login",
            "example",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let warning = "WARNING: Profile-only login does not configure worker credentials. Use provider-credentials oauth PROVIDER or provider-credentials set PROVIDER for workers.";
    let warning_position = stderr.find(warning).expect("warning should be emitted");
    let error_position = stderr
        .find("Anvil returned 503")
        .expect("provider discovery error should be reported");
    assert!(warning_position < error_position);
    providers.assert_hits(1);
    login.assert_hits(0);
}

#[test]
fn provider_credentials_oauth_does_not_claim_authentication_while_pending() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET)
            .path("/v1/provider-credentials/example/methods");
        then.status(200).json_body(serde_json::json!({"methods":[{
            "id":"headless","label":"Headless"
        }]}));
    });
    server.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/v1/provider-credentials/example/oauth")
            .json_body(serde_json::json!({"method_id":"headless"}));
        then.status(200).json_body(serde_json::json!({
            "login_id":"login-2","mode":"auto","time":2
        }));
    });
    let pending = server.mock(|when, then| {
        when.method(GET)
            .path("/v1/provider-credentials/example/oauth/login-2");
        then.status(200)
            .json_body(serde_json::json!({"status":"pending"}));
    });
    let legacy_route = server.mock(|when, then| {
        when.method(httpmock::Method::POST)
            .path("/v1/providers/example/login");
        then.status(500);
    });

    let output = Command::new(env!("CARGO_BIN_EXE_anvilctl"))
        .args([
            "--server",
            &server.base_url(),
            "provider-credentials",
            "oauth",
            "example",
            "headless",
        ])
        .env("ANVIL_PROVIDER_OPERATOR_TOKEN", "operator-secret")
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Authenticated successfully."));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("Authenticated successfully."));
    pending.assert_hits(1);
    legacy_route.assert_hits(0);
}
