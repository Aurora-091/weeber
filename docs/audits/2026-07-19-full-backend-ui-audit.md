# Weeber / openvent — Full Codebase Audit (Backend + UI/UX)

**Date:** 2026-07-19
**Auditor:** clean-eyes pass, whole repo
**Scope:** `packages/api` (~31k LOC), `packages/web` (~24k LOC), `packages/openvent-compliance` (~1.9k LOC), 55 web pages, 9 migrations
**Repo state at audit:** `main` @ `8e30661`, tree clean, in sync with `origin/main`
**Method:** static read of every subsystem + `bun run typecheck`, `bun run lint`, `bun test --isolate` all run fresh (no cache)

---

## Executive summary

The codebase is **materially healthier than a typical pre-launch product**. Auth, org-scoping (tenant isolation), API-key hashing, the voice pipeline's defensive error handling, prompt-injection defenses, additive-only migrations, and error-response hygiene are all sound. The frontend is mature: config-driven vertical adaptation, react-query as the primary data layer with sane defaults, full shadcn primitives, and the SEO/meta gaps flagged in the June audit are now **all fixed**.

The findings below are concentrated in **two real areas**: (1) **credentials at rest are partly stored/read as plaintext** despite a Supabase Vault existing, and (2) the **outbound-call rate limiter is global, not per-tenant**. Everything else is P2/P3 config-hardening or DX robustness.

No P0 product-breaking defect was found. The single biggest *process* risk is that the test suite only passes under the `--isolate` flag — running the natural `bun test` produces 69 false failures, and turbo caching can mask a genuinely red suite.

### Findings by severity

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | **P1 (High)** | Security / data-at-rest | Telephony auth tokens stored & read as plaintext columns; CRM/calendar creds in `integrations.credentials` jsonb not vaulted — despite Vault existing |
| 2 | **P1 (High)** | Reliability / multi-tenancy | Outbound-call rate limiter is a global module singleton — one org can throttle all orgs; also process-local (not shared across instances, resets on restart) |
| 3 | **P2 (Medium)** | Security / config | CORS reflects any origin with `credentials: true` when `CORS_ALLOWED_ORIGINS` is unset (low real-world risk: Bearer auth, no cookies) |
| 4 | **P2 (Medium)** | Security / config | Twilio webhook signature validation is skipped when no auth token is resolvable (spoofing gap only in a misconfigured org) |
| 5 | **P2 (Medium)** | DX / CI integrity | Suite requires `bun test --isolate`; raw `bun test` = 69 false failures (Bun `mock.module` cross-file leakage). Turbo cache can mask a red suite |
| 6 | **P3 (Low)** | Frontend consistency | Data-fetching pattern is mixed (react-query in 40 files, raw `fetch`+`useEffect` in 4) — but the 4 are all auth flows + static landing where react-query doesn't fit; effectively a non-issue |
| 7 | **P3 (Low)** | Code hygiene | 22 `as any`/`as never` casts, 6 TODO/FIXME across 55k LOC — low but worth a periodic sweep |

---

## Verified SOUND (no action needed)

These were checked specifically because they're the usual failure points; each held up:

