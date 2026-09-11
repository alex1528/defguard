# 配置外部 OIDC Provider（供 DefGuard-client 自动串联登录）

> 适用：defguard 服务端（企业版）＋ DefGuard-client v2.1.2+ 目标：让外部 OIDC provider（如 Authentik / Keycloak）托管的用户，在客户端 登录后**自动完成 enrollment 与配置拉取**，无需手动向导操作。 架构：**路径 A** — 客户端只与 defguard 通信，由 defguard 代理外部 IdP。 相关实现说明见 `DefGuard-client/docs/oidc-auto-enrollment.md`。

---

## 0. 前提

- ⚠️ **企业版许可证**：外部 OIDC provider 是 defguard 企业版功能 （handler `add_openid_provider` 带 `LicenseInfo` 守卫），需有效 enterprise license。
- 已部署 defguard 服务端，管理员账号可登录 Web UI。
- 已在 Settings 中正确设置 **defguard URL**（`defguard_url`）——回调地址由它派生。

## 1. 关键地址（已核实自源码，切勿混淆）

| 用途 | 地址 | 源码依据 |
| --- | --- | --- |
| **外部 IdP 侧填写的 Redirect URI** | `<defguard_url>/auth/callback` | `Settings::callback_url()`（`settings/mod.rs`）— 在 `defguard_url` 后追加 `auth/callback` |
| defguard 生成授权跳转 URL 的端点 | `GET /api/v1/openid/auth_info` | `openid_login.rs::get_auth_info` |
| defguard 内部接收 IdP 回调的 API | `/api/v1/openid/callback` | `openid_login.rs::auth_callback` |

> ⚠️ **注意**：在**外部 IdP**（Authentik/Keycloak）中登记的 Redirect URI 必须是 `<defguard_url>/auth/callback`（前端页面路由），**不是** `/api/v1/openid/callback` （那是 defguard 内部 API，由前端页面转发调用）。填错会导致回调 4xx。

## 2. 步骤一：在外部 IdP 创建 OAuth2/OIDC 应用（以 Authentik 为例）

1. Authentik → Applications → Providers → 新建 **OAuth2/OpenID Provider**
2. **Redirect URI** 填：`https://<defguard域名>/auth/callback`
3. Scopes：`openid`、`profile`、`email`
4. 记录 `Client ID`、`Client Secret`
5. 记录 Issuer / base URL（如 `https://auth.example.com/application/o/<slug>/`）—— defguard 会据此自动发现 `.well-known/openid-configuration`

## 3. 步骤二：在 defguard 添加 provider

Web UI：**Settings → OpenID Provider**，或调 `POST /api/v1/openid/provider`。 请求体结构见 `openid_providers.rs::AddProviderData`，核心字段：

| 字段 | 填写 | 说明 |
| --- | --- | --- |
| `name` | 自定义（如 `authentik`） | provider 标识 |
| `kind` | `Custom` | 通用 OIDC 选 Custom；其余枚举：`Google`/`Microsoft`/`Okta`/`JumpCloud` |
| `base_url` | IdP issuer URL | 用于自动发现 metadata |
| `client_id` / `client_secret` | 步骤一的值 |  |
| `disable_password_management` | `true` ⭐ | **关键**：置 true → 客户端侧 `user.password_management_disabled=true`，触发自动串联 |
| `create_account` | 按需 `true` | 首次 OIDC 登录自动建号（写入全局 `openid_create_account` 设置） |
| `username_handling` | 按策略选 | OIDC 用户名映射方式（`OpenIdUsernameHandling`） |
| `directory_sync_enabled` | 按需 `false`/`true` | 仅在需要目录同步时开启，附带 `directory_sync_*` 一组字段 |

> 当前 defguard **同一时刻只支持一个 OIDC provider**（源码注释： “Currently, we only support one OpenID provider at a time”）。

## 4. 步骤三：满足客户端「全自动」的两个开关

要让 DefGuard-client 免向导直达 overview，服务端须同时满足：

1. `disable_password_management = true`（provider 级，见步骤二） → 客户端 `user.password_management_disabled = true`
2. **实例不强制 MFA**（enrollment settings `mfa_required = false`）

二者同时满足，客户端才走 `enrollmentAutoActivateAndFinish` 自动完成； 否则回退交互式向导（设计上的安全兜底）。

## 5. 步骤四：验证

1. defguard Web 登录页出现「Sign in with 」按钮
2. 客户端经 deep-link `defguard://addinstance?token=<T>&url=<U>` 触发 enrollment
3. OIDC 登录成功 → 客户端**自动**拉取配置并进入 overview，无需手动点击
4. overview 中可对该实例的 location 执行启动 / 停用 VPN

## 5.1 前端登录按钮触发链路（源码核实）

「Sign in with 」按钮**无需前端改代码**——只要管理员配好 provider， defguard Web 登录页即自动渲染该按钮。完整链路如下：

```
① 登录页 LoginMainPage.tsx 加载
   └─ useQuery → api.openid.authInfo()
        └─ GET /api/v1/openid/auth_info
        └─ 后端 get_auth_info 生成授权跳转 URL(含 state / nonce)

② openIdAuthInfo 非空 → 渲染 <LoginWithExternalProvider>
        └─ 文案：button_display_name 存在 → "Sign in with {provider}"
                 否则 → "Sign in with external provider"

③ <OIDCButton url={data.url} text={text} />
        └─ 点击 → 浏览器跳转 data.url(外部 IdP 授权端点)

④ 用户在外部 IdP(Authentik/Keycloak)认证
        └─ IdP 回调 → <defguard_url>/auth/callback (前端页面路由)
        └─ 前端 POST /api/v1/openid/callback
             → 后端 auth_callback 校验 nonce/state + user_from_claims → 建立会话

```

| 项 | 值 | 源码 |
| --- | --- | --- |
| 按钮是否显示 | 取决于 `/openid/auth_info` 是否返回 provider | `LoginMainPage.tsx` |
| 按钮文案来源 | provider 的 `display_name`(→ `button_display_name`) | `LoginMainPage.tsx` |
| 点击跳转目标 | `data.url`(后端生成的 IdP 授权 URL) | `OIDCButton url={data.url}` |
| API 封装 | `api.openid.authInfo` / `api.openid.callback` | `web/src/shared/api/api.ts` |

> ⚠️ `OIDCButton` 组件本体位于 submodule `web/src/shared/defguard-ui/`(url `../ui.git`)。 若该目录为空，需先执行 `git submodule update --init --recursive` 拉取， 否则本地无法查看/构建该组件。

## 6. 参考源码

- `crates/defguard_core/src/enterprise/handlers/openid_providers.rs` — provider 增删改查（`AddProviderData`）
- `crates/defguard_core/src/enterprise/handlers/openid_login.rs` — `get_auth_info` / `auth_callback` / `user_from_claims`
- `crates/defguard_core/src/enterprise/db/models/openid_provider.rs` — `OpenIdProvider` / `OpenIdProviderKind`
- `crates/defguard_common/src/db/models/settings/mod.rs` — `callback_url()`
- `web/src/pages/auth/LoginMain/LoginMainPage.tsx` — 登录页 SSO 按钮渲染与跳转
- `web/src/shared/api/api.ts` — `openid.authInfo` / `openid.callback` API 封装

