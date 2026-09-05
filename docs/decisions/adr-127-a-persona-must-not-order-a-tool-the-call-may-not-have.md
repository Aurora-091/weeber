---
adr: 127
title: "A persona must not order a tool the call may not have"
date: 2026-09-05
status: Accepted
---

## ADR-127 — A persona must not order a tool the call may not have
**Date:** 2026-09-05
**Status:** Accepted
**Relates to:** ADR-064 (non-registration), ADR-105 / ADR-115 (transfer prompt vs tool),
ADR-122 (`crmSync` withheld without credentials), ADR-124 (empty hangUp)

**Context:** Pipeline fixes (ADR-122–126) were real. The 2026-09-05 founder calls also
failed because of **what the model was told to do**:

- Insurance runtime regions still named `crmSync` after ADR-122 removed the tool
  on orgs with no CRM. Call control was composed from the *saved* tool list, which
  still included `crmSync`, so the model kept ordering a sync every turn.
- Appointment-setter closings said **"You're connected"** — the exact ADR-105 lie —
  and ordered `transferToHuman` even when the org had no `humanTransferNumber`.
- Post-sale welcome had **no closing** for "documents never arrived", then
  "end the call — any branch." The model called `hangUp` with no spoken line;
  ADR-124 stopped the hearing apology, it did not give the agent something true
  to say.

ADR-115 already recomposed when transfer was blocked. It did not recompose when
`crmSync` was withheld. Two inputs, one prompt, same defect class.

**Decision:**

1. **Call control names `crmSync` only when `toolsEnabled` includes it.**
   Unspecified or absent → "there is no CRM logging tool." Do not treat
   `toolsEnabled === undefined` as "every tool including CRM" — credentials are
   a second gate.
2. **`narrowToolsForCrmAvailability` + recompose** on `"start"`, same seam as
   transfer: if there is no `crmSyncContext`, drop `crmSync` from the list the
   prompt is built from.
3. **HangUp requires speech.** Call control: never hangUp with no spoken words;
   if no scripted closing fits, speak one short honest sentence then hangUp.
4. **Seeded runtimes:** no `crmSync`; no "You're connected"; transfer is
   "if a transfer tool is on this call"; post-sale gains a documents-not-received
   closing. Maintainer tools tables may still mention `crmSync` (not seeded).

**Rejected:** leaving personas as "documentation of the happy path" and relying
on tool-schema descriptions. Production ignored those (ADR-115 measured it).
Raising the first-token timeout so a no-op `crmSync` can finish.

**Consequences:** demo orgs with no CRM and no transfer number get a prompt that
matches the request. Re-seed `agentTemplates` on deploy; an editor-pasted old
persona is unchanged until saved. Hindi/Hinglish documents-not-received closings
are new audited lines — change them only with `00-insurance-regulatory-reference.md`
if a regulator later cares; they are administrative, not coverage advice.
