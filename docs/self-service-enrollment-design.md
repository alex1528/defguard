# Self-Service Enrollment via OIDC — Design Document

> For desktop client auto-provisioning after OIDC authentication

## 1. Overview

Enable users to enroll the desktop client by signing in through the
organisation's OIDC identity provider, without requiring an administrator to
manually generate and distribute an enrollment token.

### Current flow (admin-initiated)
```
Admin generates token → gives to user (email/link)
→ user opens deep-link: defguard://addinstance?token&url
→ client enrollment (automatic)
```

### Target flow (self-service)
```
User opens client → "Sign in with SSO" → enters instance URL
→ browser opens server self-service page
→ OIDC login
→ server auto-generates enrollment token
→ redirects to defguard://addinstance?token&url deep-link
→ client catches deep-link → auto-enrollment
```

---

## 2. Architecture

### 2.1 Client-side (already implemented)

| File | Purpose |
|------|---------|
| `new-ui/src/pages/full/OidcLoginPage/OidcLoginPage.tsx` | New "Sign in with SSO" page |
| `new-ui/src/routes/full/_default/add/oidc-login.tsx` | Route `/full/add/oidc-login` |
| `new-ui/src/pages/full/AddPage/AddPage.tsx` | Added SSO card to "Add" menu |

Flow:
1. User enters instance URL
2. Client opens system browser to `<url>/#/enrollment/self-service`
3. Shows "Waiting for authentication…" screen
4. Deep-link callback handled by existing `TauriEventProvider` → `AddInstancePage` → auto-enrollment

### 2.2 Server-side (new endpoint needed)

Two approaches, in order of complexity:

#### Approach A: New REST endpoint + frontend page (recommended)

**New API endpoint**: `POST /api/v1/enrollment/self-service`

- **Authentication**: Requires valid session cookie (user must be logged in)
- **Authorization**: Any authenticated user (not admin-only)
- **Logic**:
  1. Get current user from session
  2. Check if user already has devices → if yes, return existing enrollment or skip
  3. Generate enrollment token via `start_user_enrollment()`:
     - `admin` = the user themselves (self-service)
     - `email` = None (no email notification)
     - `token_timeout_seconds` = from settings (`enrollment_token_timeout()`)
     - `enrollment_service_url` = from settings (`proxy_public_url()`)
     - `send_user_notification` = false
  4. Return `{ token, enrollment_url, deep_link }` where
     `deep_link = defguard://addinstance?token={token}&url={enrollment_url}`

**New frontend page**: `/#/enrollment/self-service`

The defguard web UI page flow:
1. Check if user is logged in → if not, redirect to login (OIDC)
2. After login, call `POST /api/v1/enrollment/self-service`
3. Display: "Your desktop client is being configured…" + deep-link button
4. Auto-redirect to `defguard://addinstance?token={token}&url={url}`

#### Approach B: OIDC callback auto-redirect (advanced)

Modify `auth_callback` in `openid_login.rs`:
- After successful OIDC login, check if user has any enrolled devices
- If no devices → auto-generate enrollment token → HTTP 302 redirect to deep-link
- If has devices → normal login flow

This is more elegant but changes the core auth flow, which is riskier.

---

## 3. Server Implementation (Approach A)

### 3.1 New handler: `self_service_enrollment`

File: `crates/defguard_core/src/handlers/enrollment_self_service.rs` (new)

