# Developer Changelog (Internal Changelog)

This document tracks system changes, database schemas, API parameters, and architectural details implemented during the backend workstream updates.

---

## Completed Backend Workstreams

| Workstream | Module / Component | Focus / Goal | Core Changes & Files |
| :--- | :--- | :--- | :--- |
| **Workstream A** | Config & Seeding | Database-backed agent template config overrides & hierarchical prompt resolution | - Created `agent_templates` and `org_agent_configs` tables<br>- Idempotent catalog seeder inside `seed.ts` executing at boot<br>- Hierarchical lookup logic inside `agent.ts`<br>- Dynamic voice stream prompt loading |
| **Workstream J** | Webhook Cancellation | Cancel pending Shopify cart-recovery scheduled calls by `checkoutToken` first | - Added `checkout_token` column & index to `scheduled_calls`<br>- Populated token on webhooks and workflow retry engines<br>- Cancel by token with fallback to phone in `/orders/create` |
| **Workstream K** | Order Attribution | Matching executed recovery calls with orders within 7-day conversion window | - Populates `recovered_order_id` and `recovered_amount` on successful order conversion webhooks |
| **Workstream L & M** | Scoped GDPR Erasure | Erasure of Shopify customer data and GDPR Edge function notification | - Scoped Drizzle deletions inside `adapters.ts` (calls, transcripts, callerMemory)<br>- Protected edge function call using `resilientCall` inside `/customers/redact` |
| **Workstream N** | Per-Org Outbound Caller ID | Dynamic resolution of outbound dial-time caller ID | - Added `outbound_number` to `orgs` table<br>- Gated POST `/calls/outbound` and scheduler sweeps to resolve phone number priority |

---

## Database Schema Modifications

| Table Name | Column Name | Data Type | Modifiers / Indexing / Description |
| :--- | :--- | :--- | :--- |
| **`orgs`** | `outbound_number` | `text` | Org-specific outbound Twilio dial-time phone number |
| **`scheduled_calls`** | `checkout_token` | `text` | Shopify cart token; indexed for checkout match performance |
| **`scheduled_calls`** | `recovered_order_id` | `text` | Shopify converted order ID |
| **`scheduled_calls`** | `recovered_amount` | `text` | Converted checkout amount |
| **`agent_templates`** | *New Table* | - | Static catalog of Shopify agent prompt configurations |
| **`org_agent_configs`**| *New Table* | - | Organization specific prompt overrides matching templates |

---

## API & Parameter Updates

- **POST `/calls/outbound`**:
  - Accept optional parameter `orgId` (string) in JSON body payload.
  - Automatically sets Twilio outbound caller ID parameter to the org's configured `outboundNumber` if present, with TWILIO_PHONE_NUMBER env fallback.
- **POST `/integrations/shopify/orders/create`**:
  - Validates `checkout_token` along with `phone` to identify recovery opportunities.
- **POST `/integrations/shopify/customers/redact`**:
  - Erases all customer recordings/transcripts within the organization bounds, and fires the `gdpr-redact-notify` edge function.

---

## 2026-07-10 — Audit #01 fixes (D1, D2)

- **D1 (build-breaking, fixed):** `packages/api/src/voice/routes.test.ts` had two `noUnusedParameters` TS
  errors that left `main`'s `tsc --noEmit` failing. Fixed by prefixing the two unused mock params with `_`.
