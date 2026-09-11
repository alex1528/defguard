//! Self-service enrollment endpoint.
//!
//! Allows any authenticated user to generate their own enrollment token for
//! the desktop client. This removes the need for an administrator to manually
//! create and distribute tokens — users sign in via the Web UI (typically
//! through OIDC) and obtain a deep-link that the desktop client catches to
//! complete enrollment automatically.
//!
//! The endpoint reuses the existing [`start_user_enrollment`] machinery so all
//! existing token timeout, validation, and cleanup rules apply.

use axum::{extract::State, http::StatusCode};
use defguard_common::db::models::Settings;
use reqwest::Url;
use serde::Serialize;
use serde_json::json;

use crate::{
    appstate::AppState,
    auth::SessionInfo,
    enrollment_management::start_user_enrollment,
    error::WebError,
    handlers::{ApiResponse, ApiResult},
};

/// Response body for the self-service enrollment endpoint.
#[derive(Serialize)]
pub(crate) struct SelfServiceEnrollmentResponse {
    /// Opaque enrollment token (passed to the desktop client).
    pub token: String,
    /// Public proxy URL that the desktop client connects to.
    pub enrollment_url: String,
    /// Ready-to-use deep-link that the browser can redirect to.
    pub deep_link: String,
}

/// `POST /api/v1/enrollment/self-service`
///
/// Any authenticated user (not necessarily an admin) can call this to obtain
/// an enrollment token for the desktop client.
///
/// The returned `deep_link` can be opened directly in the browser to trigger
/// the desktop client's automatic enrollment flow.
pub(crate) async fn self_service_enrollment(
    session: SessionInfo,
    State(appstate): State<AppState>,
) -> ApiResult {
    debug!(
        "User {} requesting self-service enrollment token.",
        session.user.username
    );

    let settings = Settings::get_current_settings();
    let token_timeout_seconds = settings.enrollment_token_timeout().as_secs();
    let public_proxy_url = settings.proxy_public_url().map_err(|e| {
        error!("Failed to get proxy public URL: {e}");
        WebError::Http(StatusCode::INTERNAL_SERVER_ERROR)
    })?;

    let mut user = session.user.clone();
    let mut transaction = appstate.pool.begin().await?;

    let enrollment_token = start_user_enrollment(
        &mut user,
        &mut transaction,
        &session.user, // admin = self (self-service)
        None,          // no email notification
        token_timeout_seconds,
        public_proxy_url.clone(),
        false, // don't send notification email
    )
    .await?;

    transaction.commit().await?;

    let enrollment_url = public_proxy_url.to_string();

    // Build the deep-link URL with proper percent-encoding via the url crate.
    let mut deep_link_url =
        Url::parse("defguard://addinstance").expect("static scheme is valid");
    deep_link_url
        .query_pairs_mut()
        .append_pair("token", &enrollment_token)
        .append_pair("url", &enrollment_url);
    let deep_link = deep_link_url.to_string();

    info!(
        "Self-service enrollment token generated for user {}.",
        session.user.username
    );

    Ok(ApiResponse::new(
        json!(SelfServiceEnrollmentResponse {
            token: enrollment_token,
            enrollment_url,
            deep_link,
        }),
        StatusCode::CREATED,
    ))
}
