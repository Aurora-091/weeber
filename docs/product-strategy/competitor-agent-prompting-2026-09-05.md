# Competitor agent prompting — public-docs comparison (2026-09-05)

**Date:** 2026-09-05. **Not a public/decision doc** — internal reasoning artifact. Scope is *how
these platforms tell builders to write agent prompts and tool instructions*, not what they shipped
in product changelogs. For Bolna/Retell/Bland feature velocity see
[`competitor-changelog-scan-2026-07-17.md`](./competitor-changelog-scan-2026-07-17.md) (product
changelog, not prompting). This note does not change Weeber's cascade architecture, compliance
package, or any persona file.

Pulled from each vendor's public prompting / agent-builder docs as they stood on 2026-09-05
(Vapi, Retell, Bland, Bolna, ElevenLabs Agents, plus Pipecat/LiveKit as the open-stack contrast).
Not secondhand Twitter summaries. Vendor docs move; treat rows as a dated snapshot.

Weeber already has its own prompting law: ADR-104 (runtime vs authoring), ADR-065 (facts not
tags), ADR-106 (no markdown on the wire), ADR-122 (withhold `crmSync` when the org has no
credentials). A live-call lesson from 2026-09-05 sits on top of that: the runtime persona must
not order a tool or a completed transfer the call may not have. Read those before "fixing" a
persona because a competitor's template looks different.

## TL;DR

Every managed voice-agent platform has converged on the same spoken-turn hygiene: sectional
prompts, about two sentences per turn, no markdown in what TTS will speak, numbers as words,
guardrails that override the script, **when** a tool fires living on the tool object (not only
in the system prompt), filler/acknowledgement as a **tool-level** spoken line while the server
works, and an explicit admission that the prompt is **not** a security boundary.

Where they diverge is *structure*: Vapi bets on one well-sectioned prompt plus Liquid context;
Retell and Bland graduate from a single prompt to a graph when branches or tools multiply;
Bolna packages hang-up / handover / closing / compliance as named modules; ElevenLabs puts
`# Guardrails` in the prompt and makes `end_call` / `transfer_to_number` opt-in built-ins;
Pipecat keeps a short system string in code and insists tool results be speakable.

Steal the hygiene and the "tool description is load-bearing" rule. Do **not** copy numbered
persona scripts, keyword-only compliance, or long never-say lists — those fight ADR-104 and
the compliance package.

## Shared rules (table stakes)

| Rule | Why it shows up everywhere |
|---|---|
| Section the prompt (identity, style, task, tools, guardrails, closing) | Models follow headings better than a wall of prose; Weeber's runtime already sections call-control separately from the persona |
| ~2 spoken sentences per turn | TTS latency and barge-in; matches Weeber's "don't lecture" bar |
| No markdown / bullets / emoji in spoken output | ADR-106; Cartesia will read the punctuation |
| Speak numbers, currencies, IDs as words | STT/TTS round-trip; insurance policy numbers especially |
| Guardrails override the sales script | Compliance and jailbreaks; prompt is not the enforcement |
| Tool **when** lives in the tool description | The model attends to the function schema more than a buried paragraph |
| Filler / "one moment" on the **tool object**, not ad-libbed | Deterministic audio while CRM/KB runs; Weeber already has filler on tools |
| Prompt is not a security boundary | Server-bound tools (ADR-066 / ADR-069); non-registration is enforcement (ADR-064) |

## Per platform — the distinct prompting move

| Platform | Distinct prompting move | Do not cargo-cult |
|---|---|---|
| **Vapi** | Six named sections; describe *capability* in the prompt, not the tool slug; Liquid/dynamic context; `endCall` / `transferCall` **descriptions** are load-bearing (the model will not hang up if the description is vague) | Do not start naming `captureField` / `crmSync` in the spoken persona; capability language is the Vapi lesson; slug names in the runtime are how insurance calls failed on 2026-09-05 after ADR-122 withheld the tool |
| **Retell** | Single prompt → multi-prompt tree → Conversation Flow when there are many branches or ~5+ tools; **per-state tool lists**; exact function names + explicit triggers in the node that owns them | Do not rebuild Weeber as a canvas tomorrow; the steal is *per-state tools*, which we only do today for transfer and CRM withhold |
| **Bland** | Split `personality_prompt` vs `orchestration_prompt`; Pathways for branching; reserved `hang` / `transfer`; `{{vars}}` filled from tool results into later nodes | Do not split "personality" into a second authoring surface that the seed pipeline cannot see; Weeber's ADR-104 split is runtime vs authoring, not vibe vs plot |
| **Bolna** | `@` modules: Hang Up, Handover, Closing Branches, Compliance; per-node tool scope; `pre_call_message` for the first clip without an LLM turn | Hang-up as a **reusable module** (not a line buried in each persona) is the useful idea; keyword-only compliance modules are not — Weeber's compliance is code |
| **ElevenLabs Agents** | Markdown `# Guardrails` headings the model is told to treat as hard; built-in `end_call` / `transfer_to_number` **opt-in** | Opt-in end/transfer matches ADR-064 (if it is not registered, it cannot fire). Do not replace `weeber-compliance` with a `# Guardrails` heading |
| **Pipecat / LiveKit** | Short system string in application code; tool results must be speakable English, not JSON dumped to TTS | Matches Weeber's cascade + `buildVoiceTools`; keep tool payloads out of the spoken channel |

