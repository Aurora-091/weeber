---
adr: 26
title: "Redis-backed session storage: optional, opt-in, async interface either way"
date: 2026-07-08
status: Accepted
---

## ADR-026 — Redis-backed session storage: optional, opt-in, async interface either way
**Date:** 2026-07-08

**Context:** `session-store.ts`'s own file header already documented the gap: "process-local state, fine
for single-instance, swap for Redis/DB-backed storage if you scale to multiple instances." The user left
the resourcing call to the agent, with one hard constraint: don't force a new required external
dependency on solo/small-team self-hosters who never need to scale past one instance.

**Decision:** `SessionStore` became an explicit interface (`get`/`set`/`update`/`delete`/`size`, all
async now — Redis I/O can't be synchronous, so the in-memory implementation moved to async too, even
though it doesn't need to be, purely so switching backends is a config change and never a call-site code
change). Two implementations: `MemorySessionStore` (today's exact `Map`-based logic, now behind the
interface, still the default) and `RedisSessionStore` (`ioredis`, one JSON-serialized key per call,
native `PX` TTL instead of the manual sweep interval, `update` reads the remaining TTL and preserves it
rather than resetting the full hour on every small patch like a `captureField` write mid-call). A factory
at module load picks the implementation based on whether `process.env.REDIS_URL` is set — unset, and
behavior is 100% identical to before this ADR, no new dependency actually exercised at runtime. Every
call site across `stream.ts`, `routes.ts`, and `workflows/scheduler.ts` (11 call sites total) needed an
`await` added — all were already inside `async` functions, so mechanically safe, but each one was
verified individually rather than assumed.

**Consequences:** New `ioredis` dependency (only imported/constructed when `REDIS_URL` is actually set).
Docs gained a "Scaling to multiple instances" section in `configuration.md` recommending Upstash's free
tier as the lowest-setup option for anyone who does need this, while being explicit that any
Redis-compatible service works — no vendor lock-in, it's a plain connection string. Verified two ways:
the existing `session-store.test.ts` suite (rewritten for the async interface, still exercises the
default in-memory path, all passing) and a real, temporary local Redis instance
(`apt install redis-server`, since none was otherwise available) — set/get/update-merge/update-preserves-
TTL/size/delete all confirmed working end to end against real Redis, not just inferred from reading the
code, then removed after verification.
