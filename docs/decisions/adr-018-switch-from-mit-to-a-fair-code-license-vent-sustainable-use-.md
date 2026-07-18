---
adr: 18
title: "Switch from MIT to a fair-code license (Vent Sustainable Use License)"
date: 2026-07-07
status: Accepted
---

## ADR-018 — Switch from MIT to a fair-code license (Vent Sustainable Use License)
**Date:** 2026-07-07

**Context:** ADR-015 already committed Vent to an open-core model — self-hosted core free forever, a paid
"Vent Cloud" layer later — explicitly citing n8n, Supabase, and PostHog as the comparable shape. Those
projects don't ship under plain MIT, though: n8n uses the Sustainable Use License, Supabase mixes Apache
2.0 with some fair-code-style components on premium pieces. Plain MIT (Vent's license until now) grants
anyone the right to fork, host, and resell the software as a competing managed service, royalty-free, with
no obligation back — which directly undercuts the future "Vent Cloud" paid layer ADR-015 already decided
to build. At zero external users and zero forks today, this is the cheapest point to fix it; once outside
contributors or forks exist, relicensing needs their consent and gets materially harder.

**Decision:** Replace the MIT `LICENSE` with the **Vent Sustainable Use License** (adapted from n8n's
Sustainable Use License v1.0): free to self-host, modify, and use for internal business or personal
purposes, forever, with source fully readable and verifiable — but not licensed for repackaging as a
competing hosted/managed commercial service without a separate commercial license from the licensor. No
`.ee`-style file-level split was introduced in this round (that's a bigger structural change to defer until
there's an actual premium-integration surface worth gating); the whole repo moved to the new license as one
change. `README.md`'s license section and `packages/openvent-compliance/package.json`'s license field were
updated to match.

**Consequences:** Anyone already relying on Vent under the old MIT terms before this commit keeps those
rights for the code as it existed then (MIT grants don't retroactively revoke), but all code from this
commit forward is fair-code licensed. No functional code changes. This is a licensing/positioning change
only, made now specifically because the project has no external contributors or forks yet to complicate
it.
