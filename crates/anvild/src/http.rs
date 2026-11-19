use std::convert::Infallible;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use time::OffsetDateTime;
use tokio_stream::wrappers::ReceiverStream;

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
        .route("/v1/campaigns", post(create_campaign).get(list_campaigns))
        .route("/v1/campaigns/{id}/commissions", post(create_commission))
        .route("/v1/commissions", get(list_commissions))
        .route(
            "/v1/commissions/{id}",
            get(commission_detail)
                .post(commission_action)
                .delete(cancel_commission),
        )
        .route("/v1/commissions/{id}/obligations", post(add_obligation))
        .route("/v1/obligations/{id}", delete(drop_obligation))
        .route("/v1/attempts", get(list_attempts))
        .route("/v1/inbox", get(list_inbox))
        .route("/v1/inbox/{id}/dismiss", post(dismiss_attention))
        .route(
            "/v1/credentials",
            post(add_credential).get(list_credentials),
        )
        .route("/v1/events", get(events))
        .with_state(store)
}

#[derive(Deserialize)]
struct CreateCampaignRequest {
    name: String,
    slug: String,
    #[serde(default)]
    context: String,
    #[serde(default = "empty_object")]
    strategy: Value,
    #[serde(default)]
    commissions: Vec<CreateCommissionRequest>,
}

fn empty_object() -> Value {
    json!({})
}

#[derive(Deserialize)]
struct CreateCommissionRequest {
    title: String,
    slug: String,
    #[serde(default)]
    spec: String,
    repo: String,
    target_ref: String,
    #[serde(default)]
    target_sha: String,
    #[serde(default = "one")]
    wave: i64,
    #[serde(default = "empty_object")]
    budget: Value,
    #[serde(default = "empty_object")]
    strategy: Value,
    #[serde(default)]
    obligations: Vec<String>,
}

fn one() -> i64 {
    1
}

#[derive(Deserialize)]
struct AddObligationRequest {
    text: String,
}

#[derive(Deserialize)]
struct CommissionActionRequest {
    action: String,
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    since: Option<i64>,
    #[serde(default)]
    commission: Option<String>,
}

enum ApiError {
    NotFound { what: &'static str },
    Conflict { message: String },
    BadAction { message: String },
    Internal(StoreError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound { what } => {
                (StatusCode::NOT_FOUND, format!("no {what} with that id\n")).into_response()
            }
            Self::Conflict { message } => {
                (StatusCode::CONFLICT, format!("{message}\n")).into_response()
            }
            Self::BadAction { message } => {
                (StatusCode::BAD_REQUEST, format!("{message}\n")).into_response()
            }
            Self::Internal(error) => {
                (StatusCode::INTERNAL_SERVER_ERROR, format!("{error}\n")).into_response()
            }
        }
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Missing { what, .. } => Self::NotFound { what },
            other => Self::Internal(other),
        }
    }
}

fn millis(at: OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

fn campaign_view(campaign: &anvil_api::Campaign) -> Value {
    json!({
        "id": campaign.id.to_string(),
        "name": campaign.name,
        "slug": campaign.slug,
        "context": campaign.context,
        "strategy": campaign.strategy,
        "created_at": millis(campaign.created_at),
    })
}

fn commission_view(commission: &anvil_api::Commission) -> Value {
    let state = match &commission.state {
        anvil_api::CommissionState::Escalated { reason } => json!({
            "kind": commission.state.kind(), "reason": reason,
        }),
        anvil_api::CommissionState::Failed { cause } => json!({
            "kind": commission.state.kind(), "cause": cause,
        }),
        other => json!({"kind": other.kind()}),
    };
    json!({
        "id": commission.id.to_string(),
        "campaign_id": commission.campaign_id.to_string(),
        "title": commission.title,
        "slug": commission.slug,
        "spec": commission.spec,
        "repo": commission.repo,
        "target_ref": commission.target_ref,
        "target_sha": commission.target_sha,
        "wave": commission.wave,
        "state": state,
        "budget": commission.budget,
        "strategy": commission.strategy,
        "branch": commission.branch,
        "pr_number": commission.pr_number,
        "created_at": millis(commission.created_at),
        "updated_at": millis(commission.updated_at),
    })
}

fn attempt_view(attempt: &anvil_api::Attempt) -> Value {
    json!({
        "id": attempt.id.to_string(),
        "commission_id": attempt.commission_id.to_string(),
        "n": attempt.n,
        "strategy": attempt.strategy,
        "started_at": millis(attempt.started_at),
        "ended_at": attempt.ended_at.map(millis),
        "done_claimed_at": attempt.done_claimed_at.map(millis),
        "heartbeat_at": millis(attempt.heartbeat_at),
        "tokens": attempt.tokens,
        "outcome": attempt.outcome,
    })
}

fn attention_view(attention: &anvil_api::AttentionItem) -> Value {
    json!({
        "id": attention.id.to_string(),
        "commission_id": attention.commission_id.to_string(),
        "kind": attention.kind.as_str(),
        "payload": attention.payload,
        "state": attention.state.as_str(),
        "created_at": millis(attention.created_at),
    })
}

fn obligation_view(obligation: &anvil_api::Obligation) -> Value {
    json!({
        "id": obligation.id.to_string(),
        "commission_id": obligation.commission_id.to_string(),
        "position": obligation.position,
        "text": obligation.text,
        "created_at": millis(obligation.created_at),
    })
}

fn turn_view(turn: &anvil_api::Turn) -> Value {
    json!({
        "id": turn.id.to_string(),
        "attempt_id": turn.attempt_id.to_string(),
        "prompt_hash": turn.prompt_hash,
        "started_at": millis(turn.started_at),
        "ended_at": turn.ended_at.map(millis),
        "tokens": turn.tokens,
        "result": turn.result,
    })
}

fn parse_id<T: std::str::FromStr>(raw: &str, what: &'static str) -> Result<T, ApiError> {
    raw.parse::<T>().map_err(|_| ApiError::NotFound { what })
}

async fn replayed(store: &Store, headers: &HeaderMap) -> Option<(StatusCode, Json<Value>)> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())?;
    let response = store.idempotency_lookup(key).await.ok()??;
    let value: Value = serde_json::from_str(&response).ok()?;
    Some((StatusCode::OK, Json(value)))
}

fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

async fn remember(store: &Store, headers: &HeaderMap, value: &Value) {
    if let Some(key) = idempotency_key(headers) {
        let _ = store.idempotency_remember(&key, &value.to_string()).await;
    }
}

async fn create_campaign(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(request): Json<CreateCampaignRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if let Some((status, replayed)) = replayed(&store, &headers).await {
        return Ok((status, replayed));
    }
    let campaign_id = store
        .insert_campaign(anvil_api::NewCampaign {
            name: request.name,
            slug: request.slug,
            context: request.context,
            strategy: request.strategy,
        })
        .await
        .map_err(ApiError::from)
        .map_err(duplicate_slug)?;
    let mut commission_ids = Vec::new();
    for new in request.commissions {
        let commission_id = insert_commission(&store, campaign_id, new).await?;
        commission_ids.push(commission_id.to_string());
    }
    store
        .append_events(&[anvil_api::NewEvent {
            kind: anvil_api::EventKind::CampaignCreated,
            campaign_id: Some(campaign_id),
            commission_id: None,
            payload: json!({"commissions": commission_ids}),
        }])
        .await?;
    let campaign = store
        .campaign(campaign_id)
        .await?
        .ok_or(ApiError::NotFound { what: "campaign" })?;
    let view = campaign_view(&campaign);
    remember(&store, &headers, &view).await;
    Ok((StatusCode::CREATED, Json(view)))
}

fn duplicate_slug(error: ApiError) -> ApiError {
    match error {
        ApiError::Internal(StoreError::Sqlx(error)) if is_duplicate(&error) => ApiError::Conflict {
            message: "a campaign with this slug already exists".to_owned(),
        },
        other => other,
    }
}

fn is_duplicate(error: &sqlx::Error) -> bool {
    let message = error.to_string();
    message.contains("UNIQUE constraint") && message.contains("slug")
}

async fn insert_commission(
    store: &Store,
    campaign_id: anvil_api::CampaignId,
    request: CreateCommissionRequest,
) -> Result<anvil_api::CommissionId, ApiError> {
    let obligations = request.obligations.clone();
    let commission_id = store
        .insert_commission(anvil_api::NewCommission {
            campaign_id,
            title: request.title,
            slug: request.slug,
            spec: request.spec,
            repo: request.repo,
            target_ref: request.target_ref,
            target_sha: request.target_sha,
            wave: request.wave,
            budget: request.budget,
            strategy: request.strategy,
        })
        .await
        .map_err(ApiError::from)
        .map_err(|error| match error {
            ApiError::Internal(StoreError::Sqlx(ref sqlx_error)) if is_duplicate(sqlx_error) => {
                ApiError::Conflict {
                    message: "a commission with this slug already exists".to_owned(),
                }
            }
            other => other,
        })?;
    for text in obligations {
        store.insert_obligation(commission_id, &text).await?;
    }
    Ok(commission_id)
}