- **Auth** — `app/middleware/supabase-auth.ts` does local JWT verification (HS256 via `SUPABASE_JWT_SECRET`, else JWKS with a 10-min in-memory cache). `requireUserSession` + `requireUserOrg` gate every `/api/app/*` route. Admin auth (`voice/middleware/admin-auth.ts`) uses an env key + labeled keys (ADR-025); the no-op fallback only triggers when **zero** keys are configured.
- **Tenant isolation / no IDOR** — every `/api/app/*` query threads `c.get("userOrgId")`. `getOrgCall` / `getOrgCallTranscript` / `getOrgCallToolCalls` all filter by `(id, orgId)`. No cross-org read path found.
- **API-key hashing** — both `voice/admin-keys.ts` (`ovk_`) and `voice/leads/api-keys.ts` (`wlk_`) SHA-256 hash, return plaintext exactly once, soft-delete via `revokedAt`; lead keys are org-scoped.
- **Voice pipeline** — `voice/stream.ts` wraps every stage (STT/LLM/TTS/telephony) defensively; a dropped upstream socket ends the call cleanly instead of hanging. Prompt-injection defense is real: `looksLikePromptInjection()`, `injectionSensitivity` presets (low/medium/high) that inject guardrail language into the system prompt, plus a `flagGuardrailEvent` tool. Silence timer (warn at 8s → hang up 7s later = 15s) is correct despite the confusing constant names.
- **Migrations** — 9 additive migrations in `supabase/migrations/`, **zero** destructive DDL (no `DROP TABLE`/`DROP COLUMN`/`TRUNCATE`/`SET NOT NULL`), 6 carry RLS policies. Matches the additive-only constraint.
- **Error responses** — `middleware/error-handler.ts` distinguishes operational vs non-operational `AppError`, returns generic `Internal Server Error` for 500s (no stack/message leakage), and defers to the logger's Sentry hook to avoid double-reporting.
- **SEO/meta (June audit follow-up: RESOLVED)** — `index.html` now has meta description, canonical, `og:image` (1200×630 w/ alt), Twitter summary_large_image, JSON-LD structured data, viewport. `lib/usePageMeta.ts` manages per-page `<title>` for the SPA.
- **Frontend architecture** — config-driven vertical adaptation (`lib/verticals.ts`, "data per vertical, not JSX branches"); full shadcn `ui/` + shell primitives (empty-state, skeletons, error-boundary, command-palette); react-query configured in `main.tsx` with sane defaults (`staleTime 30s`, `retry 1`, `refetchOnWindowFocus false`); 289 `aria-*`, 57 `htmlFor`, only 1 `<img>` (rest SVG); responsive (only 1 hardcoded px width in app pages).
- **Health checks** — `typecheck` PASS (3 pkgs), `lint` PASS (oxlint, 0/0 across 392 files), `bun test --isolate` = **621 pass / 0 fail** (85 files, 1723 assertions).

---

## Detailed findings

### 1 — P1: Credentials at rest are partly plaintext despite Vault existing

**Evidence:**
- A Supabase Vault credential store exists and works: `packages/api/src/database/credential-vault.ts` uses pgsodium via `store_org_credential` / `read_org_credential` PL/pgSQL functions (migration `20260715133208_setup_credential_vault.sql`).
- **But telephony provisioning still dual-writes plaintext columns.** `voice/twilio-provisioning.ts:68` and `:207` write `twilioAuthToken` directly to the `orgs` table (platform + BYO paths). The read side reads them straight back: `twilio-client.ts:25`, `plivo-client.ts:22`, `exotel-client.ts:46`, `middleware/plivo-signature.ts:36`. Code comments frame this as "kept for fallback during vault transition."
- **CRM/calendar credentials are never vaulted at all.** `integrations.credentials` (jsonb) is read raw: `voice/integrations/resolve-crm.ts:42` (`row.credentials as Record<string, string>`) and `voice/tools/bookAppointment.ts:18`. These are OAuth tokens / API keys for connected CRMs and calendars, sitting in plaintext in Postgres.

**Impact:** A DB dump, backup leak, read-replica exposure, or SQL-injection anywhere becomes full account takeover of every tenant's Twilio/Plivo/Exotel account **and** their connected CRM/calendar. This is the highest-value data in the system.

**Recommendation:** Finish the vault transition before onboarding real paying merchants. Route telephony tokens through `store_org_credential`/`read_org_credential`, then drop the plaintext columns in a follow-up migration once the read paths are cut over. Extend the same treatment to `integrations.credentials`. If a full cutover isn't feasible pre-launch, at minimum vault the CRM/calendar creds (they have no partial migration at all) and document the residual telephony risk with a hard deadline.

### 2 — P1: Outbound rate limiter is global, not per-org

**Evidence:** `voice/middleware/rate-limit.ts` — `rateLimitOutboundCalls` uses module-level `windowStart` / `callsInWindow` singletons.

