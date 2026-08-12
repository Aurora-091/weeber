# ADR-105: An agent that cannot transfer must not promise a person

- **Date:** 2026-08-12
- **Status:** Accepted (implemented 2026-08-12)
- **Supersedes / amends:** extends the `transferLatched` latch introduced by ADR-082 from `hangUp` to every caller turn. Applies ADR-069/G1.4's "omit the tool when the server cannot bind its inputs" shape to `transferToHuman`. Same defect class as ADR-098 (a path that depends on a table nobody populated) and ADR-090 (behaviour that looks shipped and has no working caller). Corrects a claim carried in the ADR-103 follow-up notes — see *A wrong diagnosis on the record*.

## Context

### What the caller heard

Production call 25 (2026-08-10, outbound, `lead_id 4`, the launch final-expense
qualifier, 46 turns, 21 tool calls). The agent qualified the lead properly —
coverage purpose, budget comfort, income timing, banking readiness, a tobacco
answer, a health-readiness flag — stayed inside every ADR-081 boundary, and
closed with:

> "And that's everything I need. Let me connect you with a licensed advisor
> right now; they'll go over your real options and answer every question. One
> moment while I get them on the line.
> **You're connected — the advisor will take great care of you. Thanks!**"

Nobody was connected. The line was hung up on them.

The call row reads `status = "completed"`, `disposition = "booked"`,
`health_status = "healthy"`, `intent = "purchase_or_booking"`. On every
dashboard this is the best call the product has ever placed. It is a warm lead,
mid-promise, being dropped.

### Why the transfer could not have worked

`orgs.human_transfer_number` is **NULL on all four production orgs**, and
`insurance_advisors` is still empty (ADR-098). So `performTransfer` resolved no
target, logged `transferToHuman requested but no transfer number is configured
anywhere — hanging up instead`, and called `performHangUp`.

Every layer here behaved exactly as written. `resolveHumanTransferNumber`
correctly refuses a global env-var fallback (2026-07-17: a shared number would
transfer one org's callers to another org's humans). `performTransfer` correctly
prefers hanging up to guessing. ADR-082's precedence rule correctly chose the
transfer over the same-turn hangup. The defect is upstream of all of it: **the
model was handed a `transferToHuman` tool on a call where it could not possibly
succeed**, and a persona telling it that "the best outcome is a live warm
transfer to a licensed advisor". It did as instructed. The tool's existence was
the promise.

This is the launch vertical's only conversion event, and it is structurally
impossible in production today.

### Why the closing line was spoken twice

The same transcript ends with the "You're connected" sentence appearing **twice**,
seven seconds apart, and `tool_calls` shows `transferToHuman` fired twice with
an identical reason, plus a second `crmSync` and a second `sendSms`.

`transferLatched` (ADR-082) gated `hangUp` and nothing else. Between the model
requesting the transfer and `performTransfer` bridging the leg — which happens
at `speak()`'s tail, after the hand-off line finishes playing, deliberately
bounded by `CLOSING_LINE_MAX_WAIT_MS` — STT stays connected and the turn path
stays fully open. The caller said "You're gonna use the same number" at
16:15:51; STT delivered the near-duplicate "You can use the same number" at
16:15:58; that utterance ran a **complete extra turn**.

This had been filed for two sessions as "duplicated agent text with a tone tag
mid-sentence", i.e. as a rendering defect. It is not. It is a second turn nobody
had forbidden. (The mid-sentence tone tag is a real and separate defect, filed
as ADR-106.)

### A wrong diagnosis on the record

The standing defect list said *"hand-off spoken but never recorded — the agent
promises an advisor callback and calls neither `bookAppointment` nor
`transferToHuman`."* That came from ADR-103's synthetic harness. It is **not
what production does**: call 25 recorded `transferToHuman` twice. Recording the
correction here rather than editing ADR-103, per ADR-078.

The harness finding and the production finding are different failures with the
same appearance from the dashboard, and the production one is worse — a tool
call that is recorded, counted as a conversion, and still leaves the caller
hung up on.

## Decision

**1. A call that cannot reach a person is not given the tool.**

New `voice/handoff.ts`, pure and exhaustively table-tested, exporting
`resolveTransferCapability({ transferNumber, provider, hasOrg })`. A call can
hand off only when it has a resolved org, a telephony provider with a wired-up
mid-call transfer path (`twilio`, `plivo` — Exotel has no confirmed REST action
for a connected call), and a non-blank `orgs.humanTransferNumber`. Blocked calls
carry a reason: `no-org`, `provider-unsupported`, `no-transfer-number`.

