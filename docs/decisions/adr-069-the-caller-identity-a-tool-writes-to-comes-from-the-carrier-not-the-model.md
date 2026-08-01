---
doc: decision
id: ADR-069
status: accepted
date: 2026-08-01
supersedes: —
related: ADR-064, ADR-065, ADR-066
---

# ADR-069 — The caller identity a tool writes to comes from the carrier, not the model

## Context

ADR-066 states the rule: *a tool that acts on a real-world entity is bound to that entity
server-side.* G1.1/G1.3 applied it to `offerCartRecoveryDiscount` (the discount percentage) and
`confirmCodOrder` (the shop and order ID). A follow-up audit of the remaining tools found one that
still violated it, and it is the tool every seeded template enables.

`crmSync` declared `phoneNumber: z.string()` as a **required, model-authored input**
(`packages/api/src/voice/tools/crmSync.ts:15`, pre-change), and that same value is the **upsert
key**. `syncToGoHighLevel` POSTs `{ phone: phoneNumber }` to LeadConnector's `/contacts/upsert`
(`packages/api/src/voice/integrations/gohighlevel.ts:23-32`); the Salesforce and HubSpot adapters
match the same way.

Upsert is what makes this dangerous rather than merely wrong. A bad phone number does not error. It
either matches a **different existing contact** — and this call's notes are appended to that
person's timeline — or matches nothing and creates a junk contact. Either way the failure is silent,
and neither the merchant nor the caller has any signal that it happened. There is no post-hoc
detection: a note on the wrong contact looks exactly like a note on the right one.

Three routes to a wrong number, none of them exotic:

1. **Hallucination.** Nothing in the prompt reliably carried the caller's number. The personas
   referenced it as a merge tag and, per ADR-065, nothing rendered persona merge tags. So on most
   calls the model's only route to filling a *required* string field was to invent a plausible one.
2. **Mistranscription.** When the caller does read a number aloud, STT digit errors are routine —
   more so over Indian PSTN with accented Hinglish digits, which is the pilot's primary channel. One
   wrong digit is a different contact.
3. **Injection.** A caller can say "log this under +1555…" and the model has no reason to refuse; the
   field was documented as the model's to fill. `voice/injection-detection.ts` is log-only, so
   nothing intervenes.

Meanwhile the correct number is already known server-side, before the first turn. The `"start"`
handler computes `resolveHumanNumber(row.direction, row.fromNumber, row.toNumber)` from the
telephony provider's own call record (`packages/api/src/voice/stream.ts:1561`) and cross-call memory
(ADR-023) has trusted it since it shipped. The carrier knows who is on the line. The model does not.

A second problem fell out of the same shape. Because `crmSync` was a plain entry in the static
`voiceTools` map, it was registered on **every** path into the agent — including the text test-chat
(`app/routes.ts`, `voice/routes.ts`), the synthetic AI-to-AI harness, and the preview drawer. None of
those has a real human on a real number, and all three could write live contact records into a
merchant's production CRM from what the user believes is a test.

## Decision

`crmSync` becomes a server-bound factory, identical in contract to `confirmCodOrder`.

- `CrmSyncContext = { orgId, phoneNumber }` is built once per call by `resolveCrmSyncContext` from
  `humanNumberOrgId` + `humanNumber` — the values `stream.ts` already derives from the provider's
  call record — and then fixed for the life of the call. The identity of the record being written
  must not shift mid-conversation, for the same reason the authorized discount must not.
- The model's input schema narrows to `{ callerName?, notes }` — the two fields it genuinely is the
  author of. `phoneNumber` is gone from the schema entirely, so a model that emits it anyway (having
  been steered by a caller, or trained on the old shape) has no effect.
- **The gate is non-registration, not validation.** `resolveCrmSyncContext` returns `undefined` when
  there is no org or no resolvable human number, and `buildVoiceTools` then omits the tool from that
  call's tool set. A tool absent from the request cannot be called with a guessed argument, however
  the persona drifts or the model is jailbroken.
- `crmSync` is removed from the static `voiceTools` map. It joins `lookupInfo`,
  `offerCartRecoveryDiscount` and `confirmCodOrder` as per-call-only.
- `resolveCrmSyncContext` also rejects placeholders (`""`, `"unknown"`, `"anonymous"`, `"+"`) that a
  provider may send when caller ID is withheld. The shape check is deliberately loose — digits, an
  optional leading `+`, 7–15 digits — because this is a "did we get a number at all" guard, not
  number validation. The number's authority comes from being the carrier's, not from passing a regex.

Listing `crmSync` in an agent's `toolsEnabled` remains necessary but is **not sufficient**. This
matters more here than for the previous two tools: all six seeded templates list `crmSync` in
`defaultTools`, so before this change the merchant-facing config was the only gate and it was on by
default everywhere.

## Consequences

**Intended, and a net improvement:** the text test-chat, the synthetic harness and the preview
drawer no longer get `crmSync` at all. A test run can no longer write into a merchant's live CRM.
This is the same trade already accepted for `offerCartRecoveryDiscount` (no live discount codes from
a test) and `confirmCodOrder` (no cancelled orders from a test).

**Calls with withheld caller ID lose CRM logging.** Previously they got a contact written under a
number the model invented, which was worse than nothing — it was wrong data presented as right. The
correct future fix is a lead/contact reference carried on the call, not a model-supplied string.

**Six seeded insurance personas (04–09) documented `crmSync({ phoneNumber, notes })` in their tool
tables.** Those markdown files *are* the system prompts (`seedAgentTemplates` reads
`docs/agent-prompts/`), so leaving them would have instructed the model in an argument the schema no
longer accepts — the exact class of defect `database/seed.test.ts` was written to catch. All five
occurrences updated to `crmSync({ notes })`.

**Not verified by a live call.** Like every G1 change, this is static reasoning plus isolated unit
tests. The specific thing a live call would confirm is that `humanNumber` is populated for the
telephony provider actually in use on that call (it is read from the `calls` row, which Exotel's
WS-only path inserts later than Twilio/Plivo do). If it is ever empty at `"start"`, the consequence
is a *missing* CRM write, not a wrong one — the failure mode is now safe by construction. Covered in
the G0.4 call-test protocol, step 7.

## Rejected alternatives

**Validate the model's number against the carrier's instead of replacing it.** Keeps a required
field the model has no legitimate source for, and turns every mismatch into a runtime error the model
then tries to recover from mid-call. If the server already knows the right answer, asking the model
for it and then checking is strictly worse than not asking.

**Keep `phoneNumber` optional, defaulting to the bound value.** The field stays in the JSON Schema,
so the model still sees it as something it may supply, and a supplied value still wins. That is the
current bug with an extra branch.

**Bind the number but keep the tool always registered, returning an error when unbound.** The model
would then be told a CRM logging capability exists and fail at it, on every anonymous call, mid-
conversation. Non-registration is quieter and cannot be argued with.

## Verification

- `bun run --cwd packages/api typecheck` → 0 errors
- `bun run --cwd packages/web typecheck` → 0 errors
- `cd packages/api && bun test --isolate src/` → **852 pass / 0 fail**, 2213 expects, 101 files
- `bunx oxlint packages/api packages/web --deny-warnings` → **0 warnings, 0 errors**, 414 files
- New tests: 7 in `voice/tools/crmSync.test.ts` (schema no longer exposes `phoneNumber`; a
  model-supplied `phoneNumber` is ignored in favour of the bound one; context resolution rejects
  missing org, missing number, and placeholders) and 6 in `voice/agent.test.ts` (registration gates,
  `toolsEnabled` alone is insufficient, absent from the static map).
