---
adr: 8
title: "Public endpoint via a free Cloudflare quick-tunnel is a temporary stopgap, not a solution"
date: 2026-07-04
status: Accepted
---

## ADR-008 — Public endpoint via a free Cloudflare quick-tunnel is a temporary stopgap, not a solution
**Date:** 2026-07-04

**Context:** Discovered that this platform's own public preview URL doesn't pass through WebSocket upgrade
requests (`502` on any `Upgrade: websocket` header, confirmed even on plain routes) — a hard requirement
for Twilio Media Streams. A Cloudflare quick-tunnel (`cloudflared tunnel --url ...`, no account needed) was
stood up as a workaround, and it already dropped once mid-test (`"no recent network activity"` in tunnel
logs), independent of anything in the application code.

**Decision:** Use the quick-tunnel to unblock real-call testing in the short term, but explicitly document
it as unfit for anything beyond occasional manual testing — not a production access path.

**Consequences:** Any further live-call testing inherits this instability until resolved. Two real fixes
are on the table (recorded as an open decision, not yet made): (1) an authenticated Cloudflare named
tunnel (still free, requires a Cloudflare account + domain, far more stable), or (2) deploying the server
to a persistent host outside this sandbox with its own stable domain. This ADR exists so the tradeoff isn't
forgotten or mistaken for a solved problem in future work.
