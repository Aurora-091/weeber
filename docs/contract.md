# CONTRACT.md — webbersh ⇄ Weeber Backend (Vocalist)
**Version 1.5 · 2026-07-12 · Copy this file into BOTH repos. Any change requires bumping the version and updating both copies.**

## Transport — this is now bidirectional

### Outbound: webbersh → Weeber (Shopify events)
- Base URL: `https://api.weeber.ai` by default, overridable via `WEEBER_API_URL` on webbersh (1.3) — set this if the domain isn't pointed at wherever the backend is actually deployed (e.g. Railway).
- All requests: `POST`, `Content-Type: application/json`
- **Auth: every request carries header `X-Weeber-Secret: ${WEEBER_INTERNAL_SECRET}`** (same value in both repos' env). Backend rejects missing/wrong secret with 401.
- Delivery: at-least-once (Shopify retries + webbersh retries). **Every endpoint must be idempotent.**
- webbersh always returns 200 to Shopify regardless of forward success (log failures; never trigger Shopify's retry storm for our internal errors) — except auth failures from `authenticate.webhook`, which Remix handles.

### Inbound: Weeber → webbersh (write-back after a call)
- Base URL: webbersh's own `application_url` (see `shopify.app.toml`).
- All requests: `POST`, `Content-Type: application/json`.
- **Auth: every request carries header `X-Weeber-Callback-Secret: ${WEEBER_CALLBACK_SECRET}`** — a *distinct* secret from the outbound one, so each direction can be rotated independently. webbersh rejects missing/wrong secret with 401.
- webbersh does **not** call Shopify with a token Weeber holds — it looks up its own stored offline session for the shop and performs the write itself. If no session is found (never installed / uninstalled), webbersh returns 404.
- Unlike the outbound direction, webbersh returns **honest status codes** here (Weeber is the caller and already retries on 5xx per its own logic, mirroring `postToWeeber`): `400` malformed body, `401` bad secret, `404` shop not connected, `422` non-retryable Shopify business-rule error, `200`/`202` success, `5xx` retryable failure.
- Endpoints are idempotent: retried requests with the same identifying fields (`order_id`, or a stable `code` for discounts) must not double-apply.

## Endpoints (outbound, all under `/api/integrations/shopify`)

### 1. `POST /connected` — merchant clicks "Connect to Weeber" ⚠️ changed in 1.2, timing changed in 1.4
```json
{ "shop": "x.myshopify.com", "scopes": "read_orders,...",
  "org_id": "uuid|null", "plan_name": "...", "currency": "INR",
  "country_code": "IN", "timezone": "Asia/Kolkata", "contact_email": "...",
  "shop_name": "...", "shop_domain": "...", "product_count": null,
  "order_count_30d": 0, "checkout_count": 0, "customer_count": 0 }
```
**Breaking change in 1.2:** `access_token` is no longer sent. webbersh is the sole holder/refresher of Shopify offline tokens (it now has `expiring_offline_access_tokens` on, so any token captured here would go stale with no refresh path on Weeber's side); use the new inbound write-back endpoints below instead of calling Shopify directly. `product_count` is now always `null` — webbersh never had the `read_products` scope, so this call always failed silently; dropped the dead call rather than add a scope nothing else needed.

**Timing changed in 1.4:** this no longer fires automatically from the OAuth `afterAuth` hook. `afterAuth` only registers webhooks now, so install completes independent of Weeber's availability. The merchant instead lands on a "Connect to Weeber" button (`app._index.jsx`) and this fires when they click it — retryable from the UI if it fails. Install is assumed to always be initiated from inside Weeber's dashboard, so `org_id` still arrives on the Shopify OAuth install URL; webbersh persists it at `afterAuth` time (keyed by shop, in a new `ShopOrgLink` table — one org can own multiple shops) and reads it back here, since the button click itself has no `org_id` on its URL.

### 2. `POST /webhooks/checkouts` — checkout created/updated 🆕 backend
```json
{ "shop": "x.myshopify.com", "topic": "checkouts/create" | "checkouts/update",
  "body": { /* full Shopify checkout payload, incl. token, phone, line_items,
               total_price, abandoned_checkout_url, billing_address */ } }
```
Backend behavior: create/update the scheduled recovery call. Idempotency key: `body.token`.

### 3. `POST /orders/create` — order placed 🆕 backend
```json
{ "shop": "x.myshopify.com", "order_id": 123, "order_number": 1001,
  "checkout_token": "abc|null", "email": "...|null", "phone": "...|null",
  "total_price": "1499.00", "currency": "INR", "financial_status": "pending",
  "payment_gateway_names": ["cash_on_delivery"],
  "customer_name": "First Last|null",
  "shipping_address": { "city": "...", "province": "...", "country": "...", "phone": "...|null" },
  "line_items": [{ "title": "...", "quantity": 1, "price": "..." }],
  "created_at": "ISO" }
```
Backend behavior: (a) cancel pending recovery calls matching `checkout_token` or `phone`;
(b) attribution — mark a completed call in last 72h as `recovered` with order value;
(c) if COD (gateway includes `cash_on_delivery` / `cod`, or financial_status `pending` per playbook config) → schedule COD confirmation call. Idempotency key: `order_id`.

### 4. `POST /orders/fulfilled` — order fulfilled 🆕 both sides
```json
{ "shop": "...", "order_id": 123, "order_number": 1001, "phone": "...|null",
  "email": "...|null", "customer_name": "...|null",
  "line_items": [{ "title": "...", "quantity": 1 }], "fulfilled_at": "ISO" }
```
Backend behavior: schedule feedback call per feedback playbook (delay days). Idempotency key: `order_id`.

### 5. `POST /webhooks/customers` — customer created/updated 🆕 backend
```json
{ "shop": "...", "topic": "customers/create" | "customers/update",
  "body": { /* full Shopify customer payload */ } }
```
Backend behavior: upsert contact (consent mapping from `marketing_consent`). Idempotent by `(org_id, e164)`.

### 6. `POST /uninstalled` — app uninstalled ⚠️ path+auth fix
```json
{ "shop": "x.myshopify.com" }
```
Backend behavior: integration → `disconnected`, cancel ALL pending shopify-playbook scheduled calls for the org, purge stored access token.

### 7. `POST /customers/redact` and `POST /shop/redact` — GDPR 🆕 both sides
```json
{ "shop": "...", "customer": { "id": 1, "email": "...", "phone": "..." } }   // customers/redact
{ "shop": "..." }                                                            // shop/redact
```
Backend behavior: delete/anonymize matching contacts + call metadata within 30 days (immediate is fine). Return 200.

### 8. `POST /customers/data_request` — GDPR data-subject access request 🆕 both sides (1.2)
```json
{ "shop": "...", "customer": { "id": 1, "email": "...", "phone": "..." },
  "orders_requested": [123, 456], "data_request": { "id": 789 } }
```
Backend behavior: Weeber is the system of record for call/contact metadata, so it must compile and be ready to disclose whatever it holds on this customer to fulfill the merchant's data-subject access request. Return 200.

## Endpoints (inbound, all under webbersh's `/api/weeber`, auth via `X-Weeber-Callback-Secret`)

### 9. `POST /orders/annotate` — tag/note an order 🆕 backend calls webbersh (1.2)
```json
// request
{ "shop": "x.myshopify.com", "order_id": 123, "tags_add": ["cod-confirmed"], "note": "Recovery call completed" }
// response 200
{ "order_id": 123, "tags_added": ["cod-confirmed"], "note": "Recovery call completed" }
```
webbersh behavior: adds tags (additive, existing tags untouched) and/or sets the order's staff note via the offline session it already holds for the shop.

### 10. `POST /orders/cancel` — cancel an unconfirmed order 🆕 backend calls webbersh (1.2)
```json
// request
{ "shop": "...", "order_id": 123, "reason": "CUSTOMER" | "DECLINED" | "FRAUD" | "INVENTORY" | "STAFF" | "OTHER",
  "notify_customer": false, "restock": true, "staff_note": "No COD confirmation after 3 call attempts" }
// response 202 (processing) or 200 (already_cancelled)
{ "order_id": 123, "status": "processing", "job_id": "gid://shopify/Job/..." }
```
webbersh behavior: cancellation is asynchronous on Shopify's side (returns a job id, not immediate completion). A retried request against an already-cancelled order returns `200 { status: "already_cancelled" }`, not an error.

### 11. `POST /discounts/create` — recovery discount code 🆕 backend calls webbersh (1.2)
```json
// request
{ "shop": "...", "code": "RECOVER10-<checkout-token-or-uuid>", "title": "Cart recovery 10%",
  "value_type": "percentage" | "fixed_amount", "value": 10, "usage_limit": 1, "applies_once_per_customer": true }
// response 200
{ "code": "RECOVER10-...", "status": "created" | "already_exists", "discount_id": "gid://shopify/DiscountCodeNode/..." }
```
webbersh behavior: Weeber **must** generate a stable, retry-safe `code` (e.g. suffixed with the checkout token) — a fresh random code per retry breaks idempotency. A retried request for a code that already exists returns `200 { status: "already_exists" }`, not an error.

## Environment
| Var | webbersh | Vocalist |
|---|---|---|
| `WEEBER_INTERNAL_SECRET` | required, fail loudly at boot if missing | required |
| `WEEBER_CALLBACK_SECRET` | required, fail loudly at boot if missing (1.2) | required (1.2) |
| `WEEBER_API_URL` | optional, overrides base URL (default `https://api.weeber.ai`) (1.3) | n/a |
| Shopify API version | **2025-01 everywhere** (toml + weeber.server.js) | 2025-01 (already) |

## Change log
- 1.0 — initial contract. Endpoints 2,3,4,5,7 new on backend; 4,7 new on webbersh; 6 fixed on webbersh.
- 1.1 — Updated webbersh webhook routes to unify endpoints, enriched orders/create payload, added orders/fulfilled webhook forwarding, updated scopes to include write_orders and write_discounts, and aligned API version to 2025-01.
- 1.2 — Transport is now bidirectional. Added inbound write-back endpoints 9–11 (orders/annotate, orders/cancel, discounts/create), authenticated via new `X-Weeber-Callback-Secret` / `WEEBER_CALLBACK_SECRET`. Added endpoint 8 (`customers/data_request`), previously acknowledged by webbersh but never forwarded. Removed `access_token` from the `/connected` payload (endpoint 1) — webbersh remains the sole holder/refresher of Shopify tokens. `product_count` in endpoint 1 is now always `null` (dead call removed, no `read_products` scope).
- 1.3 — Weeber backend base URL is now overridable via `WEEBER_API_URL` on webbersh (still defaults to `https://api.weeber.ai`).
- 1.5 — Bumped Shopify API version from retired `2025-01` to `2026-04` (toml + weeber.server.js + SDK `ApiVersion.April26`). Clarified endpoint 11 percentage semantics: `value` is a whole number 0–100; webbersh now converts to Shopify's 0.00–1.00 scale (`value / 100`) and range-guards it (previously sent the raw whole number, producing a 1000%-scale discount). Missing `WEEBER_INTERNAL_SECRET`/`WEEBER_CALLBACK_SECRET` now hard-fail at boot (was log-only). `shop/redact` now erases local `Session` + `ShopOrgLink` rows. `/auth` no longer deletes offline sessions on every hit.
- 1.4 — `POST /connected` (endpoint 1) no longer fires automatically from OAuth `afterAuth` — it now fires when the merchant clicks "Connect to Weeber" on webbersh's post-install screen, so install no longer depends on Weeber being reachable. `org_id` is still sourced from the Shopify install URL (install is always initiated from Weeber's dashboard) but is now persisted by webbersh (new `ShopOrgLink` table, keyed by shop) and read back at connect time, since the button click has no `org_id` on its own URL. Also fixed the `webhooks.app.uninstalled` (and all other webhook routes) 500-on-retry bug: `authenticate.webhook` was throwing an uncaught token-refresh error for shops that had already uninstalled, which is now caught and turned into the mandated 200.
