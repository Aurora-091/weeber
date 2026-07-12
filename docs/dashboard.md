# Dashboard

A small operator dashboard ships at `/dashboard`, gated behind an admin key (entered once per browser
session, never sent anywhere but your own server) — either your `ADMIN_API_KEY` env var, or a labeled key
created from the Keys page (see below):

- **Calls** — live/completed calls, auto-refreshing, with a quick indicator of how many facts were
  captured per call
- **Call detail** — full transcript, tool-call log, recording link, the captured-state panel (see
  [State engine](./state-engine.md)), and a **latency breakdown** panel (STT connect, LLM
  time-to-first-token, TTS first byte — "not recorded" for fields that weren't captured, not a false
  `0ms`)
- **Do Not Call** — add/remove DNC entries without touching curl
- **Audit** — pull the compliance audit trail (who was called, when, under what consent, what was said)
  per call or per phone number, exportable as plain text or JSON
- **Agents** (`/dashboard/agents`, added 2026-07-10) — configure the agent "frame" per org+template:
  identity (name, greeting/closing line, tone), voice (provider + voice ID, with a live preview button),
  LLM (provider + model), which tools are enabled, and guardrail strictness (topic boundary, prompt-injection
  sensitivity, abuse handling). See `voice/agent-frame.ts` for the exact schema this reads/writes — the
  same shape a future "describe the agent you want" AI-builder flow would plug into.
- **Analytics** (`/dashboard/analytics`, added 2026-07-10) — org-scoped call volume, disposition breakdown,
  latency averages (STT/LLM/TTS), tool usage counts, and guardrail event counts over a date range.
  Aggregated directly off existing tables, no separate rollup/warehouse yet.
- **Keys** (`/dashboard/settings`) — generate labeled admin keys (shown once, copy button), see
  created/last-used timestamps, revoke individually — without rotating `ADMIN_API_KEY` for everyone

This is meant for you, the operator, not end users. It's not a full multi-tenant product login system,
but it's no longer just one shared secret either — see [`DECISIONS.md`](../DECISIONS.md) ADR-025 for the
labeled-key auth model.

The org picker on the Agents/Analytics pages is a plain client-side dropdown, not an access-scoping
mechanism — the one shared admin key sees every org's data, same as the rest of this dashboard. The
merchant-facing, per-org-scoped frontend (Supabase Auth, `/app/*`) has been live since 2026-07-12 — see
`CLAUDE-BUILD-BRIEF.md` §5/§9 for its scope and `MERCHANT-APP-PAGE-MAP.md` for the full page inventory.