Resolved once in the `"start"` handler and then fixed for the life of the call,
for the same reason `crmSyncContext` is: what the agent may promise must not
shift mid-conversation. `humanTransferNumber` rides along on the `orgs` select
that already runs in the batched pickup lookup, so this costs no round-trip on
pickup-to-first-word.

**2. Removing the tool rewrites the persona for free.**

`narrowToolsForTransferCapability` drops `transferToHuman` from
`enabledToolsOverride`. `buildCallControlBlock` already derives its `canTransfer`
line from that same list, so a blocked call's prompt now says *"there's no live
transfer available on this call"* instead of offering a handoff. That seam
existed; nothing was feeding it the truth.

The `undefined` case is the one that mattered. Throughout this codebase
`enabledTools === undefined` means "every tool is available", and most
production calls have no agent-frame row — so a plain `.filter()` would have
been a no-op precisely where nobody had configured anything. The helper
materializes `AVAILABLE_TOOL_NAMES` in that case, and *only* in that case:
materializing on capable calls too would silently freeze today's tool list onto
every frame-less call. `bookAppointment` is deliberately left intact, so a
blocked call still has its documented fallback — a booked callback — rather than
no recordable outcome at all.

**3. The model may promise the handoff; it may not report it.**

A new call-control rule: *say you are connecting them, never say you have
connected them.* Connecting is this server's action, it happens strictly after
the model stops talking, and it can still fail. "One moment while I get them on
the line" is right; "You're connected" is a claim the model is not in a position
to make.

**4. The latch stops turns, not just hangups.**

`transferLatched` now short-circuits the STT end-of-turn handler. The utterance
is still written to `transcripts` — the record stays faithful to what the caller
said — but no turn runs and no tool fires. Whatever a caller says in that window
belongs to the human they are about to be handed to; answering it means the
agent is still negotiating a call it has already declared finished.

**5. The two decisions are pinned to each other.**

`performTransfer` keeps its own provider check and its own no-number fallback as
defence in depth (an org can clear its number mid-call). Because they are now
two copies of one decision, `handoff.test.ts` asserts against `stream.ts`'s
source text that they still agree, and that the capability is resolved before
the tool list is built. Blunt, but it is the only check that fails when someone
edits one side.

## Measured

- `orgs.human_transfer_number`: NULL on **4 of 4** production orgs. Every call
  placed to date was therefore incapable of the hand-off it was offering.
- Call 25: `transferToHuman` **2×**, `crmSync` **2×**, `sendSms` **2×**, the
  closing line spoken **2×** — all from one phantom post-latch turn.
- api tests 1,221 → 1,241 (+20, all in `handoff.test.ts`).
- No added latency: the capability rides an existing `orgs` select.

## Consequences

- **Until an org sets `humanTransferNumber`, its agents will no longer offer a
  live transfer at all.** This is the point, and it is a visible behaviour
  change: the final-expense persona's stated best outcome becomes unreachable
  and it will route qualified leads to `bookAppointment` instead. The honest
  version of today's behaviour, not a regression from it.
- Nothing yet *tells* an operator to set the number beyond a `console.warn`.
  Surfacing "this agent cannot hand off" in the dashboard is the obvious next
  step and is not in this ADR.
- `call-health.ts` still reports call 25 as `healthy`, correctly — it is scoped
  to pipeline health (dead air, STT connect, TTFT), not to promise-keeping.
  Nothing in the stack notices a broken promise. That gap is now known and
  unfixed.
- A caller who says something genuinely important in the post-latch window
  (e.g. "actually, no, don't transfer me") is now ignored rather than answered.
  Accepted: the alternative is the call-25 behaviour, and the transfer bridges
  within seconds.

## Rejected

- **Just populate `humanTransferNumber` on the four orgs.** Fixes today and
  leaves the defect. Every org self-serves this field and none is required to
  set one, so "unconfigured" is a state the product must handle, not an
  onboarding step to remember. This is exactly how ADR-098 happened.
- **Keep the tool, fix only the wording.** The model would still call a tool
  that cannot succeed, still get a hang-up, and still book the lead as
  converted. The wording rule ships too, as the second layer — not the only one.
- **Fall back to a global transfer number.** Rejected on 2026-07-17 for the
  right reason (cross-org transfers) and still rejected.
- **Let `performTransfer` book an appointment when it cannot bridge.** Silently
  substituting a different outcome for the one the caller was just promised, at
  the point where it is too late to say so. The refusal belongs before the
  promise, not after it.
- **Treat the duplicated closing line as a rendering bug.** What it looked like
  for two sessions. It was a whole turn.
