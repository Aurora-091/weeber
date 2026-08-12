# ADR-106: A number the agent was never given is a number it invented

- **Date:** 2026-08-12
- **Status:** Accepted (implemented 2026-08-12)
- **Supersedes / amends:** extends ADR-104's `output-guard.ts` from the spoken channel to the written one, and reverses that ADR's leading-only tone-tag anchor. Applies the hard-reject shape of the 2026-08-09 `captureField` screen to a second class of model-authored output. Same provenance argument as ADR-069/G1.4 (`crmSync`'s bound `phoneNumber`). Third finding cluster from production call 25, alongside ADR-105.

## Context

Three findings from the same call ADR-105 documents. That ADR was about a
promise the agent could not keep; this one is about what it wrote and said
while making it.

### It texted the caller a phone number that does not exist

Call 25 sent two SMS messages. Verbatim:

> "PersistentAds: Here's the advisor's number for your records:
> **[Advisor Desk Number]**. A licensed advisor will be with you shortly."

> "PersistentAds: Please contact your licensed advisor at **888-555-0199** for
> assistance with your final expense insurance options."

The first is an unresolved bracket placeholder — precisely the shape ADR-104
stopped from being *spoken*, delivered in writing instead, five hours after
that ADR shipped. The second is worse: `orgs.human_transfer_number` is NULL on
all four production orgs (ADR-105), `insurance_advisors` is empty (ADR-098), the
caller never said a number, and nothing in the prompt contained one. The model
had a slot to fill and no source, so it invented something that looked right.

A caller who keeps that message now has a wrong number attributed to the org,
in writing, in their message history, from an interaction they were told was
with an insurance provider.

Nothing screened either one. ADR-104 built a guard for exactly this class of
defect and pointed it at one channel — the token stream on its way to TTS. A
voice agent has a second way to put its own words in front of a person, and it
is the one that persists: `sendSms.body` goes to the caller's phone,
`crmSync.notes` lands on a contact timeline a salesperson reads,
`bookAppointment.notes` goes into a calendar invite.

### It read a stage direction out loud

The same turn was spoken as:

> "*Sending text message...* [[tone:upbeat]] And that's everything I need..."

Two defects in eleven characters of prefix.

The markdown is the model writing for a chat window in a channel that has no
screen. But the tone tag is ours, and this is the fifth defect in that one
feature after ADR-082, ADR-083 and ADR-101. `TONE_TAG_REGEX` was anchored to
`^`, with a comment stating the reasoning: *"a tone tag mid-sentence is never
valid, so this never risks stripping something that looks similar but isn't the
real marker."* Both halves of that are true. The conclusion was still wrong.
Mid-sentence tags are not valid — the model emits them anyway, and when it does,
the anchor's only effect is that the caller hears one.

The mechanism is exact. The stage direction ahead of the tag is 23 characters.
`TONE_TAG_MAX_BUFFER_CHARS` is 24. So the streaming filter accumulated,
correctly concluded "no leading tag is coming", released — and then forwarded
the tag as ordinary speech, because after resolution `push()` was a raw
pass-through to `onText`. The cap that ADR-101 added to stop the filter muting
short turns is what let this through, working exactly as designed.

### It talked about an outbound call as though the caller had rung in

The agent asked the caller which number to use and referred to "the line that
you reached out on". This was an outbound call the agent placed, to a number
the server already had, on a lead the workflow supplied. The caller answered
"You're gonna use the same number" — and that answer is what ran the phantom
post-latch turn ADR-105 fixes. A question the agent had no business asking
produced the reply that produced the duplicated hand-off.

`buildCallControlBlock` already branches on `direction` and already says "You
placed this call" in the outbound identity-check line. It stopped short of
saying the rest.

## Decision

**1. The output screen is reused on outbound tool arguments, and it refuses.**

New `voice/outbound-text-guard.ts` wraps `scrubSpokenText`'s finding set rather
than reimplementing it — a second copy of the tool-syntax and bracket-slot
patterns would drift the first time a new model family leaks a new envelope.
On top of it, one new finding: `unverified-phone-number`.

Where the spoken guard deletes and lets the sentence continue, this one
refuses. Deletion is right mid-utterance, where a half-spoken turn is worse
than a clipped one and there is no second chance. An SMS is a discrete atomic
act with a caller-visible result, and a scrubbed one — "Please contact your
licensed advisor at ." — reads as broken and still fails the caller. Not
sending is the honest outcome, and it leaves the finding in the logs where the
upstream defect can be fixed.

**2. A number's authority is where it came from, not what it looks like.**

There is no way to tell a hallucinated phone number from a real one by looking
at it; every check that tries — length, prefix, carrier lookup — validates the
shape of the invention. `888-555-0199` passes all three.

So the test is provenance. A number may appear in outbound text only if the
server put it in scope (`orgs.humanTransferNumber`, the leg this call is
connected to) or the caller said it themselves. `callerSpokenNumbers` is
harvested in `logTranscript` before its `dbCallId` early return, and read
through a closure rather than snapshotted, because a number the caller reads out
on turn six is a number the agent may repeat on turn seven — snapshotting would
refuse exactly the legitimate case.

Two calibrations, both against false refusals rather than false accepts,
because a wrongly-refused SMS is silent:

- **10 digits minimum**, not E.164's 7. This scan runs over free prose where
  7-9 digit runs are overwhelmingly order numbers, amounts and dates.
  `resolveCrmSyncContext` can use 7 because the carrier already vouched for
  that value; this cannot.
- **ISO date-times are removed before the scan**, and `dateTimeIso` is not a
  screened field at all. A date is the one non-phone thing in this product that
  reliably produces a long digit run.

Comparison is on the last 10 digits, so an org configuring `+1 888…` and a
model writing `(888)…` are one number — country-code variation is precisely the
difference this has to see through to avoid refusing the one number it *is*
allowed to write.

**3. Screened at the point where each side effect actually happens.**

`withOutboundTextGuard` wraps tool definitions inside `buildVoiceTools`, the
same shape as the existing `withFillerTimer` and for the same reason: it is the
one place every caller shares, so a tool cannot be added to the set and quietly
skip the screen. That covers `crmSync` and `bookAppointment`, whose `execute`
does the write.

`sendSms` is the exception, screened in `stream.ts` instead, because its
`execute` is signal-only — the send happens in `onToolCall` with the call's real
org and number in scope. Refusing inside the tool would refuse nothing and the
message would go out anyway. `outbound-text-guard.test.ts` asserts against
`stream.ts`'s source text that the screen still precedes the send, the same
blunt check ADR-105 uses for the same reason.

The refusal is returned to the model as a normal tool result, worded as an
instruction. A thrown tool error ends the step and the caller hears the fallback
line; a readable result tells the model what was wrong and lets it retry the
same call without the invention.

Refusals log a `guardrail_events` row: category `fabricated-outbound-text`,
source `outbound-text-guard`. Both columns are plain `text` with a TS-level
enum and no DB check constraint, so this is a type widening with no migration —
the same widening `capture-guard` made.

**4. The tone tag is stripped anywhere, and the filter never passes through raw.**

`stripToneTag` now removes every occurrence and reports the first recognized
tone. Position decides whether the *tone* is trustworthy; it does not decide
whether the *characters* may be spoken. The streaming filter's post-resolution
pass-through is gone: it now holds back only from a dangling `[` that could
still become a tag, bounded by the same 24-character cap — the identical shape
as `output-guard.ts`'s `speakableSplit`, for the identical reason (a tag
arrives as `[[to` + `ne:calm]]`, and forwarding the halves means neither is
recognizable and both are spoken). Text with no dangling bracket, which is
nearly every delta, is emitted with no added delay.

