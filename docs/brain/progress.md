---
doc: progress
status: LIVE — keep current
updated: 2026-07-18
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
- Workflow Canvas (React Flow automation builder).
- Compliance scaffolding: DNC (no bypass), TCPA/TRAI calling-window, HIPAA guardrail, GDPR
  retention/erasure, audit-trail export (`packages/openvent-compliance`).
- Auth: Supabase (JWKS), email OTP sign-in, waitlist + referral system.
- Config storage: DB-backed `org_agent_configs`/`org_workflow_configs` (not env).
- All 5 agent personas written (not placeholders).
- Infra: Railway Pro + Supabase Small + Vercel Pro, all confirmed live (Audit #7, 2026-07-17).
- Hindi/Hinglish STT/TTS foundation, live-verified (2026-07-16).
- Sentry error monitoring wired (2026-07-18) — no-op until `SENTRY_DSN` is set on Railway (still
  outstanding: creating the free Sentry.io project + setting the env var, not a code task).
- Dead deps/config removed (2026-07-18): `@aws-sdk/client-s3`, `cloudflare` (root `package.json`),
  and the dead S3/`SUPABASE_KB_BUCKET` env vars from `.env.example`.

## In progress

- **Docs → agent brain restructure** (2026-07-18) — this `brain/` folder, `AGENTS.md`, split
  decisions/changelog.

## Next (by sequencing, not scope — ADR-037)

- **B2 — dynamic mid-call language switching** (top leverage, blocks a serious pitch/pilot).
- **A1b — VAD/endpointing audit.**
- Per-org DNC lists, full RBAC/multi-seat, per-org billing entity (Phase-1 workstreams, check
  prerequisites in `WEEBER-PLAN.md` J–S).
- More ecommerce platforms after Shopify: WooCommerce, BigCommerce, Dukaan (build platform-agnostic).

## Recommended, not yet decided (from 2026-07-18 infra review)

- Adopt **Supabase Realtime** for the dashboard (replace 4–5s polling; already paid for) — decision
  made (`ADR-058`), implementation not started.
- Actually set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the project + env var).

## Known issues / debt (open)

- `VerticalDefinition.dashboard.metrics/cards/emptyState` (`web/src/web/lib/verticals.ts`) defined for
  shopify + insurance but `pages/app/home.tsx` never reads it — **dead config**. Fix: read
  `vertical.dashboard` in `home.tsx`.
- Staging Supabase project has a placeholder `DATABASE_URL` on Railway — **unconfirmed**, don't assume
  fixed.
- Branch protection on `main` not yet enabled in GitHub settings.
- Provider-side + Twilio concurrency limits unverified (not inferable from an API key).

## Closed recently (so this file doesn't look like it's ignoring them)

- Theme portal-scoping, agent full-window layout, 2 Dependabot vulns — fixed 2026-07-13.
- DB connection pool + Supabase compute tier — fixed/upgraded 2026-07-17.
- The "38 pre-existing test failures" baseline — was a false signal, not real bugs (ADR-056).