- **D2 (compliance-adjacent, fixed after explicit user confirmation):** `callerMemory` was keyed by
  `phoneNumber` only — a phone number is not a unique identity across the whole system, so a GDPR erasure
  request from one Weeber merchant could silently delete another merchant's memory of the same caller.
  - `caller_memory` table: added `org_id` column (`text`, default `""` for self-hosted/no-org usage), primary
    key changed from `(phone_number)` to `(org_id, phone_number)`. Migration: `packages/api/drizzle/0002_lame_thena.sql`.
  - `getCallerMemory` / `upsertCallerMemory` (`caller-memory.ts`) now take `orgId` as their first argument.
  - `eraseOrgDataForPhoneNumber` (`compliance/adapters.ts`) now scopes the `caller_memory` delete by
    `(orgId, phoneNumber)`, matching how it already scoped `calls`/`scheduledCalls`.
  - New regression test: `packages/api/src/voice/compliance/adapters.test.ts` asserts the delete condition
    references `org_id`, and that two orgs' erasure calls produce distinct conditions.
  - No production data existed yet (ADR-034), so this was a clean structural migration, not an additive-only
    patch — acceptable per that same precedent.

---

## 2026-07-10 — Root cause of "sorry, I didn't catch that" every turn

`AI_GATEWAY_BASE_URL` on Railway was set to `https://ai-gateway.vercel.sh/v1` — a path that doesn't exist.
The AI SDK's own default (and the correct one) is `.../v4/ai`. Every LLM turn was 404ing against
`/v1/language-model`, and `agent.ts`'s empty-completion fallback silently turned that into "sorry, I didn't
catch that" instead of surfacing a real error, which looked exactly like an STT problem from the caller's
seat. Fixed by correcting the Railway env var (no code change) and confirmed live via a real outbound test
call + DB transcript. Also added diagnostic logging (`agent.ts`, logs finishReason/usage/tool calls/history
length on any empty-turn fallback) so a repeat of this class of bug surfaces immediately next time.

## 2026-07-10 — Agent skills: hangUp, transferToHuman, silence handling, guardrails

- **New tools** (`voice/tools/`): `hangUp` (agent ends the call — actually terminates the Twilio call leg via
  the REST API, not just the WebSocket, after the closing line finishes), `transferToHuman` (redirects the
  live call to `orgs.humanTransferNumber` / `HUMAN_TRANSFER_NUMBER` env fallback via a real `<Dial>`, same
  override-then-env pattern as `outboundNumber`), `flagGuardrailEvent` (model self-reports a guardrail
  moment — topic-boundary / unauthorized-promise / prompt-injection / abuse — logged through the existing
  `toolCalls` table, so it's visible on the call-detail dashboard with zero new UI).
- **Persona hardening** (`agent.ts`): new `withCallControl()` wraps every resolved persona (org override,
  template, explicit, env map, or hardcoded default — one injection point, not duplicated per template) with
  call-control and guardrail instructions covering hangUp/transfer usage, topic boundaries, not inventing
  prices/policies, and holding the system persona against caller-supplied "ignore your instructions"-style
  attempts.
- **Heuristic prompt-injection detector** (`stream.ts`): independent, defense-in-depth phrase scan on raw
  caller transcript text (regex set for "ignore your instructions", "you are now a...", etc.) — logs a
  `guardrail-heuristic-detector` tool-call row even if the model doesn't self-report via flagGuardrailEvent.
- **Silence handling** (`stream.ts`): after each spoken turn, an 8s timer arms; if the caller stays silent,
  the agent re-prompts once ("Are you still there?"), then hangs up after a further 7s of silence. Resets on
  any real caller speech. Re-prompt/goodbye lines are canned (no LLM call) so a flaky turn can't compound a
  quiet caller into an even longer wait.
- **Voicemail detection**: outbound calls now request async AMD (`machineDetection: "DetectMessageEnd"`,
  `asyncAmd`, new `/amd-status-callback` route). If Twilio reports a machine answered, the live call is
  redirected out of the agent stream to a short `<Say>` + `<Hangup>` instead of running the agent into an
  answering machine's beep and silence.
- **Schema**: `orgs.human_transfer_number` (additive, nullable) — migration `0003_normal_wallop.sql`.
- New tests: `tools/hangUp.test.ts`, `tools/transferToHuman.test.ts`, `tools/flagGuardrailEvent.test.ts`,
  `stream.test.ts` (heuristic detector + playback-estimate helper), plus a `resolvePersona` assertion that
  call-control instructions land on every persona source.
