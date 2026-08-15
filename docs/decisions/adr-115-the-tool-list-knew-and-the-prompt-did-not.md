# ADR-115 — The tool list knew and the prompt did not

- **Date:** 2026-08-15
- **Status:** Accepted (implemented 2026-08-15)

## Context

Audit 17 (`audit/2026-08-14-audit-17-the-agent-narrates-tools-it-does-not-have.md`) F1: on production
calls 1 and 9 the agent said it was connecting the caller to a licensed advisor, and `tool_calls`
proves no transfer was attempted on either call. `orgs.human_transfer_number` is NULL on the only
production org, so no transfer was possible in the first place.

ADR-105 was supposed to have made that impossible. It resolves hand-off capability once, from config
the server can verify, and removes `transferToHuman` from the tool list when the call cannot reach a
person — a tool the model cannot see is a promise the model cannot make. That half works, and is
exactly what happened on calls 1 and 9: the tool was withheld.

The other half never existed. `stream.ts` carried this comment above the narrowing:

> Dropping the tool also rewrites the persona, for free and by design: `buildCallControlBlock`
> derives its `canTransfer` line from this same list […] That prompt seam already existed; nothing
> was feeding it the truth.

`buildCallControlBlock` does derive its transfer text from a tool list — **a different one**. The
system prompt is composed inside `resolveAgentConfig`, from the saved `org_agent_configs.tools_enabled`
row, in the same `Promise.all` that fetches the org. The narrowing runs afterwards and reaches only
the tools handed to the model. The two inputs to one turn, resolved in the wrong order, and the
comment asserting they agreed is the only thing that ever connected them.

Verified against production rather than argued: `tools_enabled` on config 6
(`insurance-final-expense-qualifier`, the launch agent) contains `transferToHuman`, so every call it
served got the transfer-**capable** call-control text — *"say you are transferring them"*, *"say you
are connecting them; never say you HAVE connected them"* — with no transfer tool and no target. The
persona body ends in an advisor hand-off script, and the prompt's own call-control layer told the
model to narrate it. It did as instructed. ADR-090's defect class from the inside: real code, real
caller, wrong input, and unit tests that could not see it because each half is correct in isolation.

**The obvious fix does not work, and this is measured.** Replaying the real config-6 prompt against
the real narrowed tool list on the model config 6 runs (`direct:groq/llama-3.3-70b-versatile`, 5
conversations × 8 caller turns, written to push straight at the hand-off, 32–40 assistant turns per
arm):

| prompt | spoken hand-off promises | `transferToHuman` attempts |
| --- | --- | --- |
| A — as shipped | 4 | 7 |
| B — shipped + an override block appended | 3 | 2 |
| C — recomposed from the narrowed list + the same override | 0 | 0 |

Arm B is a prompt that contradicts itself, and it gets obeyed about half the time. The transfer-capable
text has to be **gone**, not argued with. In arm C the model instead says it cannot put someone on the
line — which is the true statement — and stops attempting a tool it does not have. (Those attempts are
not free: a strict-tool-calling provider rejects the entire turn when the model names a tool absent
from the request, which is a dead turn on a live call.)

## Decision

**Recompose the call-control layer from the narrowed tool list, then append an explicit override —
both halves, because neither alone was enough.**

1. `resolveAgentConfig` returns `promptInputs`, the exact `ComposeSystemPromptOptions` its
   `systemPrompt` was composed from. Data, not a closure, so it is inspectable and testable, and so a
   caller that learns something new about the call **after** composition can rebuild rather than do
   string surgery on the result.
2. `stream.ts`, once `transferCapability` is resolved, recomposes with
   `toolsEnabled: enabledToolsOverride` (the narrowed list) and assigns the result to `persona` — the
   string every later turn and the greeting read. Pure string work on values already in memory: **no
   query, nothing added to pickup-to-first-word**, which is why the fix is here and not "compose the
   prompt later". Capability needs the `orgs` row and the telephony provider, which resolve in the
   same round-trip as the persona itself; composing after them would put a query on the one budget
   this codebase does not spend.
3. `applyTransferBlockedPrompt` (pure, in `handoff.ts` beside the capability it reads) appends a
   final block on a blocked call: you cannot transfer anyone here, any instruction above that says
   otherwise does not apply, never offer or announce a hand-off, say plainly you cannot and take the
   follow-up yourself. Last position because it has to beat a persona whose script ends in a hand-off.
   No-op when the call **can** transfer, and idempotent.

Three properties of that text are load-bearing:

- **It names no tool.** On exactly these calls `transferToHuman` is absent from the request, and
  naming a tool the model cannot call is how the whole turn gets rejected.
- **It is identical for all three blocked reasons.** `describeTransferBlock` is operator-facing and
  says which knob to turn; this is caller-facing, and the caller's experience of `no-org`,
  `no-transfer-number` and `provider-unsupported` is the same — no person is reachable. Three prompt
  dialects for one behaviour is three things to keep honest.