async fn list_campaigns(State(store): State<Store>) -> Result<Json<Value>, ApiError> {
    let campaigns = store.campaigns().await?;
    Ok(Json(
        json!({"campaigns": campaigns.iter().map(campaign_view).collect::<Vec<_>>()}),
    ))
}

async fn create_commission(
    State(store): State<Store>,
    Path(campaign_raw): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CreateCommissionRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let campaign_id: anvil_api::CampaignId = parse_id(&campaign_raw, "campaign")?;
    if store.campaign(campaign_id).await?.is_none() {
        return Err(ApiError::NotFound { what: "campaign" });
    }
    if let Some((status, replayed)) = replayed(&store, &headers).await {
        return Ok((status, replayed));
    }
    let commission_id = insert_commission(&store, campaign_id, request).await?;
    let commission = store
        .commission(commission_id)
        .await?
        .ok_or(ApiError::NotFound { what: "commission" })?;
    let view = commission_view(&commission);
    remember(&store, &headers, &view).await;
    Ok((StatusCode::CREATED, Json(view)))
}

async fn list_commissions(
    State(store): State<Store>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let commissions = match query.since {
        Some(since) => store.commissions_updated_since(since).await?,
        None => store.commissions().await?,
    };
    Ok(Json(json!({
        "commissions": commissions.iter().map(commission_view).collect::<Vec<_>>()
    })))
}

async fn commission_detail(
    State(store): State<Store>,
    Path(commission_raw): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let commission_id: anvil_api::CommissionId = parse_id(&commission_raw, "commission")?;
    let Some(commission) = store.commission(commission_id).await? else {
        return Err(ApiError::NotFound { what: "commission" });
    };
    let obligations = store.obligations(commission_id).await?;
    let attempts = store.attempts(commission_id).await?;
    Ok(Json(json!({
        "commission": commission_view(&commission),
        "obligations": obligations.iter().map(obligation_view).collect::<Vec<_>>(),
        "attempts": attempts.iter().map(attempt_view).collect::<Vec<_>>(),
    })))
}

async fn add_obligation(
    State(store): State<Store>,
    Path(commission_raw): Path<String>,
    Json(request): Json<AddObligationRequest>,
) -> Result<StatusCode, ApiError> {
    let commission_id: anvil_api::CommissionId = parse_id(&commission_raw, "commission")?;
    if store.commission(commission_id).await?.is_none() {
        return Err(ApiError::NotFound { what: "commission" });
    }
    store
        .insert_obligation(commission_id, &request.text)
        .await?;
    store
        .append_events(&[anvil_api::NewEvent {
            kind: anvil_api::EventKind::ObligationMutated,
            campaign_id: None,
            commission_id: Some(commission_id),
            payload: json!({"added": request.text}),
        }])
        .await?;
    Ok(StatusCode::CREATED)
}