```rust
use axum::{extract::State, http::StatusCode, Json};
use defguard_common::db::models::{settings::Settings, user::User};
use serde::Serialize;
use serde_json::json;

use crate::{
    appstate::AppState,
    enrollment_management::start_user_enrollment,
    error::WebError,
    handlers::{ApiResponse, ApiResult, SessionInfo},
};

#[derive(Serialize)]
struct SelfServiceEnrollmentResponse {
    token: String,
    enrollment_url: String,
    deep_link: String,
}

/// Self-service enrollment — any authenticated user can generate their own
/// enrollment token for the desktop client.
pub async fn self_service_enrollment(
    session: SessionInfo,
    State(appstate): State<AppState>,
) -> ApiResult {
    let mut user = session.user.clone();

    let settings = Settings::get_current_settings();
    let token_timeout_seconds = settings.enrollment_token_timeout().as_secs();
    let public_proxy_url = settings.proxy_public_url()?;

    let mut transaction = appstate.pool.begin().await?;

    let enrollment_token = start_user_enrollment(
        &mut user,
        &mut transaction,
        &session.user,       // admin = self
        None,                // no email notification
        token_timeout_seconds,
        public_proxy_url.clone(),
        false,               // don't send notification
    )
    .map_err(|e| {
        WebError::Http(StatusCode::INTERNAL_SERVER_ERROR)
    })?;

    transaction.commit().await?;

    let deep_link = format!(
        "defguard://addinstance?token={}&url={}",
        enrollment_token,
        urlencoding::encode(public_proxy_url.as_str()),
    );

    Ok(ApiResponse::new(
        json!(SelfServiceEnrollmentResponse {
            token: enrollment_token,
            enrollment_url: public_proxy_url.to_string(),
            deep_link,
        }),
        StatusCode::CREATED,
    ))
}
```

### 3.2 Route registration

File: `crates/defguard_core/src/lib.rs`

Add after the existing enrollment routes:

```rust
// Self-service enrollment (authenticated users, no admin required)
let api_router = api_router.nest(
    "/api/v1/enrollment",
    Router::new()
        .route("/self-service", post(self_service_enrollment)),
);
```

### 3.3 Frontend page

File: `web/src/pages/enrollment/SelfServiceEnrollmentPage.tsx` (new)

The web UI page at `/#/enrollment/self-service`:
1. Checks authentication → redirects to OIDC login if not authenticated
2. Calls `POST /api/v1/enrollment/self-service`
3. Receives `{ deep_link }` → `window.location.href = deep_link`
4. Fallback: shows "Open in Defguard Client" button with the deep-link

---

## 4. Security Considerations

1. **Rate limiting**: Self-service endpoint should be rate-limited per user to
   prevent token flooding. Recommend: 5 tokens per hour per user.

2. **Token reuse**: `start_user_enrollment` calls `clear_unused_enrollment_tokens`
   first, so at most one active token per user at any time.

3. **No admin bypass**: The endpoint reuses the existing enrollment token
   machinery. Tokens have the same timeout and validation rules as admin-generated ones.

4. **Enterprise license**: Consider gating behind `LicenseInfo` like other
   enterprise features (OIDC itself already requires enterprise license).

---

## 5. Testing

1. **Happy path**: OIDC login → self-service endpoint → deep-link → client enrollment
2. **Already enrolled**: User with existing device → re-enrollment with updated config
3. **Token expiration**: Token timeout respected
4. **No OIDC**: Instance without OIDC → self-service page shows "OIDC not configured"
5. **Disabled user**: Disabled user → `start_user_enrollment` returns `UserDisabled` error

---

## 6. Files Changed Summary

### Client (`DefGuard-client`)
| File | Status | Change |
|------|--------|--------|
| `new-ui/src/pages/full/OidcLoginPage/OidcLoginPage.tsx` | **New** | SSO login page |
| `new-ui/src/pages/full/OidcLoginPage/style.scss` | **New** | Page styles |
| `new-ui/src/routes/full/_default/add/oidc-login.tsx` | **New** | Route definition |
| `new-ui/src/pages/full/AddPage/AddPage.tsx` | Modified | Added SSO card |
| `new-ui/src/shared/layouts/.../FullViewNavigation.tsx` | Modified | Removed Support/Update nav |
| `new-ui/src/shared/hooks/useUpdateAvailable.ts` | Modified | Disabled update check |

### Server (`defguard`)
| File | Status | Change |
|------|--------|--------|
| `crates/defguard_core/src/handlers/enrollment_self_service.rs` | **New** | Self-service endpoint |
| `crates/defguard_core/src/lib.rs` | Modified | Route registration |
| `web/src/pages/enrollment/SelfServiceEnrollmentPage.tsx` | **New** | Web UI page |
| `docs/self-service-enrollment-design.md` | **New** | This document |