One subtlety worth the line of code: `lastIndexOf("[")` on `"[[to"` finds the
*second* bracket, so holding from there emits the first one as speech — the same
one-character leak the function exists to prevent. It backs up over the run.

**5. Markdown asterisks are deleted; the words inside them are not.**

`output-guard.ts` gains `markdown-syntax`. The asterisks go, on the same rule as
everything else in that module: a control character is never speech.

The words stay, and that is a deliberate, partial fix. This module's contract is
"delete syntax, never rewrite a sentence"; an emphasis span can legitimately
wrap a real word (`*really* important`), and the guard sees the stream in deltas
whose boundaries are not line boundaries, so there is no chunk-safe way to tell
a stage direction from emphasis. "Sending text message..." therefore still gets
spoken if the model emits it.

That half is fixed where it is caused — a call-control rule stating that
everything the model produces is spoken aloud, that markdown and bullets and
headings have no meaning here, and that it must never narrate its own actions
in the third person. Two partial layers, stated plainly, in preference to one
clever regex that eats a word every so often.

**6. The outbound identity line finishes its sentence.**

On outbound calls the model is now told the caller did not reach out, ring in,
or get in touch; that their number is the one that was dialled; and that it must
never ask which number to use or read a number back as though it was given. A
matching rule, direction-independent, forbids stating any phone number, email or
link it was not given — with the reason attached, because the reason is what
generalizes: *the caller will try it.*

