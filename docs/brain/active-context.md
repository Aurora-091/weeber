---
doc: active-context
status: LIVE — update every session you do meaningful work
updated: 2026-07-18
---

# Active context — what's happening right now

> **The most important file for an agent picking up cold.** It answers "what were we doing, where did
> we stop, what's next." Keep it short and *current* — a stale entry here is worse than none. When you
> finish meaningful work, update the three sections below and move anything shipped into `progress.md`.

## Current focus

- **Infra consolidation review (done, 2026-07-18):** confirmed the stack is already tightly
  consolidated on Supabase + Vercel + Railway. No external app pile to cancel. Sentry error
  monitoring is now wired (`ADR` — see `changelog/2026-07.md`) but still no-op until `SENTRY_DSN` is
  actually set on Railway (a deploy-config step, not code). Dead `@aws-sdk/client-s3`/`cloudflare`
  deps + dead S3 env vars removed. Still open: adopt **Supabase Realtime** for the dashboard
  (decision made, `ADR-058`, not yet built — currently polls via `refetchInterval` every 4-5s on
  call-detail/calls-list/workflow-runs).
- **Pricing locked (2026-07-18, not deployed):** India + Global tiers, split by voice-provider cost
  tier, minutes not calls. `docs/product-strategy/pricing-lock-2026-07-18.md` / `ADR-057`. Decided
  for grant/investor use — explicitly not on the live site or wired into checkout yet.
- **Workflow Canvas v4 planned (2026-07-18, not started):** `workflow-canvas/v4-locked-scaffold-ai-
  draft-and-flow-preview-plan.md` — supersedes v3's frontend section. Never-blank locked compliance
  scaffold (DNC/calling-window nodes a merchant can't delete), AI-assisted graph drafting from a
  plain-language prompt, and a flow-preview live web call (extends the existing single-agent
  Preview drawer/`test-call-stream.ts`, ADR-051). 3 phases, not yet built.
- **Docs → agent brain (in progress, 2026-07-18):** restructured docs into this `brain/` folder,
  added `AGENTS.md` as the cross-tool entry point, split `DECISIONS.md` → `docs/decisions/` (per-ADR)
  and `changelog.md` → `docs/changelog/` (per-month).

## The one thing that matters most before a pitch/pilot

**B2 — dynamic dual-language-in-one-call switching.** The Hindi/Hinglish STT/TTS *foundation* is solid
and live-verified (2026-07-16, `../voice-quality/hindi-hinglish-voice-support.md`), but true mid-call
language switching — the thing that differentiates Weeber from horizontal builders and from BiteSpeed
(direct Shopify-vertical competitor) — is still the top open item. See `WEEBER-PLAN.md` Phase B.

## Next candidate items (not started, pick by sequencing not scope — ADR-037)

- **A1b** — VAD/endpointing audit (don't assume done just because the pipeline works).
- **B2** — dynamic mid-call language switching (highest leverage).
- Wire `vertical.dashboard.metrics/cards/emptyState` into `pages/app/home.tsx` (currently dead config —
  see Known issues in `progress.md`).
- Opportunistic + cheap: D1 (Kokoro TTS pilot), D4 (join NVIDIA Inception).

## Open decisions waiting on the user (STOP-AND-ASK)

- Feedback agent persona `03` — confirm as final.
- Supabase Realtime on the dashboard: decided (`ADR-058`), just needs someone to actually build it.
- Workflow Canvas v4: plan written, awaiting go-ahead to start Phase 1 (locked scaffold + data
  model) — see the plan doc above for the 3-phase breakdown.
- Set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the free Sentry.io project + env var).

_Last updated by: workflow-canvas v4 planning session, 2026-07-18._