async fn drop_obligation(
    State(store): State<Store>,
    Path(obligation_raw): Path<String>,
) -> Result<StatusCode, ApiError> {
    let obligation_id: anvil_api::ObligationId = parse_id(&obligation_raw, "obligation")?;
    store.drop_obligation(obligation_id).await?;
    store
        .append_events(&[anvil_api::NewEvent {
            kind: anvil_api::EventKind::ObligationMutated,
            campaign_id: None,
            commission_id: None,
            payload: json!({"dropped": obligation_id.to_string()}),
        }])
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_attempts(
    State(store): State<Store>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let Some(commission_raw) = query.commission else {
        return Err(ApiError::BadAction {
            message: "attempts listing requires ?commission=".to_owned(),
        });
    };
    let commission_id: anvil_api::CommissionId = parse_id(&commission_raw, "commission")?;
    let attempts = store.attempts(commission_id).await?;
    let mut views = Vec::new();
    for attempt in &attempts {
        let turns = store.turns(attempt.id).await?;
        views.push(json!({
            "attempt": attempt_view(attempt),
            "turns": turns.iter().map(turn_view).collect::<Vec<_>>(),
        }));
    }
    Ok(Json(json!({"attempts": views})))
}

async fn list_inbox(State(store): State<Store>) -> Result<Json<Value>, ApiError> {
    let attention = store.open_attention().await?;
    Ok(Json(
        json!({"attention": attention.iter().map(attention_view).collect::<Vec<_>>()}),
    ))
}

async fn dismiss_attention(
    State(store): State<Store>,
    Path(attention_raw): Path<String>,
) -> Result<StatusCode, ApiError> {
    let attention_id: anvil_api::AttentionId = parse_id(&attention_raw, "attention item")?;
    store.dismiss_attention(attention_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn commission_action(
    State(store): State<Store>,
    Path(commission_raw): Path<String>,
    Json(request): Json<CommissionActionRequest>,
) -> Result<StatusCode, ApiError> {
    let commission_id: anvil_api::CommissionId = parse_id(&commission_raw, "commission")?;
    let Some(commission) = store.commission(commission_id).await? else {
        return Err(ApiError::NotFound { what: "commission" });
    };
    use crate::engine::Transition as T;
    let transition = match request.action.as_str() {
        "retry" => T::Retry,
        "resume" => T::Resume,
        "takeover" => T::Pause,
        "converge" => T::Converge,
        "merge" => T::Merge,
        "reopen" => T::Reopen,
        other => {
            return Err(ApiError::BadAction {
                message: format!("unknown action {other}"),
            })
        }
    };
    let to = crate::engine::apply(&commission.state, transition).map_err(|error| {
        ApiError::Conflict {
            message: error.to_string(),
        }
    })?;
    let event = anvil_api::NewEvent {
        kind: anvil_api::EventKind::StateChanged,
        campaign_id: Some(commission.campaign_id),
        commission_id: Some(commission.id),
        payload: json!({
            "from": commission.state.kind(),
            "to": to.kind(),
            "via": request.action,
        }),
    };
    store
        .transition_commission(commission_id, to, &[event], None)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cancel_commission(
    State(store): State<Store>,
    Path(commission_raw): Path<String>,
) -> Result<StatusCode, ApiError> {
    let commission_id: anvil_api::CommissionId = parse_id(&commission_raw, "commission")?;
    let Some(commission) = store.commission(commission_id).await? else {
        return Err(ApiError::NotFound { what: "commission" });
    };
    let to = crate::engine::apply(&commission.state, crate::engine::Transition::Cancel).map_err(
        |error| ApiError::Conflict {
            message: error.to_string(),
        },
    )?;
    let event = anvil_api::NewEvent {
        kind: anvil_api::EventKind::StateChanged,
        campaign_id: Some(commission.campaign_id),
        commission_id: Some(commission.id),
        payload: json!({"from": commission.state.kind(), "to": "cancelled", "via": "operator"}),
    };
    store
        .transition_commission(commission_id, to, &[event], None)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AddCredentialRequest {
    name: String,
    secret: String,
}

async fn add_credential(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(request): Json<AddCredentialRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if let Some(replayed) = replayed(&store, &headers).await {
        return Ok(replayed);
    }
    let name = request.name.clone();
    store.put_credential(&request.name, &request.secret).await?;
    let view = json!({"name": name});
    remember(&store, &headers, &view).await;
    Ok((StatusCode::CREATED, Json(view)))
}

async fn list_credentials(State(store): State<Store>) -> Result<Json<Value>, ApiError> {
    let names: Vec<Value> = store
        .credential_names()
        .await?
        .into_iter()
        .map(|(name, updated_at)| json!({"name": name, "updated_at": updated_at}))
        .collect();
    Ok(Json(json!({"credentials": names})))
}

async fn events(
    State(store): State<Store>,
    Query(query): Query<ListQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let cursor = query.since.unwrap_or(0);
    let wants_json = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("application/json"));
    if wants_json {
        let events = store.events_since(cursor, 500).await?;
        let views: Vec<Value> = events
            .iter()
            .map(|event| {
                json!({
                    "seq": event.seq,
                    "at": millis(event.at),
                    "kind": event.kind.as_str(),
                    "campaign_id": event.campaign_id.map(|id| id.to_string()),
                    "commission_id": event.commission_id.map(|id| id.to_string()),
                    "payload": event.payload,
                })
            })
            .collect();
        return Ok(Json(json!({
            "events": views,
            "cursor": events.last().map(|event| event.seq).unwrap_or(cursor),
        }))
        .into_response());
    }
    let (tx, rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(sse_pump(store, tx, cursor));
    Ok(Sse::new(ReceiverStream::new(rx)).into_response())
}

async fn sse_pump(
    store: Store,
    tx: tokio::sync::mpsc::Sender<Result<Event, Infallible>>,
    start: i64,
) {
    let mut cursor = start;
    loop {
        if let Ok(events) = store.events_since(cursor, 100).await {
            for event in events {
                cursor = event.seq;
                let frame = Event::default().event(event.kind.as_str()).data(
                    json!({
                        "seq": event.seq,
                        "at": millis(event.at),
                        "kind": event.kind.as_str(),
                        "campaign_id": event.campaign_id.map(|id| id.to_string()),
                        "commission_id": event.commission_id.map(|id| id.to_string()),
                        "payload": event.payload,
                    })
                    .to_string(),
                );
                if tx.send(Ok(frame)).await.is_err() {
                    return;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
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
