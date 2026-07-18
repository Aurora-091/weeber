---
adr: 37
title: "Phase 2 merged into Phase 1: one backlog, sequencing and gates preserved"
date: 2026-07-10
status: Accepted
---

## ADR-037 — Phase 2 merged into Phase 1: one backlog, sequencing and gates preserved

**Date:** 2026-07-10

**Context:** ADR-030 deliberately split the build into a narrow Phase 1 ("org-lite, one shared Twilio
number pool, no heavy multi-tenant — ship faster") and an explicitly deferred Phase 2. With Phase 1's
infrastructure workstreams now essentially done in one day (backend split, Postgres migration applied to a
live Mumbai project, Railway production deployed and verified end-to-end including the Twilio WebSocket
path, all provider keys armed, persona prompts written), the user asked whether Phase 2 should fold into
Phase 1. Presented options: selective merge (cheap correctness items + per-org caller ID, ~2 weeks) vs.
full merge (~2-3 months of backend surface) vs. keep the split. **User chose full merge.**

**Decision:** There is no Phase 2. All former Phase-2 items are Phase-1 workstreams (WEEBER-PLAN.md
J through S): checkout-token cancellation matching, order-value attribution, org-scoped GDPR erasure,
gdpr-redact-notify wiring, per-org outbound caller ID, per-tenant Twilio sub-accounts/BYO provisioning,
per-org DNC lists, full RBAC/multi-seat, per-org CRM connections (Nango), and entry-condition branching.

What the merge does **not** change:

1. **Sequencing intelligence survives.** Cheap/correctness items (J-N) are unblocked and parallel-friendly;
   heavy multi-tenant items (O, P, Q) still build on their prerequisites (N's number seam, the India
   compliance model, frontend-round auth). Merging the backlog is not permission to build sub-accounts
   before a single merchant exists — it means nothing is "out of scope," not that everything is first.
2. **The gates survive.** Anything touching `packages/openvent-compliance` (P, and I's enforcement half)
   still requires user confirmation before merging (CLAUDE.md gate #6). The trigger-split
   config-vs-canvas question (S) is still an explicit ask-first decision (gate #4).
3. **Backend-before-frontend survives** (explicit user direction from this same session): E (Vercel
   deploy) and Q (RBAC on Supabase Auth) sit in the frontend round.

**Consequences:** CLAUDE.md's STOP-AND-ASK item #8 (which said per-org sub-accounts / per-org DNC / RBAC /
per-org billing are "explicitly deferred — a task requiring one is a signal to check scope") is rewritten:
these are now in scope, and the signal to check is *sequencing* (dependencies above), not scope. The
"Org-lite, not full multi-tenant" architecture note remains accurate as a description of what exists today;
it stops being accurate as a boundary on what gets built.