## Measured

- Call 25 sent **2** SMS messages, **both** of which this screen refuses: one
  for `bracket-placeholder`, one for `unverified-phone-number`.
- The fabricated number `888-555-0199` passes every shape check and fails the
  provenance check. With `orgs.humanTransferNumber` populated to that number,
  the same message is allowed — the text was never the problem.
- Tone-tag leak reproduced deterministically: 23 characters of prefix, a
  24-character cap, tag spoken.
- api tests 1,241 → **1,278** (+37).
- No added latency in either guard: both hold back only from a dangling
  bracket, and the argument screen runs on tool calls, not on the token stream.

## Consequences

- **A refused `sendSms` is a message the caller expected and did not get**, on
  a turn where the agent already said "I'm sending that now". The agent is not
  told the send failed, so it cannot correct itself in the moment. This is the
  right trade against sending a wrong number, and it is not a complete
  behaviour: the honest next step is feeding the refusal back into the turn.
  Not in this ADR.
- Legitimate SMS content that happens to contain an unfamiliar 10-digit number
  will be refused. There is no allowlist mechanism for "this is a real number we
  just never told the server about" other than configuring it, which is the
  intended pressure.
- `crmSync`/`bookAppointment` refusals are visible to the model and can loop: it
  may retry with the same invented number. Bounded by the step limit, and each
  attempt logs a row, so the loop is diagnosable rather than silent.
- The `guardrail_events` widening means existing dashboard filters that
  enumerate categories will not show the new one until updated. Not checked.
- Nothing here fixes the `flagGuardrailEvent` false positives (6× and 4× on
  polite callers, ADR-103). Still open, still unfiled.

## Rejected

- **Scrub the SMS and send it anyway.** Consistent with the spoken guard and
  wrong for this channel — it turns a bad message into a broken one and still
  fails the caller. The atomicity is the difference.
- **Validate phone numbers instead of tracing them.** Length, prefix and carrier
  lookup all pass `888-555-0199`. A validator here would have shipped as a test
  that could not fail — ADR-103's class.
- **Screen every string argument on every tool.** `dateTimeIso` is digits that
  are a date, `captureField.field` is screened elsewhere for a different
  property, dispositions and intents are enums. A per-field allowlist trades a
  real defect for a stream of false refusals on the tools that carry the call's
  outcome.
- **Delete the whole `*...*` span as a stage direction.** Requires both
  delimiters in one scrub pass and a guess about which spans are narration; it
  eats `*really*` sometimes, and "sometimes deletes a word from live speech" is
  not a guard, it is a new defect.
- **Keep the tone-tag anchor and widen the buffer cap instead.** The cap exists
  because ADR-101 proved an unbounded buffer mutes short turns. Widening it
  trades a known leak for a known silence, and any prefix longer than the new
  cap reproduces this exactly.
- **Fix the outbound framing only in the personas.** Nine files, user-editable,
  and the operator-authored ones are not covered at all. `buildCallControlBlock`
  already knows the direction; it is the only place that always does.
