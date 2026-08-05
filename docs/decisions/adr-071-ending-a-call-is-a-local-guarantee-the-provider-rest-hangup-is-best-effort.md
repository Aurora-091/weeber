# ADR-071: Ending a call is a local guarantee; the provider REST hangup is best-effort

- **Date:** 2026-08-05
- **Status:** Accepted
- **Supersedes / relates to:** ADR-042 (voice pipeline seams), ADR-048 (Plivo/Exotel BYO credential layer)

## Context

Reported defect: **the call is not ending.** The agent says goodbye and the caller stays on a live,
silent line until they hang up themselves or the `maxDurationSeconds` cap fires.

Ending an agent call is a three-step sequence in `voice/stream.ts`'s `performHangUp`:

1. tell the telephony provider to end the PSTN leg (Twilio `calls(sid).update({ status: "completed" })`,
   Plivo `hangupPlivoCall`),
2. close the media WebSocket,
3. `finalizeCall("completed")` — persist status, close STT/TTS, stop the silence timer.

Only **step 2** is under our own control, and step 2 is on its own sufficient: with a
`<Connect><Stream>` answer TwiML, Twilio runs the remaining TwiML verbs once our server closes the
socket, and `/incoming` emits no verb after `<Connect>` — so the call ends. Steps 1 and 3 are a faster
teardown and a correct call record respectively.

The code had them in the wrong dependency order. Step 1 was written as a single expression:

```ts
await (await getTwilioClientForOrg(humanNumberOrgId))
  .calls(callSid)
  .update({ status: "completed" })
  .catch((err) => console.error(...));
```

The `.catch` covers `update()` only. `getTwilioClientForOrg` is outside it, and it does a DB read, a
credential-vault read, and then `Twilio(accountSid, authToken)` — which **throws** on a malformed SID.
That is not hypothetical: `twilio-provisioning.ts`'s `getSubClientEnsuring` documents the
half-provisioned state where an org has a sub-account SID stored but no readable auth token. In that
state the *entire* `performHangUp` rejected, so steps 2 and 3 never ran. The rejection surfaced from
the STT handler's catch as a generic `[voice] error handling transcript event` — a log line that names
neither hangups nor Twilio.

Three further ways the same guarantee was lost:

- **`logToolCall` gated the intent on the reason.** It registered a hangup only when the tool input
  literally contained a `reason` key. `reason` is required on the schema, but a model can emit `{}`,
  and an SDK can hand back arguments that never parsed into an object. The intent was then discarded
  in silence: the caller heard the goodbye line the same turn produced, and then nothing.
- **A failed transfer redirect still reported success.** `performTransfer` fell through to
  `finalizeCall("transferred")` regardless of whether the redirect worked. Finalize closes STT/TTS and
  clears the silence timer, while `performTransfer` deliberately leaves the WebSocket open (the call is
  meant to continue on the `<Dial>`). A failed redirect therefore produced a **zombie leg**: live call,
  no agent listening, no timer left to end it, and a call record claiming a transfer that never happened.
- **The browser test call ignored both tools entirely.** `test-call-stream.ts`'s `onToolCall` captioned
  `[tool: hangUp]` into the transcript and did nothing else. `buildVoiceTools` always re-adds `hangUp`
  (`new Set([...enabledTools, "hangUp"])`), so every preview agent has it and uses it — and the preview
  call then kept the mic open and kept billing STT/LLM/TTS to the 5-minute cap. This is the surface a
  merchant tests first.

## Decision

**Closing the WebSocket is the authoritative end of a call. Everything a provider does is best-effort
and may never pre-empt it.**

1. The provider hangup moves into `endProviderCallLeg()`, which **cannot throw** — client construction
   is inside the `try`, and an outer `try/catch` covers the whole provider dispatch. `performHangUp`
   always reaches `ws.close()` and `finalizeCall()`.
2. The Twilio REST hangup gets **one retry**, then logs loudly with the attributed org. Its most likely
   failure is not transient: an unattributed call resolves to the *parent* platform client while the
   call lives in an org **sub-account**, so `calls(sid).update()` 404s. That needs to be diagnosable,
   not swallowed.
3. **Call-control intent is registered on the tool NAME alone.** A missing or unparseable `reason` costs
   a log line, never the hangup. `voice/call-control.ts`'s `toolCallReason()` is the one place that
   coerces a reason, shared by `stream.ts` and `test-call-stream.ts`.
4. **A failed transfer hangs up.** No `finalizeCall("transferred")` unless a redirect actually
   succeeded — same honest outcome as the existing "no transfer number configured anywhere" branch.
5. **The test call honours both call-control tools**, waiting (bounded) for the closing line before it
   closes the socket. A transfer is *reported*, not simulated: there is no PSTN leg to redirect in a
   browser call.

## Consequences

- A hangup now has one failure mode left — our own process dying — instead of four.
- A caller may hear up to ~250 ms more of silence when the first Twilio REST call fails, in exchange for
  a retry on the one API call that ends the PSTN leg.
- Twilio hangup failures become loud and attributable, which is how the parent-vs-sub-account 404 will
  be caught in Railway logs once real calls run.
- `finalizeCall("transferred")` becomes a trustworthy signal for reporting: it now means a redirect the
  provider accepted, not an attempt.
- Preview/test calls stop billing past the end of the conversation.
- Not addressed here: whether interim STT transcripts can keep re-arming the silence timer so it never
  fires. That is a separate defect if it exists, and the hangup path is now sound either way.

## Alternatives rejected

- **Keep the REST call as the primary mechanism and add a health check after it.** Adds a round trip to
  learn something the WebSocket close already guarantees.
- **Make `reason` optional on the tool schemas.** The prompt genuinely wants the model to state a
  reason; the fix is to stop letting a diagnostic field control the outcome, not to stop asking for it.
- **Let a failed transfer keep the call alive with the agent still attached.** Would mean unwinding
  `finalizeCall`'s STT/TTS teardown mid-call, a much larger change, to preserve a call the caller was
  just told was being handed off.