**Impact:** Two independent problems. (a) The limit is **shared across all tenants** — one aggressive org exhausts the window and throttles everyone else. (b) It's **process-local** — resets on restart and isn't shared across instances, so it provides no real guarantee under horizontal scaling.

**Recommendation:** Key the limiter by `orgId` and back it with a shared store (Redis/Postgres) so the limit is per-tenant and holds across instances/restarts. Even a Postgres-backed counter is enough at current scale.

### 3 — P2: Permissive CORS fallback

**Evidence:** `index.ts` — when `CORS_ALLOWED_ORIGINS` is unset, the app reflects any request origin and sets `credentials: true` (already flagged in a code comment).

**Impact:** Low in practice — auth is header-based Bearer, there are no cookies, so `credentials: true` reflection doesn't grant a CSRF/credential-theft path today. It's a config-hygiene launch-gate item, not an active vuln.

**Recommendation:** Make `CORS_ALLOWED_ORIGINS` a required env in production (fail closed / refuse to boot without it) rather than silently falling back to reflect-any.

### 4 — P2: Twilio webhook signature validation skipped when no token resolvable

**Evidence:** `voice/middleware/twilio-signature.ts` — when no auth token can be resolved for the org, validation is skipped and a warning is logged once.

**Impact:** A misconfigured org (no resolvable token) accepts unsigned/spoofed webhooks — an attacker could forge call events. Only reachable in the misconfigured state; correctly-provisioned orgs validate.

**Recommendation:** Fail closed — reject the webhook (401) when no token is resolvable, rather than passing it through. Pair with an alert so the misconfiguration surfaces.

### 5 — P2: Test suite only green under `--isolate`; turbo cache can mask red

**Evidence:** The configured script is `bun test --isolate src/`, which passes 621/621. Running the natural `bun test` (no flag) produces **69 failures** across many files — caused by Bun `mock.module` cross-file state leakage (each failing file passes in isolation). Separately, `turbo` cached the test task as green in a prior run ("FULL TURBO"), which would have hidden a genuinely broken suite.

**Impact:** A developer or CI step that runs `bun test` directly, or trusts a turbo cache hit, gets a misleading signal — either 69 false failures or a masked real failure.

**Recommendation:** (a) Document loudly that tests **must** run with `--isolate` (or make `bun test` alias to it). (b) In CI, run the test task with `--force` (or exclude it from remote cache) so a red suite can never be served from cache. (c) Longer term, fix the underlying mock leakage (per-file `mock.restore()` in `afterEach`) so the suite is invocation-robust.

### 6 — P3: Mixed data-fetching pattern (effectively a non-issue)

**Evidence:** 40 web files use react-query (`useQuery`/`useMutation`); 4 pages still use raw `fetch` + `useEffect`: `auth-callback.tsx`, `login.tsx`, `reset-password.tsx`, `landing.tsx`.

**Assessment:** All four are exactly the places react-query doesn't fit — one-shot auth flows and a static marketing page with no server data. No action required; noted only so it isn't mistaken for drift.

### 7 — P3: Type-escape hatches and TODOs

**Evidence:** 22 `as any` / `as never` casts and 6 TODO/FIXME across ~55k LOC, 0 `@ts-ignore`.

**Assessment:** Low density and healthy for a fast-moving pre-launch codebase. Worth a periodic sweep to make sure none of the casts hide a real type hole (especially the ones around DB rows and provider payloads), but not blocking.

---

## Recommended order of work

1. **Vault the CRM/calendar credentials** (finding 1, second half) — no migration exists for these at all; smallest change, removes the clearest plaintext-secret exposure.
2. **Per-org, shared-store rate limiter** (finding 2) — correctness bug that gets worse with scale/traffic.
3. **Finish telephony vault cutover + drop plaintext columns** (finding 1, first half).
4. **Fail-closed CORS + Twilio signature** (findings 3, 4) — config hardening, quick.
5. **CI: force test task + alias `--isolate`** (finding 5) — protects every finding above from silent regression.

---

*All findings are static-analysis + test-run based. Nothing in `packages/openvent-compliance` was modified, and no real credentials were used.*