## What Weeber already matches

- **Sectional runtime, not a numbered script** — ADR-104. Authoring files can be long; what the
  model sees on the call is composed (persona + call-control + facts).
- **Facts, not unresolved tags** — ADR-065 / greeting work. Competitors' `{{vars}}` only work
  when the orchestrator actually has the value (Bland Pathways, Vapi Liquid). Weeber already
  learned this the hard way on insurance greetings.
- **No markdown on the wire** — ADR-106.
- **Call-control block** composed in `packages/api/src/voice/agent.ts` (`buildCallControlBlock`),
  not left as a hope in the persona.
- **Tool filler** on the tool object while the server works.
- **Server-bound tools** — the model never picks the CRM target or the transfer number
  (ADR-066 / ADR-069). Vapi/Retell docs that say "put the destination in the prompt" are the
  opposite of this bet.
- **Withhold tools the org cannot run** (ADR-122 for CRM; transfer already gated on a number) —
  the same idea as Retell's per-state tools and ElevenLabs opt-in built-ins, applied at call
  start rather than in a visual graph. The remaining honesty gap is the *persona still naming*
  a withheld tool — that is a prompt bug, not a vendor-API bug.

## Gaps worth a later decision (not this note)

These are observations, not a build order. Promoting any of them to work requires an ADR if it
changes authoring or runtime semantics.

1. **Per-state / per-node tool lists.** Today we only narrow transfer and `crmSync`. A post-sale
   "documents not received" close does not need `scheduleCallback`; an appointment-setter mid-qualify
   should not see `hangUp` until a closing branch. Bolna and Retell make this the default. Weeber
   would need a seam, not a canvas.
2. **Hang-up as a reusable module.** Every insurance runtime re-teaches when to hang up. Bolna's
   Hang Up / Closing Branches modules are the pattern; Weeber could compose a closing module the
   same way it composes call-control, instead of pasting closings into each persona (the 2026-09-05
   post-sale silent hangup was a missing closing, not a missing model).
3. **Capability language vs tool slugs in the runtime persona.** Vapi: describe what the agent
   can *do*; keep slugs on the tool schema.    Weeber runtimes still name `captureField` in prose. A hygiene test should fail a runtime
   that still says `crmSync` or "You're connected" after the tool/number was withheld.
4. **Dashboard per-tool spoken filler.** Competitors expose "say this while the tool runs" next
   to the tool. Weeber has filler in code; operators cannot tune it per agent without a deploy.
5. **Eval / simulation weaker than Bland Triage.** Bland's auto-fix-from-failed-calls loop is
   product, not prompting — but it is why their prompts stay honest. Weeber's live-call protocol
   is still the source of truth (`docs/reference/live-call-test-protocol.md`).

## Explicitly do not copy

- **Numbered persona scripts** ("Step 1 say X, Step 2 say Y"). Fights barge-in and ADR-104.
  Competitors that still show these in templates are teaching demos, not production agents.
- **Keyword-only compliance** ("if the caller says 'stop', hang up"). Real DNC/TCPA/HIPAA lives
  in `packages/weeber-compliance`. A prompt heading is not a substitute (STOP-AND-ASK).
- **Long never-say lists.** They rot, they steal context window, and they do not bind the model.
  Prefer a short guardrail + server non-registration.
- **Putting transfer destinations or CRM object names in the prompt.** Competitors who do this
  are optimizing for a single-tenant demo. Weeber's multi-org rule is the opposite.
- **Replacing cascade with Pipecat/LiveKit/S2S because their prompt docs are shorter.** Prompt
  length is not the latency bottleneck we hit on 2026-09-05 (first-token abort, AMD, empty
  hangUp, Cartesia buffer, unused vendor signals). Stay cascade.

## How to use this file

- **Writing or editing a persona** → ADR-104, ADR-106, ADR-122, then this note's "do not copy"
  list. Do not paste a Vapi six-section template into `docs/agent-prompts/`.
- **Changing tool registration / withhold** → ADR-064, ADR-066, ADR-122. The competitor
  analogue is per-state tools / opt-in `end_call`, not a prompt paragraph.
- **Product changelog vs prompting** → the July scan for *what they shipped*; this file for
  *how they tell you to prompt*. Do not merge the two artifacts.
- **How does Weeber itself score?** →
  [`competitor-agent-prompting-weeber-scorecard-2026-09-05.md`](./competitor-agent-prompting-weeber-scorecard-2026-09-05.md)
  (nine seeded runtimes + call-control + tool descriptions, same date).

No code, schema, or `packages/weeber-compliance` change ships with this note.