- **It forbids explaining why.** The first draft produced *"I'm a large language model, I am not
  capable of transferring calls"* — an honest refusal that breaks the persona in front of a prospect.
  One sentence, no apology, no mention of tools, systems or what kind of software it is.

`resolvePersona` is split into `resolvePersonaBody` (the resolution chain: org override → template
default → explicit prompt → `AGENT_PERSONAS` → default) plus the two wrapping layers. Recomposing
needs the body the layers wrap, and without it the fallback paths — an org with a template but no
`org_agent_configs` row, a real production shape — could not be corrected at all and would keep
telling the model that a warm transfer is the best available outcome. Those two paths now compose
through `composeSystemPrompt` like every other path, with a test asserting byte-for-byte equality with
what `resolvePersona` returns rather than a comment claiming it.

The false ADR-105 comment is **corrected in place in the code** with a dated note naming this ADR.
Per ADR-078 the ADR-105 document and the changelog entries are left untouched: they are the record of
what was believed then, and this is the correction.

## Rejected

- **Setting `orgs.human_transfer_number` on the production org and calling F1 fixed.** That is the
  band-aid ADR-105 already rejected for itself: it fixes today's one org and leaves the defect. Every
  org self-serves that field and none is required to set one, so "unconfigured" is a state the product
  must handle honestly, not an onboarding step to remember. Still worth doing for the demo path —
  separately, and it is not this.
- **Appending the override alone** (arm B). Measured above. Kept as the second half only because it
  is what makes the *persona body's* own hand-off script stop firing; the recomposition is what
  removes the platform's contribution.
- **Rewriting the seeded personas to delete the hand-off script.** Six replay runs of the real persona
  on the real tools leaked nothing attributable to the persona, and the script is correct for an org
  that *has* configured a number. The prompt should be true per call, not lowest-common-denominator.
- **A fourth `output-guard.ts` regex** matching "connecting you". The guard deletes text after the
  model has produced it and mid-sentence deletion is how a turn becomes incoherent; the model should
  not be forming the promise.
- **Reordering composition so the prompt is built after capability.** One more round-trip on
  pickup-to-first-word (ADR-100/-107) for a string operation.
- **A closure (`recomposeWithTools`) on `ResolvedAgentConfig` instead of `promptInputs`.** It would
  have avoided touching five `mock.module("./agent")` blocks and hidden the inputs behind a function
  no test can inspect. The five mock edits are the cheaper price.
- **Reason-specific prompt text.** See above.

## Consequences

api tests **1363 → 1375** (12 added), web **101** unchanged. All five ratchets green with nothing
widened: `knip:gate` baseline 61, `design:guard` 581 (`rawButton` 111, `arbitraryPx` 365),
`contrast:gate` 9 of 9 declared, `persona:gate` OK.

Non-vacuity is asserted on both sides, in the shape `handoff.test.ts` already uses for ADR-105: the
override must appear after the text it overrides and must name no tool; the recomposed prompt must
lose *"Say you are connecting them"* and gain *"there's no live transfer available on this call"*;
`stream.ts`'s source must still contain both the recomposition and the append, in that order, after
the narrowing; and the false ADR-105 sentence must not come back.

Five `stream-*.test.ts` files mock `./agent` and had to grow a `composeSystemPrompt` export — the
mocks return no `promptInputs`, so they exercise the append-only path, which is the correct behaviour
for a config that cannot be recomposed.

**Known and unfixed:**

- **Nothing has been verified on a real call.** The evidence is a replay harness against the real
  prompt, the real tool list and the real model. Railway API access is still dead (the token in the
  sandbox returns `Not Authorized` for both auth shapes), so the deployed SHA cannot be confirmed and
  the 17:00:41 logs from call 11 still cannot be read.
- **The append-only path is still live** for any call whose config carries no `promptInputs` —
  today only the mocked test surfaces and `session.resolvedConfigOverride` consumers that build the
  config themselves. `buildPreviewAgentConfig` does return `promptInputs`.
- **`test-call-stream.ts` performs no transfer narrowing at all.** It reads `agentConfig.enabledTools`
  directly, so a test-chat session on an org with no transfer number still gets the capable prompt and
  the tool. Out of scope here and not fixed; it is not a telephony path, but it is the surface a
  merchant uses to judge the agent.
- **The prompt is now built twice on a blocked call.** Cheap and pure, but it means
  `agentConfig.systemPrompt` and the `persona` actually used are no longer the same string, and only
  the latter is what ran. Nothing persists either, so a transcript review cannot recover which was
  used — the same class of gap as `calls.llm_provider_used` recording configuration rather than
  measurement.
- **The model still leaks tool-call syntax as text** in both arms of the replay (audit-17 F2),
  including on turns where it correctly refuses the hand-off. Unchanged by this ADR.
- **The residual promise is in the opener.** In arm C the one line that still reads like a hand-off
  is the greeting's *"so I can connect you with a licensed advisor"* — persona-body copy, spoken
  before the caller has asked for anything. Not fixed here.
