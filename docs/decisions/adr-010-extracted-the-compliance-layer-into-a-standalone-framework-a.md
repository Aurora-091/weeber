---
adr: 10
title: "Extracted the compliance layer into a standalone, framework-agnostic package"
date: 2026-07-05
status: Accepted
---

## ADR-010 — Extracted the compliance layer into a standalone, framework-agnostic package
**Date:** 2026-07-05

**Context:** Following ADR-009's decision to keep Vent's direct pipeline instead of adopting an
orchestration framework, the identified leverage — automatic compliance that no competitor (hosted
platform or open-source framework) ships out of the box — needed to become concrete rather than aspirational.
Vent's compliance modules (`calling-window`, `dnc`, `consent`, `hipaa`, `gdpr`) were originally written
directly against Vent's own Drizzle/Turso schema, which meant they could only ever be "a compliance layer
inside one app," not something another developer — on any telephony stack or orchestration framework —
could adopt independently.

**Decision:** Extract all five compliance modules into a new workspace package, `packages/openvent-compliance`
(published as `@openvent/compliance`), with zero dependency on Twilio, Bun/Hono, or any specific database.
Storage-backed modules (`dnc`, `gdpr`) now accept a small adapter interface (`DncStorageAdapter`,
`CallLogStorageAdapter`) instead of importing Vent's `db` directly; in-memory reference adapters ship in
the package for quick starts and tests. Vent's own app was then refactored to consume the extracted
package via a thin Drizzle adapter (`packages/web/src/api/voice/compliance/adapters.ts`) — proving the
extraction works standalone by dogfooding it in the real, working app rather than leaving it untested.

**Consequences:** The package was verified with 13 unit tests covering every module using only the
in-memory adapters (no Vent-specific code touched), and the app's existing compliance behavior (DNC block,
calling-window enforcement, GDPR erasure, health-check reporting) was regression-tested via the same curl
checks used in prior sessions — all passed identically after the swap. This is the first concrete step of
the "library → framework" roadmap: the compliance layer is now something a Pipecat, LiveKit, or entirely
custom voice pipeline could adopt without adopting Vent itself. Packaging for public npm distribution
(making this installable outside this monorepo) remains a separate, not-yet-executed step.
