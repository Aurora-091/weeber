---
adr: 56
title: "Correction: the '38 pre-existing test failures' baseline cited across many prior sessions was a false signal, not real bugs (2026-07-16)"
date: 2026-07-16
status: Correction
---

## ADR-056 — Correction: the "38 pre-existing test failures" baseline cited across many prior sessions was a false signal, not real bugs (2026-07-16)

**Context:** asked to investigate/fix the "38 pre-existing failures" that `changelog.md` and several
docs (`docs/hindi-hinglish-voice-support.md`, `docs/workflow-canvas-v2-and-multivoice-research.md`)
had repeatedly cited as an accepted, unchanging baseline across many separate work sessions (e.g. "296
pass / 38 fail", "305 pass / 38 fail (same pre-existing baseline, no new failures)").

**Finding:** there were never 38 real failing tests. `packages/api/package.json`'s actual `test` script
is `bun test --isolate src/` — the `--isolate` flag runs each test file in its own module registry.
Every prior session's verification step ran bare `bun test` (no `--isolate`) instead of `bun run test`,
which shares one module registry across all 58 test files in a single process. That let module-level
mocks (`global.fetch` overrides in `salesforce.test.ts`/`hubspot.test.ts`/`google-calendar.test.ts`/
`gohighlevel.test.ts`/`shopify/routes.test.ts`, plus other module-scope state in
`resilient-fetch.ts`'s circuit breaker, LLM-provider resolution, and Twilio-signature org resolution)
leak across files depending on run order — every one of those individual test files passes cleanly
in isolation. Confirmed directly: `bun run test` → **353 pass / 0 fail** (not 305/38 or any of the
smaller historical counts); bare `bun test` on the same unchanged code → 38 failures, all in files that
mutate `global.fetch` or module-level singletons without per-file isolation.

**Decision:** the real, current baseline is **353 pass / 0 fail**, via `bun run test` (not bare
`bun test`). No source or test code changed — this was purely a verification-command mistake repeated
across sessions, not a real regression or flaky-test problem. Every historical "38 fail (same
baseline)" note in `changelog.md`/the two docs above should be read as "the verification command used
was wrong," not "38 tests were actually broken the whole time."

**Consequence:** always verify with `bun run test` (reads the package script, includes `--isolate`)
going forward, never bare `bun test` in this repo. Nothing else to fix or ship from this — flagging so
future sessions don't keep re-citing a phantom 38-failure baseline as if it were real or acceptable.
