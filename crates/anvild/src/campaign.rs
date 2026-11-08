//! Application operations for Campaign submission and aggregate reads.

use anvil_core::{validate_campaign_submission, CampaignSubmissionRequest};
use serde_json::Value;

use crate::{store, ServiceError};

const API_SCOPE: &str = "api";
pub const MAX_PAGE_SIZE: usize = 256;

pub fn submit(
    store: &store::ControllerStore,
    key: &str,
    request: &Value,
) -> Result<store::TaskAcceptance, ServiceError> {
    let parsed: CampaignSubmissionRequest = serde_json::from_value(request.clone())
        .map_err(|error| ServiceError::Invalid(format!("invalid campaign submission: {error}")))?;
    let validated = validate_campaign_submission(parsed)
        .map_err(|error| ServiceError::Invalid(error.to_string()))?;
    store
        .accept_campaign(key, API_SCOPE, request, &validated)
        .map_err(|error| match error {
            store::StoreError::Conflict => ServiceError::Conflict(
                "Idempotency-Key was already used for a different request".into(),
            ),
            other => ServiceError::Store(other.to_string()),
        })
}

pub fn aggregate(
    store: &store::ControllerStore,
    id: &str,
    after: Option<&str>,
    limit: usize,
) -> Result<Value, ServiceError> {
    store
        .get_campaign(id, after, limit)
        .map_err(|error| ServiceError::Store(error.to_string()))?
        .ok_or(ServiceError::NotFound)
}

pub fn commission(store: &store::ControllerStore, id: &str) -> Result<Value, ServiceError> {
    store
        .get_commission(id)
        .map_err(|error| ServiceError::Store(error.to_string()))?
        .ok_or(ServiceError::NotFound)
}
