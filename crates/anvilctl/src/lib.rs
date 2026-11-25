use serde_json::json;

pub const DONE_PATH: &str = "/v1/signals/done";
pub const ATTENTION_PATH: &str = "/v1/signals/attention";

#[derive(Debug, thiserror::Error)]
pub enum SignalError {
    #[error("the daemon rejected this commission token")]
    Rejected,
    #[error("the daemon replied {status}: {body}")]
    Status { status: u16, body: String },
    #[error("could not reach the daemon: {0}")]
    Transport(#[from] reqwest::Error),
}

fn url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    format!("{base}{path}")
}

async fn send(
    base: &str,
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<(), SignalError> {
    let response = reqwest::Client::new()
        .post(url(base, path))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    match status.as_u16() {
        401 => Err(SignalError::Rejected),
        other => Err(SignalError::Status {
            status: other,
            body,
        }),
    }
}

pub async fn done(base: &str, token: &str, notes: Option<&str>) -> Result<(), SignalError> {
    let mut body = json!({});
    if let Some(notes) = notes {
        body["notes"] = json!(notes);
    }
    send(base, token, DONE_PATH, body).await
}

pub async fn attention(base: &str, token: &str, message: &str) -> Result<(), SignalError> {
    send(base, token, ATTENTION_PATH, json!({"message": message})).await
}

pub async fn report(
    base: &str,
    token: &str,
    id: &str,
    evidence: Option<&str>,
) -> Result<(), SignalError> {
    let body = match evidence {
        Some(text) => json!({"action": "complete", "evidence": text}),
        None => json!({"action": "clear"}),
    };
    send(base, token, &format!("/v1/signals/obligations/{id}"), body).await
}
