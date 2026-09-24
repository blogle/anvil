use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Default)]
struct AppState {
    completion: AtomicU64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port = std::env::var("ANVIL_TEST_MODEL_PORT")
        .unwrap_or_else(|_| "4098".into())
        .parse()?;
    let state = std::sync::Arc::new(AppState::default());
    let app = Router::new()
        .route("/healthz", get(|| async { StatusCode::OK }))
        .route("/v1/models", get(models))
        .route("/models", get(models))
        .route("/v1/chat/completions", post(completion))
        .with_state(state);
    axum::serve(
        tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?,
        app,
    )
    .await?;
    Ok(())
}

async fn models() -> Json<Value> {
    Json(
        json!({"object":"list","data":[{"id":"anvil-scripted","object":"model","created":0,"owned_by":"anvil-test"}]}),
    )
}

async fn completion(
    State(state): State<std::sync::Arc<AppState>>,
    Json(request): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let messages = request
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let prompt = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|message| message.get("content").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if !prompt.contains("ANVIL-E2E:edit-file") {
        return (
            StatusCode::OK,
            Json(finish(
                "TEST_FAILURE: include the explicit ANVIL-E2E:edit-file scenario marker",
                &request,
            )),
        );
    }
    let index = state.completion.fetch_add(1, Ordering::SeqCst);
    let tool_responses = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        .count();
    let (tool, args) = match tool_responses {
        0 => ("read", json!({"filePath":"target.txt"})),
        1 => (
            "edit",
            json!({"filePath":"target.txt","oldString":"before\n","newString":"after\n"}),
        ),
        _ => {
            return (
                StatusCode::OK,
                Json(finish("Deterministic fixture edit completed.", &request)),
            )
        }
    };
    let tool_call = json!({"id":format!("call_anvil_{index}"),"type":"function","function":{"name":tool,"arguments":args.to_string()}});
    (
        StatusCode::OK,
        Json(
            json!({"id":format!("chatcmpl-anvil-{index}"),"object":"chat.completion","created":0,"model":"anvil-scripted","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[tool_call]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}),
        ),
    )
}

fn finish(content: &str, request: &Value) -> Value {
    json!({"id":"chatcmpl-anvil-finished","object":"chat.completion","created":0,"model":request.get("model").and_then(Value::as_str).unwrap_or("anvil-scripted"),"choices":[{"index":0,"message":{"role":"assistant","content":content},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn model_listing_is_openai_compatible_and_stable() {
        let response = models().await;
        assert_eq!(response.0["data"][0]["id"], "anvil-scripted");
        assert_eq!(response.0, models().await.0);
    }

    #[tokio::test]
    async fn unknown_scenario_is_a_clear_failure_response() {
        let (_, body) = completion(
            State(std::sync::Arc::new(AppState::default())),
            Json(json!({"messages":[{"role":"user","content":"do something"}]})),
        )
        .await;
        assert!(body.0["choices"][0]["message"]["content"]
            .as_str()
            .unwrap()
            .starts_with("TEST_FAILURE:"));
    }

    #[tokio::test]
    async fn edit_scenario_emits_read_then_edit_tool_calls() {
        let state = std::sync::Arc::new(AppState::default());
        let request = json!({"messages":[{"role":"user","content":"ANVIL-E2E:edit-file"}]});
        let (_, first) = completion(State(state.clone()), Json(request.clone())).await;
        assert_eq!(
            first.0["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "read"
        );
        let request = json!({"messages":[{"role":"user","content":"ANVIL-E2E:edit-file"},{"role":"tool","content":"before"}]});
        let (_, second) = completion(State(state), Json(request)).await;
        assert_eq!(
            second.0["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "edit"
        );
    }
}
