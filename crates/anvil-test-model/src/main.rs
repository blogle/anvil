use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::sync::Notify;

#[derive(Default)]
struct AppState {
    completion: AtomicU64,
    released: std::sync::atomic::AtomicBool,
    release: Notify,
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
        .route("/chat/completions", post(completion))
        .route("/v1/responses", post(responses))
        .route("/__test/release", post(release_gate))
        .route("/__test/hold", post(hold_gate))
        .fallback(unknown_route)
        .with_state(state);
    axum::serve(
        tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?,
        app,
    )
    .await?;
    Ok(())
}

async fn unknown_route(request: axum::http::Request<axum::body::Body>) -> (StatusCode, String) {
    eprintln!(
        "unsupported model fixture request: {} {}",
        request.method(),
        request.uri()
    );
    (
        StatusCode::NOT_FOUND,
        "unsupported local test-model endpoint".into(),
    )
}

async fn models() -> Json<Value> {
    Json(
        json!({"object":"list","data":[{"id":"anvil-scripted","object":"model","created":0,"owned_by":"anvil-test"}]}),
    )
}

async fn release_gate(State(state): State<std::sync::Arc<AppState>>) -> StatusCode {
    state.released.store(true, Ordering::SeqCst);
    state.release.notify_waiters();
    StatusCode::NO_CONTENT
}

