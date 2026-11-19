use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use crate::store::{Store, StoreError};

pub const DONE_PATH: &str = "/v1/signals/done";
pub const ATTENTION_PATH: &str = "/v1/signals/attention";

#[derive(Deserialize)]
pub struct DoneRequest {
    pub notes: Option<String>,
}

#[derive(Deserialize)]
pub struct AttentionRequest {
    pub message: String,
}

pub fn router(store: Store) -> Router {
    Router::new()
        .route(DONE_PATH, post(signal_done))
        .route(ATTENTION_PATH, post(signal_attention))
        .with_state(store)
}

enum SignalError {
    Unauthorized,
    NoRunningAttempt,
    Internal(StoreError),
}

impl IntoResponse for SignalError {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized => {
                (StatusCode::UNAUTHORIZED, "bad or missing token\n").into_response()
            }
            Self::NoRunningAttempt => (
                StatusCode::CONFLICT,
                "no running attempt to claim done on\n",
            )
                .into_response(),
            Self::Internal(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, format!("{error}\n")).into_response()
            }
        }
    }
}

async fn authorize(
    store: &Store,
    headers: &HeaderMap,
) -> Result<anvil_api::CommissionId, SignalError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(SignalError::Unauthorized)?;
    store
        .commission_by_token(token)
        .await
        .map_err(SignalError::Internal)?
        .ok_or(SignalError::Unauthorized)
}

async fn signal_done(
    State(store): State<Store>,
    headers: HeaderMap,
    request: Option<Json<DoneRequest>>,
) -> Result<StatusCode, SignalError> {
    let commission = authorize(&store, &headers).await?;
    let notes = request.and_then(|Json(DoneRequest { notes })| notes);
    store
        .claim_done(commission, notes.as_deref())
        .await
        .map_err(map_missing)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn signal_attention(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(AttentionRequest { message }): Json<AttentionRequest>,
) -> Result<StatusCode, SignalError> {
    let commission = authorize(&store, &headers).await?;
    store
        .agent_attention(commission, &message)
        .await
        .map_err(SignalError::Internal)?;
    Ok(StatusCode::NO_CONTENT)
}

fn map_missing(error: StoreError) -> SignalError {
    match error {
        StoreError::Missing { .. } => SignalError::NoRunningAttempt,
        other => SignalError::Internal(other),
    }
}
