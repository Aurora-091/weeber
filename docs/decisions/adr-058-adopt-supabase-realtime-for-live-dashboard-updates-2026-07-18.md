---
adr: 58
title: "Adopt Supabase Realtime for live dashboard updates, replacing polling (2026-07-18)"
date: 2026-07-18
status: Accepted
---

## ADR-058 — Adopt Supabase Realtime for live dashboard updates, replacing polling (2026-07-18)

**Context:** an infra-consolidation audit (`docs/product-strategy/infra-consolidation-audit-2026-07-18.md`)
asked whether any external vendor apps could be cancelled given Weeber already pays for Supabase Pro,
Vercel Pro, and Railway Pro. The stack turned out to already be tightly consolidated — but one paid
capability is sitting unused: **Supabase Realtime**. The dashboard today polls via React Query
`refetchInterval` on a 4-5s cadence across call-detail, calls-list, and workflow-runs — each poll is a
full round-trip regardless of whether anything actually changed.

**Decision:** adopt Supabase Realtime's `postgres_changes` subscriptions to push live updates for
call state (status, disposition, transcript rows arriving) and workflow-run progress, replacing the
fixed-interval polling on those three views. Concretely:
- Subscribe to `postgres_changes` on `calls` (filtered by `org_id`) for call-detail and calls-list —
  a status change or a new transcript row pushes to the client immediately instead of waiting up to
  5s for the next poll.
- Subscribe similarly on `workflow_runs` for the workflow-runs view.
- React Query stays as the fetch/cache layer — Realtime becomes the trigger that invalidates/updates
  the relevant query key, not a wholesale replacement of the data-fetching pattern already in place.

**Why now, why this:** three real reasons, not just "because it's available":
1. **UX** — a merchant watching a call in progress currently sees state up to 5 seconds stale;
   push-based updates make it feel instant, which matters most exactly when someone is staring at
   the screen during a live call (the situation that actually drives perceived product quality).
2. **DB load** — polling three views every 4-5s per active dashboard session adds up under any real
   concurrent usage; Realtime only pushes on an actual row change, which is inherently far less
   traffic than fixed-interval polling regardless of whether anything changed.
3. **Demo value** — "watch the call happen live" is a stronger investor/grant-reviewer demo moment
   than a dashboard that visibly catches up every few seconds. Direct value for the credibility goal
   `AGENTS.md`/the pricing-lock doc are both already being built toward.

**Consequence:** this is a **decision, not yet an implementation** — no code has shipped for this
ADR. Scope for whoever picks this up next:
- Enable Realtime on the `calls` and `workflow_runs` tables in the Supabase project (off by default
  per-table).
- Add the client-side subscription (`@supabase/supabase-js`'s `channel().on('postgres_changes', ...)`)
  scoped by `org_id` — mirroring the existing RLS/org-scoping discipline already used elsewhere in
  this codebase, not a new auth pattern.
- Decide the fallback story if a Realtime connection drops mid-session — likely: keep the existing
  `refetchInterval` polling as a slower background safety net (e.g. 30s instead of 4-5s) rather than
  removing it outright, so a dropped websocket degrades gracefully instead of going silent.
- No other view needs this yet (calls-list/call-detail/workflow-runs are the only three identified
  polling loops in the audit) — don't preemptively wire Realtime elsewhere.

Not touched by this ADR: `pg_cron`/`pgmq` (only relevant once sweeps move off in-process
`setInterval`, i.e. the 2+ replica point — not now) and Supabase Vault (only relevant if/when
merchants BYO their own provider keys) — both noted in the audit doc as later, separate
considerations, not part of this decision.
