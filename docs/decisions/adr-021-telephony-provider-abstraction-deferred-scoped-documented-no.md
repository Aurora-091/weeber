---
adr: 21
title: "Telephony provider abstraction: deferred, scoped, documented (no code this round)"
date: 2026-07-08
status: Accepted
---

## ADR-021 — Telephony provider abstraction: deferred, scoped, documented (no code this round)
**Date:** 2026-07-08

**Context:** Starting a round of work on four roadmap items (per-call latency breakdown, cross-call
memory, multi-user dashboard auth, Redis session storage), the question of "shouldn't OpenVent not be
Twilio-specific" came up. Worth deciding deliberately rather than either ignoring it or scope-creeping
this round into a telephony rewrite. Concrete coupling points found during exploration, so this is a
scoped decision, not a vague aspiration:

- `packages/web/src/api/database/schema.ts` — `calls.twilioCallSid` bakes Twilio's naming into the
  schema itself, not just an implementation detail.
- `packages/web/src/api/voice/routes.ts` — `/incoming`, `/status-callback`, `/recording-status` are
  shaped exactly like Twilio's webhook contract; outbound calling goes through `twilioClient.calls.create()`
  directly, no intermediate interface.
- `packages/web/src/api/voice/middleware/twilio-signature.ts` — signature validation is Twilio-specific
  by construction (Twilio's own HMAC scheme).
- `packages/web/src/api/voice/stream.ts` — the per-call WebSocket state machine assumes Twilio Media
  Stream's exact event shape (base64 mu-law frames, `start`/`media`/`stop` events) with no abstraction
  layer between "a phone call is happening" and "Twilio specifically is happening."

**Decision:** Not touched this round. The four roadmap items below don't require it, and doing it
properly (a `TelephonyProvider` interface, renaming `twilioCallSid` → a generic `providerCallId`,
abstracting the Media Stream event shape) is its own significant, separate piece of work that deserves
its own dedicated round rather than being bolted on as a side effect of unrelated work. Recording this
now so the eventual work has a concrete starting list instead of starting from scratch.

**Consequences:** No code changes. `ROADMAP.md`'s "Later" section updated to reference this ADR instead
of a bare one-line mention, so the next person (or the next round) picking this up has the actual
coupling points to work from.
