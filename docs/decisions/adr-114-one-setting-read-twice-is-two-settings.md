# ADR-114 — One setting read twice is two settings

- **Date:** 2026-08-14
- **Status:** Accepted (implemented 2026-08-14; migration `0050` generated, **not applied**)

## Context

`transferToHuman` had exactly one destination: `orgs.human_transfer_number`, org-wide. One org, one
human, no matter which agent was on the call.

That is wrong for the launch vertical specifically, not just in the abstract. An org running the
insurance set has six agents seeded and they hand off to different people by nature: a policy-renewal
agent belongs with retention, a final-expense qualifier belongs with a **licensed producer** — ADR-081
permits the qualifier to do nothing else, since it may not quote, recommend, or bind. Org-level only
meant the qualifier's warm lead — the launch vertical's *only* conversion event — landed on whatever
line the org happened to set last. The same shape holds outside insurance: cart recovery and COD
confirmation are not the same desk.

Reading the code to add the column surfaced the more interesting problem. **The transfer number was
already being read twice, independently, by the two halves of one decision:**

1. `stream.ts:2462` resolved `orgTransferNumber` from the batched `orgs` select in the `"start"`
   handler, and fed it to `resolveTransferCapability` (does the model get the tool at all?) and to
   ADR-106's `allowedNumbers` provenance set (may the agent put this number in writing?).
2. `stream.ts:930` `resolveHumanTransferNumber(orgId)` did a **second**, separate `select *` from
   `orgs` mid-call, called from `performTransfer` at `:1051`. That one is what actually got dialled.

They agreed only because both read the same column at two moments of the same call. ADR-105 exists
because the tool-offering decision and the dial were allowed to disagree — the agent said *"You're
connected"* to nobody. Adding a per-agent column to read site 1 and not read site 2 would have
produced precisely that again, wearing a new coat: a merchant sets a per-agent number, the grid goes
green, the tool is offered, and the dial goes to the org number or nowhere. Correct code, wrong
caller — ADR-090's defect class, which this repo has now written eight ADRs about.

So the column is the smaller half of this change. The larger half is collapsing two reads into one.

## Decision

**`org_agent_configs.human_transfer_number`, nullable, agent-overrides-org — and one resolver, read
once per call, feeding both halves.**

- **Column shape follows the table.** `text`, nullable, no default, migration `0050` a single additive
  `ADD COLUMN`. Null means **inherit**, exactly like `phone_number_id`, `voice_id`,
  `tts_fallback_order` and every other override on `org_agent_configs`. A second null-semantics on one
  table is a table nobody can read.

- **The precedence lives in one pure function, `resolveTransferTarget({ agentNumber, orgNumber })` →
  `{ number, level: "agent" | "org" | "none" }`, in `voice/handoff.ts`** — not a new module.
  `handoff.ts` already owns `resolveTransferCapability`, and the entire point of this ADR is that
  capability and dial are **one** decision. Putting the resolver anywhere else would re-open the seam
  by file layout.

- **Blank-or-whitespace counts as absent at both levels.** Same rule `resolveTransferCapability`
  already applies, and the agent level is where it matters most: treating a stored empty string as
  present would let an accidentally-cleared field *shadow* a perfectly good org number and silently
  disable hand-off for that agent — a per-agent override that can only make things worse.

