---
doc: progress
status: LIVE — keep current
updated: 2026-07-19
---

# Progress — done / in-progress / next / known issues

> A glance-level status board. The authoritative roadmap is `WEEBER-PLAN.md`; the authoritative "what
> shipped when" is `../changelog/`; the authoritative "why" is `../decisions/`. This file is the fast
> summary that saves an agent from reading all three.

## Done (works end-to-end, real-verified)

- Core voice pipeline: real inbound + outbound calls, barge-in, streamed tool-calling.
- Multi-provider STT/TTS/LLM with cross-provider failover; per-agent/per-call override.
- Multi-tenant telephony: Twilio (platform + BYO sub-accounts) + Plivo/Exotel (BYO).
- Shopify vertical: cart recovery, COD confirmation, feedback agents; revenue attribution.
- Per-org retry cadence via `scheduledCalls` + the in-process sweep; webhook outbox with backoff.
- Workflow Canvas (React Flow automation builder) — admin template editor, plus (2026-07-18)
  merchant-facing custom graph editing: locked compliance scaffold (`customGraph`,
  `dncCheck`/`callingWindowCheck` nodes), AI-assisted drafting, full merchant canvas editor.
  Flow preview via web call (v4 Phase 3) not yet built.
- Compliance scaffolding: DNC (no bypass), TCPA/TRAI calling-window, HIPAA guardrail, GDPR
  retention/erasure, audit-trail export (`packages/openvent-compliance`).
- Auth: Supabase (JWKS), email OTP sign-in, waitlist + referral system.
- Config storage: DB-backed `org_agent_configs`/`org_workflow_configs` (not env).
- All 5 Shopify agent personas + 10 insurance agent prompts written (not placeholders); insurance
  agents 04–08 have config-driven en/hi/hinglish language variants; persona 09 = Final Expense
  Qualifier + Warm-Transfer (US/English-only) (2026-07-19).
- Native leads/records layer (Phases 1–3, 2026-07-19): owned `leads` table (deduped `(orgId, phone)`),
  captured-field promotion at `finalizeCall`, insurance Leads page (list/detail/status/assign/
  call-now/Excel export/manual CRUD), `POST /api/leads/ingest` (per-org `wlk_` keys, schema-validated,
  regulated-key rejection, idempotent), intake-schema editor, public hosted form `/f/:orgId`
  (orgId = write-only form token), on-demand "Sync to CRM" mirror (HubSpot/Salesforce/GHL). 621
  tests pass. ADR-061.
- Infra: Railway Pro + Supabase Small + Vercel Pro, all confirmed live (Audit #7, 2026-07-17).
- Hindi/Hinglish STT/TTS foundation, live-verified (2026-07-16).
- Sentry error monitoring wired (2026-07-18) — no-op until `SENTRY_DSN` is set on Railway (still
  outstanding: creating the free Sentry.io project + setting the env var, not a code task).
- Dead deps/config removed (2026-07-18): `@aws-sdk/client-s3`, `cloudflare` (root `package.json`),
  and the dead S3/`SUPABASE_KB_BUCKET` env vars from `.env.example`.

## In progress

- Nothing mid-flight. Last session (native leads layer + integrations strategy, 2026-07-19) shipped
  and verified. Pick the next item from "Next" below by sequencing, not scope (ADR-037).

## Next (by sequencing, not scope — ADR-037)

- **B2.5 — localize system messages per language** (small polish; mid-call spoken-language switching
  REJECTED per ADR-060, and Indic calls now smart-default to Sarvam — language support is scoped/closed).
- **A1b — VAD/endpointing audit.**
- Per-org DNC lists, full RBAC/multi-seat, per-org billing entity (Phase-1 workstreams, check
  prerequisites in `WEEBER-PLAN.md` J–S).
- More ecommerce platforms after Shopify: WooCommerce, BigCommerce, Dukaan (build platform-agnostic).
- **Pipedrive native inbound adapter** — next likely native integration on the leads-ingest edge
  (interim path = Pipedream → `/api/leads/ingest`). See `product-strategy/integrations-strategy-and-
  roadmap-2026-07-19.md`.
- **Leads layer Phase 2 activation** — wire `triggerWorkflow` on ingest once it respects the
  DNC/TCPA/quiet-hours dial-gates (currently accepted-but-not-dialing on purpose); wire per-org
  ingest keys into a first real external source when a pilot needs it (ADR-061).

## Recommended, not yet decided (from 2026-07-18 infra review)

- Adopt **Supabase Realtime** for the dashboard (replace 4–5s polling; already paid for) — decision
  made (`ADR-058`), implementation not started.
- Actually set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the project + env var).

## Known issues / debt (open)

- Staging Supabase project has a placeholder `DATABASE_URL` on Railway — **unconfirmed**, don't assume
  fixed.
- Branch protection on `main` not yet enabled in GitHub settings.
- Provider-side + Twilio concurrency limits unverified (not inferable from an API key).

## Closed recently (so this file doesn't look like it's ignoring them)

- Native leads/records layer shipped (Phases 1–3, minus the deferred Shopify Orders migration);
  integrations strategy set (Pipedream inbound, native outbound adapters); insurance en/hi/hinglish
  language variants + Final Expense Qualifier agent — 2026-07-19 (ADR-061; `changelog/2026-07.md`).
- Insurance dashboard `renewals_confirmed`/`leads_qualified` were mislabeled Shopify cart-recovery/
  COD-confirmation numbers (not "dead config" as previously logged here) — fixed with real
  `insuranceRenewal`/`insuranceLeadFollowup` KPI blocks, verified LIVE against a local DB + 2 real
  Supabase test users (not just typecheck) — 2026-07-18.
- Demo widget play button hit-target drift + feedback agent persona confirmed live — 2026-07-18.
- In-app `VoiceOrb` rebuilt (3-blob morph + glow) to match marketing `DemoOrb`; app/admin overlap
  scan came back clean (static-analysis-only, no live backend to confirm against) — 2026-07-18.
- Theme portal-scoping, agent full-window layout, 2 Dependabot vulns — fixed 2026-07-13.
- DB connection pool + Supabase compute tier — fixed/upgraded 2026-07-17.
- The "38 pre-existing test failures" baseline — was a false signal, not real bugs (ADR-056).
