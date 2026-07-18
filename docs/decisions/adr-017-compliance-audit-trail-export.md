---
adr: 17
title: "Compliance audit-trail export"
date: 2026-07-06
status: Accepted
---

## ADR-017 — Compliance audit-trail export
**Date:** 2026-07-06

**Context:** Direct, repeated community feedback (see `reddit-feedback.md`, not committed, and
`docs/strategy-2026-07.md`) identified a concrete gap: Vent enforces compliance (DNC, calling-window,
recording/AI disclosure) but never packaged what it enforces into something an operator could hand to a
lawyer or compliance officer on demand. Direct quote from feedback: "the thing that actually kills the
compliance fear isn't more warnings, it's being able to show who called whom, with what consent, and what
the agent said." All of that data already existed (`calls`, `transcripts`, `doNotCall` tables) — it just
required manual reconstruction across multiple tables, which is exactly the wrong thing to be doing under
the pressure of an actual regulatory inquiry.

**Decision:** Add an audit-trail module to `@openvent/compliance` (`audit-trail.ts`), following the package's
existing storage-adapter pattern (`CallAuditStorageAdapter`, sibling to `DncStorageAdapter`/
`CallLogStorageAdapter`) so it stays framework-agnostic and adoptable outside Vent's own app. It assembles,
per call: direction, numbers, timing, status, disposition, current DNC status (checked at export time, not
call time, since a number can be DNC'd after a call happened), full transcript, and — the one piece that
required real judgment — whether the recording/AI disclosure was *actually spoken*, not just configured
on. That check does a conservative substring match against the first agent transcript turn; a false
"not confirmed" is the safe failure direction (prompts a human to double-check), a false "confirmed" would
not be.

Two entry points: `buildCallAuditRecord` (one call) and `buildPhoneNumberAuditTrail` (every call involving
a number — the more common real request). `renderAuditTrailText` formats either as plain text suitable for
handing to a lawyer as-is; JSON is available by serializing the records directly for programmatic/tooling
use. Wired into the app via a Drizzle adapter (`voice/compliance/adapters.ts`'s `callAuditAdapter`,
following the exact pattern of the existing `dncAdapter`/`callLogAdapter`) and two new admin-key-gated
routes: `GET /calls/:id/audit` and `GET /callers/:phoneNumber/audit`, both supporting `?format=text`.
Surfaced in the dashboard two ways: an "Export compliance audit" button on the call-detail page, and a new
dedicated `/dashboard/audit` page for the per-number lookup case.

**Consequences:** 10 new tests in `openvent-compliance` (25 total in that package, 74 across both packages),
typecheck/build/lint all clean, and the two new endpoints were regression-tested live against real call
data (401 without admin key, 404 for an unknown call id, 200 with an empty array for a number with no
calls, correct oldest-first ordering for multi-call lookups, correct disclosure-confirmed/not-confirmed
detection against real transcripts). This is the first concrete build item to come directly out of the
community feedback rounds (see `docs/strategy-2026-07.md`) — previously "in progress" items (integrations,
resilience layer) were already done; this was reprioritized ahead of the other candidates (per-call latency
breakdown, cross-call memory) because it was cheapest, most differentiated, and most directly requested.
Not done in this round: no PDF export (plain text was judged sufficient for "hand this to a lawyer" and
avoids a new dependency); no bulk/all-numbers export (per-number and per-call cover the realistic request
shapes identified in feedback).
