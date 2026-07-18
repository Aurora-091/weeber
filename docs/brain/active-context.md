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

- **Feedback agent persona confirmed + live (2026-07-18):** user confirmed `03-feedback-agent.md`
  as final. `seed.ts`'s `active` flag flipped `false → true` — was the only inactive persona of the
  5, now selectable by merchants and eligible for AI-draft on next boot's seed upsert (no manual DB
  fix needed, self-heals like the templates-path bug fix did). STOP-AND-ASK gate #4 closed.
- **VoiceOrb enhancement + app/admin overlap scan (done, 2026-07-18):** in-app `VoiceOrb` rebuilt
  as a 3-blob morph cluster + glow to match marketing `DemoOrb` (same-product visual consistency).
  Typecheck/lint clean, visually confirmed live, committed as `dcb19e8` and pushed to `main`. App/
  admin (`components/shell`, `components/dashboard`, `pages/app`, `pages/dashboard`) scanned for the
  same fixed-percentage/z-index/position anti-patterns that caused the marketing hero overlap bug —
  came back clean. **Static-analysis-only** — no backend/DB in this sandbox, so authenticated
  `/app/*`/`/dashboard/*` pages couldn't be live-rendered to visually confirm; flag this to whoever
  picks this up next if a live overlap bug is later reported in the app/admin panel.
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
- **Workflow Canvas v4 (2026-07-18):** `workflow-canvas/v4-locked-scaffold-ai-draft-and-flow-
  preview-plan.md` — supersedes v3's frontend section. **Phase 1 done**: `customGraph` column,
  `locked` flag + `dncCheck`/`callingWindowCheck` pass-through node types, `scaffold.ts`'s
  blank-scaffold builder + save-time `validateLockedNodesEnforced`. **Phase 2 done**:
  `voice/workflows/ai-draft.ts`'s `draftWorkflowGraph()` + `POST /workflow-configs/:templateKey/
  ai-draft`. **Merchant-facing full canvas editor built** (`app/workflows.tsx`) — standard
  (read-only+override, unchanged default) vs custom (full drag/connect/delete, reuses the admin
  editor's exact components) modes, entered via "Customize from this template"/"Start blank," AI
  drafting wired in via a prompt box in the custom editor. **Phase 3 (flow preview via web call)
  not started.**
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

- Supabase Realtime on the dashboard: decided (`ADR-058`), just needs someone to actually build it.
- Workflow Canvas v4 Phase 3 (flow preview via web call): awaiting go-ahead to start — the
  merchant canvas editor now exists, so this is the last remaining piece of the v4 plan.
- Set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the free Sentry.io project + env var).

_Last updated by: VoiceOrb enhancement + app/admin overlap scan session, 2026-07-18._
