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

- **Insurance dashboard KPI mislabeling fixed + live-verified (2026-07-18):** what the docs called
  "dead config" (`vertical.dashboard` unread by `home.tsx`) was actually already wired, but wrong —
  `renewals_confirmed`/`leads_qualified` read Shopify's `recovery`/`codConfirmation` KPI blocks.
  Fixed with real `insuranceRenewal`/`insuranceLeadFollowup` blocks in `computeKpis()`
  (`org-queries.ts`), attributed via `calls.agentPersona` value-match (no FK, same pattern as
  `codConfirmation`). **Verified live, not just typecheck**: local fresh Postgres (never pointed
  the real backend at the production DB — `scheduler.ts` auto-dials due scheduled calls on boot,
  too risky against real customer data), 2 real Supabase test users via the actual Auth admin API,
  seeded test orgs, logged in through the real UI, screenshotted both dashboards. Test users/DB/
  servers all cleaned up after. Commit `c2bed26`.
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

## Language support: closed, scoped correctly (ADR-060, 2026-07-19)

**B2 — multilingual understanding, not mid-call switching.** The Hindi/Hinglish STT/TTS foundation is
solid and live-verified (2026-07-16, `../voice-quality/hindi-hinglish-voice-support.md`), and Indic
calls now smart-default to Sarvam automatically (ADR-060, `../voice-quality/language-support.md`).
Mid-call *spoken-language switching* is REJECTED — not an open gap — because flipping the TTS voice
mid-call breaks voice identity, adds latency, and destabilizes the call (one fixed spoken language per
call; STT code-switching understanding is separate and stays). The differentiator is native Hinglish
+ multilingual understanding, not a switching gimmick. Only open B2 item: B2.5 (localized system
messages), minor polish. See `WEEBER-PLAN.md` Phase B and ADR-060.

## Next candidate items (not started, pick by sequencing not scope — ADR-037)

- **A1b** — VAD/endpointing audit (don't assume done just because the pipeline works).
- **B2.5** — localize system messages per language (small polish; mid-call switching REJECTED per ADR-060).
- Opportunistic + cheap: D1 (Kokoro TTS pilot), D4 (join NVIDIA Inception).

## Open decisions waiting on the user (STOP-AND-ASK)

- Supabase Realtime on the dashboard: decided (`ADR-058`), just needs someone to actually build it.
- Workflow Canvas v4 Phase 3 (flow preview via web call): awaiting go-ahead to start — the
  merchant canvas editor now exists, so this is the last remaining piece of the v4 plan.
- Set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the free Sentry.io project + env var).

_Last updated by: insurance dashboard KPI-mislabeling fix + live verification session, 2026-07-18._
