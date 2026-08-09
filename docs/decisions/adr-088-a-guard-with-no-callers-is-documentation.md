# ADR-088: A guard with no callers is documentation

- Status: Accepted
- Date: 2026-08-09
- Supersedes: none
- Amends: none
- Related: ADR-081 (regulated scope), ADR-087 (intake schema binding)

## Context

`findProhibitedCapture` existed in `insurance/closer-brief.ts` with 16 denied
keys and its own test file. It had **zero callers**. Nothing screened the
`captureField` write path. The denylist was a document that described an
intention, and the code did the opposite of it.

Two things made that worse than a missing feature.

**1. The tool's own description invited the exact capture the list forbids.**
`captureField`'s description offered `"account number"` as an example of a
durable fact worth recording, and its module doc-comment did too. A model given
a description that says "record account numbers" and a system prompt that says
"never collect account numbers" resolves the contradiction in whichever
direction the caller pushes it. Prompt-level contradictions are not neutral.

**2. The leak was not the state merge.** The obvious fix — refuse the merge into
`CallState` — would have stopped nothing that matters. `logToolCall` in
`stream.ts` persists the raw tool `input` to `tool_calls.input` **and** dispatches
it to the org's outbound webhook. An SSN spoken to `captureField` reached a
durable DB column and a third-party HTTP endpoint before anything looked at the
key. Any guard placed after that point is theatre.

Under ADR-081 the qualifying agent must not collect SSN, DOB, routing/account
numbers, or itemised health conditions — a licensed human does. That prohibition
had no enforcement in code.

## Decision

Extract the guard to `voice/prohibited-capture.ts` and screen in **two** places,
deliberately not one.

- `tools/captureField.ts` `execute` — returns `{ captured: false, refused }`.
  This layer exists to talk to *the model*: the refusal text tells it the field
  is not permitted and not to retry the same value under another key name.
  Without that, a model refused on `ssn` re-submits as `applicant_identifier`.
  This layer **cannot stop a write**.
- `stream.ts` `logToolCall` — screens the key, redacts the value via
  `redactCaptureValue`, and substitutes the redacted payload (`loggedInput`) into
  both the `toolCalls` insert and `dispatchWebhook`. This layer is what actually
  keeps the value out of the database and off the wire. It **cannot talk to the
  model**.

Neither is redundant. Removing either one loses a distinct property.

Refusals write a `guardrail_events` row: `category: "regulated-capture"`,
`source: "capture-guard"`, `detail: 'refused captureField key "<key>"'` — **the
key only, never the value**. Logging the value to prove we refused the value is
the same leak with better intentions.

The denylist also gained the identity and payment-instrument numbers it was
missing: `aadhaar`/`aadhar`, `passport`, `pan`, `iban`, `ifsc`, `cvv`,
`credit_card`, `debit_card`, and the three `driver_license` spellings.

### The two denylists stay separate

`PROHIBITED_CAPTURE_KEYS` (capture guard) and `REGULATED_FIELD_MARKERS`
(`leads/intake-schema.ts`) were not unioned. The markers include `health`,
`income`, and `bank`, which as substrings block `health_flag`, `income_type`,
and `banking_ready` — three of the nine permitted pre-qual fields the agent is
supposed to collect. Unioning them would have made the qualifying agent unable
to qualify. Only the non-colliding identity/instrument numbers were crossed
over.

The two lists answer different questions. Intake markers ask "may this key exist
in a lead schema at all?" The capture guard asks "may the model write this key
mid-call?" A field can be legitimate on an ingested lead and illegitimate for an
AI to solicit by voice.

### No migration

`guardrail_events.category` and `.source` are plain `text` columns with
TypeScript-level enums only — there is no DB check constraint — so widening them
to include `"regulated-capture"` / `"capture-guard"` required schema-file and
enum edits but no migration.

## Consequences

- The regulated-scope prohibition is now enforced at the write, not asserted in
  a prompt. It survives prompt edits, model swaps, and jailbreaks, because it is
  a string comparison and not an instruction.
- A refused capture is auditable: there is a `guardrail_events` row per attempt,
  which turns "did the AI ask for an SSN?" into a query.
- The model is told "no" rather than silently ignored, so it stops re-asking the
  caller — which is the difference between a compliant call and a call that
  sounds like a compliant system fighting its own agent.
- Cost: a key the schema legitimately needs and that happens to match a denied
  token gets refused with no override. Accepted — the guard fails closed, and
  matching is token-based rather than substring-based specifically so ordinary
  vocabulary (`reachable_time`, `expansion_plans`, `panel_preference`) does not
  collide. If a real field is ever blocked, the fix is to rename the field, not
  to weaken the list.
- Not decided here: whether a refusal should also be surfaced to the merchant in
  the call detail UI, and whether repeated refusals in one call should escalate
  (barge-in, supervisor flag, or hard stop). Today it is logged and the call
  continues.

## Verification

`bun test src/voice/prohibited-capture.test.ts` → 13 pass / 0 fail / 57
expect(). Coverage includes the regulated fields from the pilot script, the
newly-added identity keys, an assertion that **none of the nine permitted
pre-qual keys fire**, short-entry vocabulary collisions, blank/non-string input,
`redactCaptureValue` non-mutation, both `captureField.execute` branches, and the
description no longer advertising `"account number"`.

Full gate: `bun run typecheck` clean, `bun run lint` 0 warnings / 0 errors,
`bun run test` → 1198 pass / 0 fail (1053 api + 71 compliance + 74 web), up from
1185.
