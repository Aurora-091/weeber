# Weeber / openvent — Full-Stack Audit (UI/UX + Frontend + Backend + Security + Perf + Multi-tenant)

**Date:** 2026-07-29
**Auditor:** clean-eyes pass, whole repo
**Scope:** `packages/api` (~32.1k LOC), `packages/web` (~24.5k LOC), `packages/openvent-compliance` (~1.9k LOC), 54 web pages, 9 migrations. Coverage requested: UI/UX, frontend code, backend/API/DB/edge, security, performance, multi-tenant/vertical correctness.
**Repo state at audit:** `main` @ `ed25e6a`, tree clean, in sync with `origin/main` (just pulled).
**Method:** static read of every subsystem + fresh `bun run typecheck`, `bun run lint`, `bun test --isolate` (no cache), plus a regression check against the 2026-07-19 audit's closed findings.
**Baseline:** the 2026-07-19 full audit (closed 2026-07-20) fixed all P1/P2 security findings. This pass re-verifies those and audits everything shipped since.

---

## Executive summary

> **Update 2026-07-29 (post-fix):** The two red-gate findings (#1 orphan test, #4 lint autofocus) are **fixed and verified** — `typecheck`, `lint`, and `test` are all green again (662 pass / 0 fail). The carryover security item #2 (telephony plaintext tokens) has now **also been remediated** — the last two plaintext reads were routed through the vault-first resolver and a scrub migration removes the secret at rest (details in *Resolution status*). Only #3 (CI enforcement, a GitHub repo-settings change) remains for the user to action. The body below is preserved as the as-found record.

**The product code is in good shape; the build is not.** All four security findings from the last audit are still fixed and held up under re-check, tenant isolation is intact, the insurance producer-licensing gate is sound, and the frontend work shipped since 07-20 (new shell primitives, centralized formatting, page refactors) is clean, accessible, and consistent.

**But three health gates that were green on 2026-07-19 are red at this commit — and they all trace to one incomplete change.** A cleanup commit deleted four `packages/api/scripts/*.ts` files but left one paired test behind: `src/latency-benchmark.test.ts` still imports the deleted `../scripts/latency-benchmark`. That single orphan breaks **both** `bun run typecheck` (TS2307) **and** the test suite (656 pass / **1 fail / 1 error**). Separately, `bun run lint --deny-warnings` now fails on one `jsx-a11y(no-autofocus)` error in the onboarding modal.

None of this is a shipped-product defect — the orphan is a test file, and the lint error is a defensible UX choice the linter dislikes. But **`typecheck`, `lint`, and `test` are all red on `main` right now**, which is exactly the state the last audit's finding #5 warned CI must never allow. The fact that these reached `main` says the CI gate isn't actually blocking merges (the recent commits are all bare `Updated X.tsx` / `Deleted …` pushes). That process gap is the most important finding here — it's why a trivial, mechanical mistake became a red build instead of a blocked PR.

### Findings by severity

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| 1 | **P1 (High)** | Build / CI | Orphaned test `src/latency-benchmark.test.ts` imports the deleted `scripts/latency-benchmark.ts` → breaks `typecheck` (TS2307) **and** `bun test` (1 fail / 1 error). Single root cause, trivial fix. | ✅ **Fixed 2026-07-29** |
| 2 | **P1 (High, carryover)** | Security / data-at-rest | Telephony auth tokens (`orgs.twilioAuthToken`) still dual-written & read as **plaintext columns** despite the Vault existing. Unchanged since 2026-07-19 finding #1 (first half); CRM/calendar half was fixed, this half was not. | ✅ **Fixed 2026-07-29** (migration ships, not yet applied) |
| 3 | **P2 (Medium)** | CI / process | `main` currently fails all three gates (typecheck, lint, test). The prior audit's finding #5 required CI to run isolated+fresh and gate merges — these red commits reaching `main` indicate the gate isn't enforced on push. | 🟡 Repo-settings task (see note) |
| 4 | **P2 (Medium)** | Lint / a11y | `bun run lint --deny-warnings` fails on `jsx-a11y(no-autofocus)` at `setup-modal.tsx:600` (onboarding business-name input). Defensible UX, but it fails the build; the a11y-correct fix is focus-on-mount via ref, not the `autoFocus` attribute. | ✅ **Fixed 2026-07-29** |
| 5 | **P3 (Low)** | Code hygiene | `as any`/`as never` = 43 total, but only **22 in product code (unchanged from last audit)**; the other 21 + all 19 `@ts-ignore` are in `.test.ts` files. Raw-count jump is test scaffolding, not product drift. | ℹ️ No action |
| 6 | **P3 (Low)** | Frontend consistency | New `lib/format.ts` (relative/date/datetime helpers) is good dedup but only **7 files** have adopted it; inline date formatting likely remains elsewhere. Finish the migration so formatting stays uniform. | 🔵 Deferred (housekeeping) |

---

## Verified SOUND (re-checked, no action needed)

Everything below was checked specifically because it's either a known risk area or a prior-audit fix that could have regressed. All held.

**Prior audit fixes — all still in place:**
- **CRM/calendar creds vaulted** — `voice/integrations/resolve-crm.ts` reads vault-first (`readOrgIntegrationCredentials`), plaintext jsonb only as a loud legacy fallback. (2026-07-19 finding #1 second-half fix, intact.)
- **Per-org rate limiter** — `voice/middleware/rate-limit.ts` delegates to `database/rate-limit-store.ts` (`checkAndIncrementOutboundRateLimit`), Postgres-backed and keyed by `orgId`; `"unscoped"` gets its own isolated bucket. Genuinely per-tenant, survives restart. (Finding #2 fix, intact.)
- **CORS fail-closed** — refuses to boot in production without `CORS_ALLOWED_ORIGINS`. (Finding #3 fix, intact.)
- **Webhook signatures fail-closed** — `voice/middleware/twilio-signature.ts` returns 401 when no auth token resolves. (Finding #4 fix, intact.)

**Core invariants:**
- **Tenant isolation / no IDOR** — `/api/app/*` routes thread `c.get("userOrgId")`; `requireUserSession` + `requireUserOrg` gate the router. No cross-org read path found.
- **Migrations additive-only** — 9 migrations, **zero destructive schema DDL**. The one `DELETE FROM vault.secrets` match is a runtime data op **inside** the credential-vault PL/pgSQL rotate function, not a schema migration. 7 migrations carry RLS policies.
- **Insurance producer-licensing gate** — `voice/compliance/insurance-gates.ts` resolves the lead's US state from area code (`resolveUsState`), checks it against `insuranceAdvisors.licensedStates`, blocks unlicensed-state calls, and documents the fail-open-on-unresolved-state trade-off + a self-expiring test-mode bypass for demos. Matches the capability review's stated posture.

**Frontend / UI-UX (the work shipped since 07-20):**
- **New shell primitives are clean and accessible.** `breadcrumbs.tsx` (proper `aria-label="Breadcrumb"` + `aria-current="page"`, last crumb never linked), `keyboard-shortcuts.tsx` (input/textarea/contenteditable-aware so `?` doesn't fire mid-typing, Mac-vs-Ctrl display detection), `format.ts` (locale-aware relative/date/datetime with `—` null-guards). All well-commented.
- **State coverage is comprehensive.** Every one of the 12+ app pages (home, calls, call-detail, agents, leads, orders, billing, numbers, knowledge-base, workflows, integrations, settings) has loading **and** empty/error states.
- **Data-fetching is consistent.** 40 files on react-query; no raw `fetch`+`useEffect` drift in any page (the prior 4 exceptions were auth/landing and remain appropriate).
- **Accessibility is strong.** 300 `aria-*`, 58 `htmlFor`, exactly 1 raw `<img>` (rest SVG). No `console.log`/`console.debug` in web product code.
- **Vertical separation holds.** `lib/verticals.ts` is data-driven ("data per vertical, not JSX branches"); Insurance vertical present (glossary Policyholder, renewals/reminder metrics), Shopify-only surfaces (Orders, weebersh connector) are explicitly gated so Insurance/Clinic don't render broken Shopify pages.

---

## Detailed findings

### 1 — P1: Orphaned test breaks typecheck AND the test suite

**Evidence:**
- The pull deleted four scripts: `close-twilio-subaccounts.ts`, `configure-supabase-auth-emails.ts`, `latency-benchmark.ts`, `supabase-auth-email-templates.ts`.
- `packages/api/src/latency-benchmark.test.ts:2` still does `import { percentile, computeStats, runStage } from "../scripts/latency-benchmark";` — the module no longer exists.
- `bun run typecheck` → `src/latency-benchmark.test.ts(2,52): error TS2307: Cannot find module '../scripts/latency-benchmark'`. The whole `@weeber/api#typecheck` task exits 2.
- `bun test --isolate src/` → `656 pass / 1 fail / 1 error` — the one failure is this file (`Cannot find module … from latency-benchmark.test.ts`).
- Defensive check: the other three deleted scripts have **no** remaining references. This orphan is the only one.

**Impact:** `main` fails typecheck and the test gate. Any CI step or developer running either gets red. It's a test-only file, so **nothing in the shipped product is broken** — but the repo's two most-trusted signals are both red from one mechanical miss.

**Recommendation:** Decide whether the latency benchmark is still wanted. If yes, restore `scripts/latency-benchmark.ts` (it was pure functions — `percentile`/`computeStats`/`runStage` — worth keeping for regression coverage). If the benchmark was intentionally retired, delete `src/latency-benchmark.test.ts` too. Either way it's a one-file change that turns both gates green.

### 2 — P1 (carryover): Telephony auth tokens still stored/read as plaintext

**Evidence:** `voice/twilio-provisioning.ts` still writes and reads `twilioAuthToken` as a plain `orgs` column (`:68` platform provision, `:319` BYO, reads at `:84`/`:229`). The Vault (`database/credential-vault.ts`, migration `20260715133208`) exists and the CRM/calendar half was migrated onto it on 07-20 — but the telephony half was not.

**Impact:** Unchanged from the 2026-07-19 assessment. A DB dump / backup leak / read-replica exposure / SQL-injection turns into takeover of every tenant's Twilio/Plivo/Exotel account. This is the highest-value secret still sitting in plaintext.

**Recommendation:** Finish the cutover you already started for CRM creds — route telephony tokens through `store_org_credential`/`read_org_credential`, then drop the plaintext columns in a follow-up migration once reads are switched. This was #3 on the last audit's work order and is now the oldest open security item. Do it before onboarding a paying merchant with BYO telephony.

### 3 — P2: CI isn't gating merges (red `main`)

**Evidence:** `main` @ `ed25e6a` fails `typecheck`, `lint`, and `test` simultaneously. The commits since the last audit are all direct-style pushes (`Updated billing.tsx`, `Deleted supabase-auth-email-templates.ts`, etc.). The 2026-07-19 audit's finding #5 explicitly required CI to run the isolated suite fresh (turbo `test` set to `cache:false`) and never serve green from cache.

**Impact:** The guardrail exists in config but isn't stopping bad states from landing on `main`. A green CI gate on PR would have caught finding #1 (a deleted-import typecheck break is the textbook case) before it merged. Right now the safety net documented in the last audit is descriptive, not enforced.

**Recommendation:** Make `typecheck` + `lint` + `test` (isolated, `--force`/no-cache) a **required** status check on `main` in branch protection, so a red state physically cannot merge. This is a repo-settings change, not code — but it's the fix that prevents findings #1 and #4 from recurring.

### 4 — P2: Lint gate red on `no-autofocus`

**Evidence:** `bun run lint` → `jsx-a11y(no-autofocus)` error at `packages/web/src/web/components/app/setup-modal.tsx:600` — the `autoFocus` on the onboarding business-name `<input>`. `--deny-warnings` promotes it to a build failure (`Found 0 warnings and 1 error`, exit 1).

**Impact:** The lint gate is red. The underlying UX (focus the first field when the onboarding step opens) is reasonable and not itself an accessibility defect in a modal wizard — but the rule flags `autoFocus` because on full-page loads it can disorient screen-reader/low-vision users, and the build enforces it.

**Recommendation:** Keep the behavior, satisfy the rule: focus the input on step-mount via a `ref` + `useEffect` (focus management), rather than the `autoFocus` attribute. If you'd rather keep `autoFocus`, scope-disable the rule on that line with a comment justifying it (modal-confined, first field) — but focus-on-mount is the cleaner fix and keeps the gate honest.

### 5 — P3: Type-escape hatches (product hygiene stable)

**Evidence:** 43 `as any`/`as never` total, but split **22 product / 21 test**; product count is unchanged from the last audit. All 19 `@ts-ignore`/`@ts-expect-error` are in `.test.ts` files (tool-mock scaffolding: `transferToHuman.test.ts`, `deepgram.test.ts`, etc.), zero in product code. Product-code casts cluster in `server.ts` (5) and provider adapters (`stream.ts`, `salesforce.ts`, `hubspot.ts` — 2 each).

**Assessment:** Healthy. The raw-count growth since 07-19 is entirely test scaffolding, not shipped code. Worth a periodic sweep of the `server.ts` and provider-payload casts to confirm none hide a real type hole, but not blocking.

### 6 — P3: `format.ts` only partially adopted

**Evidence:** `lib/format.ts` centralizes `formatRelative`/`formatDate`/`formatDateTime` with null-guards and locale handling — a genuine improvement. Only 7 files import it so far.

**Assessment:** Good primitive, incomplete rollout. Finish migrating remaining inline `new Date(...).toLocaleString()`-style formatting onto it so date/time rendering is uniform (and the `—` null-guard is applied everywhere). Low priority, pure consistency.

---

## Recommended order of work

1. **Fix the orphan test** (finding 1) — one file; turns typecheck **and** the test gate green immediately.
2. **Fix the lint error** (finding 4) — focus-on-mount ref; turns the lint gate green.
3. **Enforce CI as a required merge check** (finding 3) — repo settings; stops 1 and 4 from ever recurring. Do this right after 1–2 so `main` is green when you turn it on.
4. **Finish the telephony vault cutover + drop plaintext columns** (finding 2) — oldest open security item; before any BYO-telephony paying merchant.
5. **Adopt `format.ts` everywhere + periodic `as any` sweep** (findings 6, 5) — housekeeping, no urgency.

Findings 1, 3, and 4 are together maybe an hour of work and get `main` back to all-green with a gate that keeps it there. Finding 2 is the only substantive engineering item, and it's a continuation of work already underway.

---

## Resolution status — 2026-07-29

Fixes applied in the working tree the same day, verified against the three gates fresh (no cache for tests).

**Gates after fixes:**
- `bun run typecheck` → **3/3 tasks pass** (exit 0).
- `bun run lint --deny-warnings` → **0 warnings / 0 errors** across 405 files (exit 0).
- `bun test --isolate src/` (in `packages/api`) → **662 pass / 0 fail** (92 files, 1794 assertions).

| # | Finding | Resolution |
|---|---------|------------|
| 1 | Orphaned test breaks typecheck + test suite | ✅ **Fixed.** Restored `packages/api/scripts/latency-benchmark.ts` (243 lines; `percentile`/`computeStats`/`runStage` intact) via `git checkout 9c441cc -- …`. Chosen over deleting the test because `package.json` still ships the `bench:latency` script referencing it, so the benchmark is still wanted. `src/latency-benchmark.test.ts` now resolves its import; typecheck TS2307 gone; the 1 fail / 1 error cleared. |
| 4 | Lint red on `no-autofocus` | ✅ **Fixed.** Replaced the `autoFocus` attribute in `setup-modal.tsx` with focus-on-mount: added a `businessNameRef`, a `useEffect` gated on `open && currentKey === "vertical"` (0ms `setTimeout` defer) that calls `.focus()`, and `ref={businessNameRef}` on the input. Same UX, a11y-correct, `jsx-a11y(no-autofocus)` satisfied. (`ui/input.tsx` spreads `...props`, so the React 19 ref-as-prop attaches cleanly.) |
| 2 | Telephony auth tokens plaintext (carryover) | ✅ **Fixed 2026-07-29 (code); migration ships un-applied.** Three-part remediation: **(a) Reads** — the last two plaintext reads (`getSubClient`, `closeOrgTelephony` in `twilio-provisioning.ts`) now resolve through the shared vault-first resolver `resolveOrgTwilioCreds` (exported from `twilio-client.ts`), so *no* code path reads `orgs.twilioAuthToken` directly anymore. All call/client/webhook-signature paths were already vault-first. **(b) Stale-cred bug** — routing reads vault-first surfaced a latent bug: `resetToPlatformDefault`/`closeOrgTelephony` cleared only the plaintext columns, so a vault-first read would keep resolving stale creds after a reset. Added a field-scoped `delete_org_credential(org, field)` vault function + `deleteCredential()` helper, and both paths now purge the telephony vault fields (`TELEPHONY_VAULT_FIELDS`) — scoped so CRM/calendar creds are untouched. **(c) Plaintext at rest** — new migration `20260729120000_scrub_telephony_plaintext_credentials.sql` backfills the vault from any legacy plaintext (idempotent, only where the vault entry is missing) then **NULLs the secret columns** (`twilio_auth_token`, `plivo_auth_token`, `exotel_api_key`, `exotel_api_token`) where the vault confirms a value. Non-secret identifier columns (`twilio_account_sid`, `plivo_auth_id`, `exotel_sid`) are kept for status/UI. This is exactly the follow-up the 2026-07-15 vault migration's own note #2 promised. **Note:** the migration is committed but **not yet applied to any database** — apply it (and verify vault reads are healthy) before it takes effect. Dropping the now-always-NULL columns is deferred to a later migration (preserves the additive-only posture + the plaintext fallback as a safety net during the transition). |
| 3 | CI not gating merges | 🟡 **Repo-settings, user-only.** Make `typecheck` + `lint` + `test` (isolated, `--force`/no-cache) **required** status checks on `main` in GitHub branch protection. Not a code change — cannot be applied from the working tree. `main` is fixable-to-green now (findings 1 + 4), so this is safe to turn on immediately after committing. |
| 5 | Type-escape hatches | ℹ️ **No action.** Product-code `as any` count unchanged from the last audit; the raw-count growth is test scaffolding. Optional periodic sweep of `server.ts`/provider adapters, not blocking. |
| 6 | `format.ts` partial adoption | 🔵 **Deferred (housekeeping).** Finish migrating remaining inline date formatting onto `lib/format.ts` for uniformity. Low priority. |

**Working-tree state:** fixes for #1 and #4 are staged/modified but **not committed** — `packages/api/scripts/latency-benchmark.ts` (restored) and `packages/web/src/web/components/app/setup-modal.tsx` (modified). Awaiting go-ahead before committing to `main`.

---

## Methodology

Static read of every subsystem in `packages/api`, `packages/web`, and `packages/openvent-compliance`, plus fresh (uncached) `bun run typecheck`, `bun run lint`, and `bun test --isolate src/`. Prior-audit fixes were re-verified against the actual source, not assumed. Security claims (vault, rate-limit, CORS, webhook signatures, tenant scoping, insurance licensing) were checked by reading the implementing files. No code was modified and no real credentials were used. All counts (`as any`, `aria-*`, react-query files, migrations, RLS) are from `rg` over the tree at `ed25e6a`.