async fn hold_gate(State(state): State<std::sync::Arc<AppState>>) -> StatusCode {
    state.released.store(false, Ordering::SeqCst);
    StatusCode::NO_CONTENT
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
        if prompt.contains("ANVIL-E2E:followup") {
            return (
                StatusCode::OK,
                Json(finish(
                    "Confirmed: this is the same OpenCode conversation.",
                    &request,
                )),
            );
        }
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

async fn responses(
    State(state): State<std::sync::Arc<AppState>>,
    Json(request): Json<Value>,
) -> axum::response::Response {
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let stream = request
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tool_count = request
        .get("tools")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let mut prompt = String::new();
    let mut tool_responses = 0usize;
    if let Some(items) = input.as_array() {
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("function_call_output") {
                tool_responses += 1;
            }
            if item.get("role").and_then(Value::as_str) == Some("user") {
                if let Some(text) = item.get("content").and_then(Value::as_str) {
                    prompt.push_str(text);
                }
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            prompt.push_str(text);
                        }
                    }
                }
            }
        }
    } else if let Some(text) = input.as_str() {
        prompt.push_str(text);
    }
    let is_follow_up = prompt.contains("ANVIL-E2E:followup");
    if !is_follow_up && !prompt.contains("ANVIL-E2E:edit-file") {
        return Json(response_text(
            "TEST_FAILURE: explicit ANVIL-E2E:edit-file scenario marker is required",
            &request,
        ))
        .into_response();
    }
    if prompt.contains("ANVIL-E2E:wait-for-release")
        && std::env::var("ANVIL_TEST_MODEL_GATE").as_deref() == Ok("1")
        && !state.released.load(Ordering::SeqCst)
    {
        loop {
            let notified = state.release.notified();
            if state.released.load(Ordering::SeqCst) {
                break;
            }
            notified.await;
        }
    }
    if is_follow_up {
        let value = response_text(
            "Confirmed: this is the same OpenCode conversation.",
            &request,
        );
        return if stream {
            response_sse(&value)
        } else {
            Json(value).into_response()
        };
    }
    if tool_count == 0 {
        let value = response_text("I will inspect and update the fixture file.", &request);
        return if stream {
            response_sse(&value)
        } else {
            Json(value).into_response()
        };
    }
    let scripted = match tool_responses {
        0 => Some(("read", json!({"filePath":"target.txt"}))),
        1 => Some((
            "edit",
            json!({"filePath":"target.txt","oldString":"before\n","newString":"after\n"}),
        )),
        _ => None,
    };
    if let Some((name, arguments)) = scripted {
        let call_id = format!(
            "call_anvil_{}",
            state.completion.fetch_add(1, Ordering::SeqCst)
        );
        let output = json!({"id":format!("fc_{call_id}"),"type":"function_call","call_id":call_id,"name":name,"arguments":arguments.to_string(),"status":"completed"});
        let value = json!({"id":format!("resp_{call_id}"),"object":"response","created_at":0,"status":"completed","model":"anvil-scripted","output":[output],"output_text":"","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}});
        if stream {
            response_sse(&value)
        } else {
            Json(value).into_response()
        }
    } else {
        let value = response_text("Deterministic fixture edit completed.", &request);
        if stream {
            response_sse(&value)
        } else {
            Json(value).into_response()
        }
    }
}

fn response_sse(value: &Value) -> axum::response::Response {
    let mut body = String::new();
    let output = value
        .get("output")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or(Value::Null);
    let response_id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("resp_anvil");
    let mut emit = |event: &str, data: Value| {
        body.push_str(&format!("event: {event}\ndata: {}\n\n", data));
    };
    emit(
        "response.created",
        json!({"type":"response.created","response":{"id":response_id,"object":"response","created_at":0,"status":"in_progress","output":[]}}),
    );
    if output.get("type").and_then(Value::as_str) == Some("function_call") {
        let mut pending = output.clone();
        pending["status"] = json!("in_progress");
        pending["arguments"] = json!("");
        emit(
            "response.output_item.added",
            json!({"type":"response.output_item.added","output_index":0,"item":pending}),
        );
        let args = output
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default();
        emit(
            "response.function_call_arguments.delta",
            json!({"type":"response.function_call_arguments.delta","item_id":output.get("id"),"output_index":0,"delta":args}),
        );
        emit(
            "response.function_call_arguments.done",
            json!({"type":"response.function_call_arguments.done","item_id":output.get("id"),"output_index":0,"arguments":args}),
        );
        emit(
            "response.output_item.done",
            json!({"type":"response.output_item.done","output_index":0,"item":output}),
        );
    } else if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        let message = json!({"id":"msg_anvil_text","type":"message","role":"assistant","status":"in_progress","content":[]});
        emit(
            "response.output_item.added",
            json!({"type":"response.output_item.added","output_index":0,"item":message}),
        );
        emit(
            "response.content_part.added",
            json!({"type":"response.content_part.added","item_id":"msg_anvil_text","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
        );
        emit(
            "response.output_text.delta",
            json!({"type":"response.output_text.delta","item_id":"msg_anvil_text","output_index":0,"content_index":0,"delta":text}),
        );
        emit(
            "response.output_text.done",
            json!({"type":"response.output_text.done","item_id":"msg_anvil_text","output_index":0,"content_index":0,"text":text}),
        );
        emit(
            "response.content_part.done",
            json!({"type":"response.content_part.done","item_id":"msg_anvil_text","output_index":0,"content_index":0,"part":{"type":"output_text","text":text,"annotations":[]}}),
        );
        emit(
            "response.output_item.done",
            json!({"type":"response.output_item.done","output_index":0,"item":output}),
        );
    }
    emit(
        "response.completed",
        json!({"type":"response.completed","response":value}),
    );
    body.push_str("data: [DONE]\n\n");
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/event-stream"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

fn response_text(text: &str, request: &Value) -> Value {
    json!({"id":"resp_anvil_text","object":"response","created_at":0,"status":"completed","incomplete_details":null,"model":request.get("model").and_then(Value::as_str).unwrap_or("anvil-scripted"),"output":[{"id":"msg_anvil_text","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}],"output_text":text,"usage":{"input_tokens":0,"input_tokens_details":null,"output_tokens":0,"output_tokens_details":null,"total_tokens":0}})
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

    #[tokio::test]
    async fn responses_turn_finishes_after_the_file_edit_without_anvil_tools() {
        let state = std::sync::Arc::new(AppState::default());
        let request = json!({
            "stream":false,
            "model":"anvil-scripted",
            "input":[{"role":"user","content":"ANVIL-E2E:edit-file"}],
            "tools":[{"type":"function","name":"read"},{"type":"function","name":"edit"}]
        });
        let first = responses(State(state.clone()), Json(request.clone())).await;
        let body = axum::body::to_bytes(first.into_body(), usize::MAX)
            .await
            .unwrap();
        let first: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(first["output"][0]["name"], "read");

        let request = json!({
            "stream":false,
            "model":"anvil-scripted",
            "input":[
                {"role":"user","content":"ANVIL-E2E:edit-file"},
                {"type":"function_call_output","output":"before"}
            ],
            "tools":[{"type":"function","name":"read"},{"type":"function","name":"edit"}]
        });
        let second = responses(State(state.clone()), Json(request.clone())).await;
        let body = axum::body::to_bytes(second.into_body(), usize::MAX)
            .await
            .unwrap();
        let second: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(second["output"][0]["name"], "edit");

        let request = json!({
            "stream":false,
            "model":"anvil-scripted",
            "input":[
                {"role":"user","content":"ANVIL-E2E:edit-file"},
                {"type":"function_call_output","output":"before"},
                {"type":"function_call_output","output":"edited"}
            ],
            "tools":[{"type":"function","name":"read"},{"type":"function","name":"edit"}]
        });
        let final_response = responses(State(state), Json(request)).await;
        let body = axum::body::to_bytes(final_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let final_response: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(final_response["status"], "completed");
        assert_eq!(final_response["output"][0]["type"], "message");
        assert!(!final_response.to_string().contains("anvil_report"));
    }
}
