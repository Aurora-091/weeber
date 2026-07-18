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
  consolidated on Supabase + Vercel + Railway. No external app pile to cancel. Two follow-ups surfaced,
  not yet actioned: (1) add error monitoring (Sentry free tier — the one real gap, errors currently
  only hit Railway logs), (2) adopt **Supabase Realtime** for the dashboard (it currently polls via
  `refetchInterval` every 4–5s on call-detail/calls-list/workflow-runs). See
  `../reference/resources.md`.
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

- Trigger-split: config-driven vs visual canvas (ADR-033).
- Feedback agent persona `03` — confirm as final.
- Error monitoring: adopt Sentry free tier? (recommended)
- Supabase Realtime on the dashboard: adopt? (recommended, already paid for)

_Last updated by: infra + docs-brain session, 2026-07-18._
