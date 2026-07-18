---
adr: 27
title: "Docs/landing-page sync after the four-item round"
date: 2026-07-08
status: Accepted
---

## ADR-027 — Docs/landing-page sync after the four-item round
**Date:** 2026-07-08

**Context:** ADR-022, ADR-023, ADR-025, and ADR-026 each shipped code + tests, but the public-facing surface
(landing page roadmap/shipped sections, `README.md`, `docs/*.md`, `.env.example`) still described the
pre-round state — stale "known limitations" bullets claiming in-memory-only session state and a single
shared admin key, `docs/state-engine.md` silent on cross-call memory, `.env.example` missing both
`ADMIN_API_KEY` and `REDIS_URL` entirely. Landing copy said "rolling per-phone-number history," which
overstates what ADR-023 actually built (a merged flat key/value overlay, not a call-by-call log) — fixed to
match.

**Decision:** No code changes. Docs-only round:
- `packages/web/src/web/components/landing/roadmap.tsx` — moved all four items from `next[]` into `done[]`,
  replaced `next[]` with the three items actually still open (hosted DNC/SAN, telephony abstraction, npm
  publish), corrected the cross-call-memory wording.
- `packages/web/src/web/components/landing/shipped.tsx` — added two new cards (latency + cross-call
  memory; multi-user keys + Redis sessions) so the highlighted "Shipped Since Launch" section isn't missing
  the newest work.
- `docs/api-reference.md` — added the three new endpoints (`/calls/:id/latency`, `/calls/:id/audit`,
  `/admin-keys` CRUD) that existed in code but not in the reference table.
- `docs/dashboard.md` — documented the Latency panel, Audit page, and Keys page.
- `docs/state-engine.md` — new "Cross-call memory" section describing `callerMemory`, the merge behavior,
  and the inbound/outbound human-number resolution, cross-referenced to ADR-023.
- `.env.example` — added `ADMIN_API_KEY` (legacy bootstrap path) and `REDIS_URL` (optional, opt-in) with
  inline comments matching their actual runtime behavior.
- `README.md` — fixed the two stale "Known limitations" bullets, added feature bullets for the four shipped
  items, updated the Live link from the old preview URL to `openvent.dev`.
- `ROADMAP.md` — removed two now-stale "Later" bullets (multi-tenant dashboard auth, Redis/DB session
  storage) that the four-item round already shipped; replaced with a narrower "full multi-tenant
  accounts" item reflecting what's actually still open beyond labeled admin keys.

**Consequences:** Verified via `tsc -b --force` (clean), `bun run build` (clean), 55/55 web tests, 25/25
`@openvent/compliance` tests — no code paths touched, so this is a low-risk documentation commit riding on
top of already-verified ADR-022/023/025/026 code.