- **`resolveHumanTransferNumber` is deleted, not left as defence in depth.** `performTransfer` now
  consumes the `orgTransferNumber` closure value resolved at `"start"`. Defence in depth is right when
  two checks are two *different* checks (ADR-105 kept `performTransfer`'s own guards for that reason);
  here the second read was the same question asked twice of a mutable row, which is not redundancy, it
  is a race with a slow fuse. It also removes one mid-call `select *` from `orgs` on the transfer path.
  `handoff.test.ts` asserts against `stream.ts`'s **source text** that the split has not returned —
  the precedent ADR-105 set for a decision spread across two functions.

- **`AgentFrameSchema.humanTransferNumber` is `.nullable().optional()`, unlike its neighbours, and
  deliberately.** Drizzle omits `undefined` from the SET clause, so an override that was only ever
  optional could be **set and never cleared** — an agent stranded routing warm leads to a
  decommissioned line. `undefined` = leave alone, `null` = inherit the org number again, and the UI
  sends `null` for an empty field.

- **Validated with the shared `isValidE164`, not a new regex.** The org-level write path in
  `app/routes.ts` already uses it. Two spellings of "valid number" is how one surface starts accepting
  a value the dialler rejects.

- **ADR-111's readiness pill becomes per-agent.** `agentReadiness`'s third argument changed from
  `hasHumanTransferNumber: boolean` to the org's number itself, so each row resolves its own override.
  Without this, an agent carrying its own number renders **"Live · limited"** and sends the merchant to
  Settings to fix something that is not broken — the exact inverse of ADR-111's complaint, and a
  warning that is wrong is worse than no warning. The detail header classifies from
  `form.humanTransferNumber`, so typing a number clears the banner before you save.

- **`resolveAgentTransferNumber` in the web is a deliberate three-line duplicate**, not an import: the
  one-way dependency rule allows `web → api` for **types only**, and this is runtime logic. Both sides
  carry table-driven tests of the same precedence, and the web test says in its docstring that it is a
  mirror. A shared runtime module here means shipping server code to the browser.

- **The field sits on the agent's Tools & Guardrails tab, with the ability that uses it** — and renders
  even when `transferToHuman` is switched off, with a line saying so. The field a merchant is about to
  need should be visible before they need it. The line under it states what will happen on the next
  call in all three states, including the ADR-105 state: *"No number set here or in Settings — this
  agent will not be able to transfer, so it is never told it can."*

- **The admin twin in `dashboard/agents.tsx` gets the field too.** Support fixes a mis-routed hand-off
  from that page, and a field present on only one of two editors is a field the other one clears on its
  next save.

## Rejected

- **Agent number as a *fallback* under the org number.** Inverts every other override on the table, and
  makes the per-agent field useless for the case that motivated it — the org number is always set on a
  configured org, so the agent value would never win.
- **Keeping `resolveHumanTransferNumber` as a second lookup and giving it the agent value too.** Two
  correct copies today, one correct copy after the next change. This is the ADR.
- **A new `agent_transfer_targets` table** (multiple destinations, ring order, hours). Every one of
  those is a real feature and none is asked for; a table is expensive to un-ship and one nullable column
  is not.
- **Backfilling the column from `orgs.human_transfer_number`.** Copying the inherited value into every
  row makes "inherit" unrepresentable the moment the org number changes. ADR-112's reasoning, again.
- **Renaming the `orgTransferNumber` variable to match its widened meaning.** It is named in ADR-106's
  text and at three provenance call sites; per ADR-078 the correction goes in the doc comment, not in a
  rename that makes the record unsearchable.
- **Widening any ratchet.** Nothing widened; all six green.

## Consequences

api tests **1354 → 1363** (9 added), web **95 → 101** (6 added). Non-vacuity proven both sides:
inverting the precedence in `resolveTransferTarget` fails exactly one test (*"an agent-level number
overrides the org number"*, 28/1); reverting `agentReadiness` to read the org value alone fails exactly
one (*"an agent with its own transfer number is fully live on an org that has none"*, 24/1).

Also cleaned: four doc comments across `tools/transferToHuman.ts`, `voice/routes.ts`, `app/routes.ts`
and `web/components/app/user-shell.tsx` pointed at `resolveHumanTransferNumber`, which no longer
exists. The occurrences in ADR-105 and in the 2026-08 changelog are left **untouched** — per ADR-078
those are the record of what was true then, and this entry is the correction.

**Known and unfixed:**

- **Migration `0050` is generated and applied nowhere.** Against the real DB, saving an agent config
  would fail on the missing column until it runs. Same state ADR-112's `0049` is in — two unapplied
  additive migrations are now queued.
- **Nothing in onboarding asks for a transfer number, at either level.** ADR-111 made the gap visible
  and said so; this makes it fixable per-agent and still does not make it stop happening. A fresh org
  is still an org whose agents cannot hand off.
- **`insurance_advisors` is still empty (ADR-098)**, so the licensed-producer destination this ADR is
  largely motivated by has to be typed in by hand as a phone number. The column and the advisor roster
  are two answers to one question and are not connected.
- **`resolveTransferCapability`'s `provider-unsupported` reason is still invisible in the UI** — an
  Exotel org with a per-agent number set renders **Live** and still cannot transfer. ADR-111 flagged
  it; per-agent numbers make it slightly likelier to be hit, not less.
- The `console.log` announcing an agent-level target has no call-record equivalent, so "which level did
  this call transfer at?" is answerable from logs only.
