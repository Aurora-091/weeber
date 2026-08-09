# ADR-085: An outbound agent that cannot name who it called

- **Status:** Accepted
- **Date:** 2026-08-09
- **Relates to:** ADR-083, ADR-084 — same defect family: the failure was silent and every metric looked fine.

## Context

Three outbound insurance templates open by naming the person they called:

- `05-insurance-lead-followup-agent.md` — `Hi, is this {{lead_name}}? ... you'd recently shown interest in {{interest_area}}`
- `07-insurance-post-sale-welcome-agent.md` — `Hello, is this {{policyholder_name}}?`
- `09-insurance-final-expense-qualifier-agent.md` — `Hi, is this {{lead_name}}? ... you'd recently reached out about {{interest_area}}`

Nothing bound any of those tags. `greetingContext` was built from
`capturedState` plus `agent_name`/`merchant_name` only, and `capturedState` is
empty at greeting time on an outbound call — the fields it holds are the ones
the agent captures *during* the conversation.

So `renderTemplate` left the tags literal, the `/\{\{\w+\}\}/` guard in
stream.ts rejected the rendered line, and `literalGreetingText` stayed
undefined. Every outbound call on these templates fell back to the
LLM-generated greeting path.

That fallback is silent and it is not equivalent:

1. **The approved script's opener is never spoken.** The LLM improvises an
   opener from the persona instead. Whatever was reviewed and signed off on is
   not what the caller hears.
2. **It re-introduces the latency the feature exists to remove.** The literal
   greeting exists specifically to skip the LLM's ~1.2s time-to-first-token on
   pickup (2026-07-16 latency fix). The fallback pays it on every call, as dead
   air, immediately after the callee picks up.
3. **The LLM does not know the name either.** It was never given the lead row.
   So it either omits the name — dropping the "is this <name>?" identity
   confirmation that the whole script structure depends on — or it fills the
   slot from context and greets the callee by a name that is not theirs.

On a final-expense call to a bereaved or elderly callee, an agent that opens by
confidently using the wrong name is the worst available first three seconds.

The guard did its job — no caller ever heard the literal string
`{{lead_name}}`. That is also why this survived: the degradation was invisible,
and a call that fell back looked identical in the data to a call that did not.

## Decision

Add `getLeadGreetingContext(orgId, phone)` to the leads module and fold it into
the batch of lookups stream.ts already runs on pickup.

Design points:

- **The lead row is the right source.** It is the person-of-record, and it is
  keyed by exactly the two values known at greeting time — `orgId` and the
  carrier-reported phone number. Not from anything the model says.
- **Zero added latency.** It joins the existing `Promise.all` (caller memory,
  agent config, effective flags, org name) rather than becoming a fourth
  sequential await. Pickup-to-first-word is unchanged.
- **Returns a flat merge-tag context, not the lead row.** `fields` is the
  schema-validated intake blob, so its keys are already the intake schema's
  keys — safe to expose as tags. Blank and non-string values are dropped
  instead of binding empty tags.
- **One lookup serves every naming template.** A resolved name is exposed as
  `lead_name`, `policyholder_name` and `full_name`, so 05, 07 and 09 are all
  covered without three separate lookups or per-template plumbing.
- **A blank name is omitted entirely, not bound as `""`.** Binding it empty
  would satisfy the unresolved-tag guard and ship `"Hi, is this ?"` to a live
  caller. Omitting it keeps the guard's rejection, and the LLM fallback — bad,
  but not that.
- **Precedence: lead row < `capturedState` < agent identity.** A name the
  caller corrects mid-call wins over the pre-dial value on any later render, and
  a stale intake field never overrides one this call confirmed.
- **Best-effort.** A lookup failure is caught and returns `{}`, which lands on
  exactly the LLM fallback that was the unconditional behaviour before this
  existed. A leads-table problem cannot take out the call.

## Consequences

- Outbound 05/07/09 now speak their approved opener, with the real name, at
  literal-greeting latency.
- This is the first hot-path read of the leads table. It is one indexed
  single-row select on `(orgId, phone)` — the same key `upsertLead` dedups on —
  but it is now on the pickup critical path, so leads-table health is now call
  health.
- **The greeting is only as good as lead ingest.** If `leads.name` is null or
  the intake schema does not define `interest_area`, the tags still fail to
  resolve and the call still falls back. The fix moves the failure from "never
  possible" to "depends on ingest mapping" — a customer handing us a CSV whose
  column is `first_name` or `product_interest` gets the old behaviour. Field
  mapping per customer is a prerequisite for the greeting working, and it is not
  code.
- Four existing stream test suites mock `./leads/leads` and had to add the new
  export. Worth recording: those mocks are structural, not behavioural — they
  would have silently kept passing a broken import shape if the suites had not
  been run, since typecheck alone did not catch it.

## What this does not fix

- Templates outside 05/07/09 are untouched; no other template names its callee.
- Nothing here validates that the person who answered *is* the lead. The script
  asks "is this <name>?" for that reason, and the answer is a caller utterance
  the agent must act on — not something this lookup can assert.

## Tests

`packages/api/src/voice/leads/lead-greeting-context.test.ts` (7 tests): name
bound under all three tag names, intake fields exposed, blank name omitted so
the guard still rejects, blank/non-string field values dropped, lead name beats
a stale `full_name`, no query at all without org or phone, empty context when no
lead exists.

Full suite green at 1157 pass / 0 fail (1012 api + 74 web + 71 compliance).
