use std::collections::BTreeMap;

use anvild::harness::{
    materialize_provider_config, Harness, HarnessError, ScriptedHarness, SseParser, TurnReceipt,
};
use serde_json::json;

fn receipt(session: &str, tokens: i64) -> Result<TurnReceipt, HarnessError> {
    Ok(TurnReceipt {
        session: session.to_owned(),
        tokens: Some(tokens),
    })
}

#[test]
fn provider_config_writes_opencode_oauth_auth_json_when_named() {
    let strategy = json!({"model": "chatgpt/gpt-5", "opencode_auth": "chatgpt"});
    let mut credentials = BTreeMap::new();
    credentials.insert(
        "opencode-auth:chatgpt".to_owned(),
        "{\"chatgpt\":{\"type\":\"oauth\"}}".to_owned(),
    );

    let config = materialize_provider_config(&strategy, &credentials).unwrap();
    let auth_json = config.files.get(anvild::harness::AUTH_JSON_FILE).unwrap();
    assert!(auth_json.contains("oauth"));
    assert_eq!(config.env.len(), 0);
}

#[test]
fn provider_config_fails_when_named_oauth_auth_is_missing() {
    let strategy = json!({"opencode_auth": "chatgpt"});
    let error = materialize_provider_config(&strategy, &BTreeMap::new()).unwrap_err();
    assert!(matches!(
        error,
        HarnessError::CredentialMissing { name } if name == "opencode-auth:chatgpt"
    ));
}

#[test]
fn provider_config_writes_model_and_mcp_without_secrets() {
    let strategy = json!({
        "model": "glm-5.3",
        "mcp": {
            "github": { "type": "http", "url": "https://mcp.example", "headers": { "Authorization": "{env.GITHUB_TOKEN}" } }
        },
        "credentials": ["ANTHROPIC_API_KEY", "ANVIL_GITHUB_TOKEN"],
    });
    let mut credentials = BTreeMap::new();
    credentials.insert("ANTHROPIC_API_KEY".to_owned(), "sk-ant-secret".to_owned());
    credentials.insert("ANVIL_GITHUB_TOKEN".to_owned(), "ghp-token".to_owned());

    let config = materialize_provider_config(&strategy, &credentials).unwrap();
    let opencode = config.files.get("opencode.json").unwrap();
    assert!(!opencode.contains("sk-ant-secret"));
    assert!(!opencode.contains("ghp-token"));
    assert!(opencode.contains("\"default_agent\":\"anvil\""));
    assert!(opencode.contains("\"model\":\"glm-5.3\""));
    assert!(opencode.contains("{env.GITHUB_TOKEN}"));
    assert_eq!(config.env["ANTHROPIC_API_KEY"], "sk-ant-secret");
    assert_eq!(config.env["ANVIL_GITHUB_TOKEN"], "ghp-token");
    assert_eq!(config.env.len(), 2);
}

#[test]
fn provider_config_without_knobs_is_an_empty_file_and_env() {
    let config = materialize_provider_config(&json!({}), &BTreeMap::new()).unwrap();
    assert_eq!(config.files["opencode.json"], "{}");
    assert!(config.env.is_empty());
}

#[test]
fn provider_config_fails_on_a_missing_credential() {
    let strategy = json!({"credentials": ["OPENROUTER_API_KEY"]});
    let error = materialize_provider_config(&strategy, &BTreeMap::new()).unwrap_err();
    assert!(matches!(
        error,
        HarnessError::CredentialMissing { name } if name == "OPENROUTER_API_KEY"
    ));
}

#[tokio::test]
async fn scripted_harness_replays_the_script_and_records_prompts() {
    let harness = Harness::Scripted(ScriptedHarness::new(vec![
        receipt("s-1", 1_000),
        receipt("s-1", 2_000),
    ]));

    let first = harness
        .run_turn("http://memory", None, None, "solve the invoices")
        .await
        .unwrap();
    assert_eq!(first.session, "s-1");
    assert_eq!(first.tokens, Some(1_000));

    let second = harness
        .run_turn("http://memory", None, Some("s-1"), "fix the failing check")
        .await
        .unwrap();
    assert_eq!(second.session, "s-1");
    assert_eq!(second.tokens, Some(2_000));

    let scripted = match &harness {
        Harness::Scripted(inner) => inner,
        Harness::Opencode(_) => unreachable!(),
    };
    assert_eq!(
        scripted.received.lock().unwrap()[0],
        (None, "solve the invoices".to_owned())
    );
    assert_eq!(
        scripted.received.lock().unwrap()[1],
        (Some("s-1".to_owned()), "fix the failing check".to_owned())
    );

    let exhausted = harness
        .run_turn("http://memory", None, Some("s-1"), "one more")
        .await;
    assert!(matches!(exhausted, Err(HarnessError::ScriptExhausted)));
}

#[tokio::test]
async fn scripted_harness_can_fail_a_turn_on_cue() {
    let harness = ScriptedHarness::new(vec![Err(HarnessError::ScriptExhausted)]);
    assert!(harness
        .run_turn("http://memory", None, None, "any")
        .await
        .is_err());
}

#[test]
fn sse_parser_assembles_frames_across_chunk_boundaries() {
    let mut parser = SseParser::default();
    parser.feed(b"event: session.usage.updated\nda");
    assert_eq!(parser.next_frame(), None);
    parser.feed(b"ta: {\"type\":\"session.usage.updated\",\"properties\":{\"input\":100}}\n\n");
    let frame = parser.next_frame().unwrap();
    assert_eq!(frame.event.as_deref(), Some("session.usage.updated"));
    assert_eq!(
        frame.data,
        "{\"type\":\"session.usage.updated\",\"properties\":{\"input\":100}}"
    );
    assert_eq!(parser.next_frame(), None);

    parser.feed(b"event: session.tool.called\r\ndata: {\"a\":1}\r\n\r\n");
    let frame = parser.next_frame().unwrap();
    assert_eq!(frame.event.as_deref(), Some("session.tool.called"));
    assert_eq!(frame.data, "{\"a\":1}");
}

#[test]
fn sse_parser_ignores_comments_and_joins_data_lines() {
    let mut parser = SseParser::default();
    parser.feed(b": keep-alive\n\ndata: {\"a\":\ndata: 1}\n\n");
    let frame = parser.next_frame().unwrap();
    assert_eq!(frame.event, None);
    assert_eq!(frame.data, "{\"a\":\n1}");
}

#[tokio::test]
async fn opencode_contract_test() {
    let Ok(base) = std::env::var("ANVIL_TEST_OPENCODE_URL") else {
        eprintln!("skipping: ANVIL_TEST_OPENCODE_URL is not set");
        return;
    };
    let harness = anvild::harness::OpencodeHarness::new();

    let receipt = harness
        .run_turn(&base, None, None, "Reply with the single word: pong")
        .await
        .expect("live opencode turn");
    assert!(!receipt.session.is_empty());

    let events = harness
        .subscribe(&base, None, &["session.usage.updated"])
        .await
        .unwrap();
    let mut events = events;
    assert!(events.next_event().await.is_some());
}

#[test]
fn provider_config_keeps_model_variants_for_thinking_levels() {
    let strategy = json!({"model": "openai/gpt-6.1-luna#high"});
    let config = materialize_provider_config(&strategy, &BTreeMap::new()).unwrap();
    let opencode = config.files.get("opencode.json").unwrap();
    assert!(opencode.contains("\"default_agent\":\"anvil\""));
    assert!(opencode.contains(
        "\"agents\":{\"anvil\":{\"mode\":\"primary\",\"model\":\"openai/gpt-6.1-luna#high\"}}"
    ));
}
