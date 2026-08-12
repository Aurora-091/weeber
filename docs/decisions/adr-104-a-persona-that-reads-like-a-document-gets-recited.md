# ADR-104: A persona that reads like a document gets recited

- **Date:** 2026-08-12
- **Status:** Accepted (implemented 2026-08-12)
- **Supersedes / amends:** amends the prompt-hygiene gates of G1.3/G1.4 (`database/prompt-hygiene.test.ts`) by re-pointing them from the file at the seeded region and widening G1.4 from 3 templates to all 9. Fixes the bracket-placeholder half of the "degrades gracefully" claim in `voice/merge-tags.ts`. Adds the spoken-output guard that ADR-103's tone-tag defect and the gateway leak measurement both argued for. Third consecutive ADR (with -101, -103) on the gap between what the agent was configured to do and what a caller actually heard.

## Context

Three findings converged on one cause.

**The transcripts.** Two production calls opened like this:

> call 22 — "Hello, is this ? This is calling on behalf of krisn"
> call 24 — "Hi, is this [Caller Name]? This is [Agent Name] with presistentads"

The first is a merge tag removed and the sentence spoken through the hole. The
second is worse: `[Caller Name]` and `[Agent Name]` were *read out loud*.
`merge-tags.ts` resolves `MERGE_TAG_PATTERN = /\{\{(\w+)\}\}/g` and nothing else,
so for a persona opening `You are [Agent_name: {{agent_name}}]` it stripped the
tag from inside the brackets and left the bracket and its label standing. Six of
the nine seeded personas used that bracket grammar. The file's own docstring says
tag removal degrades "gracefully"; call 22 is that claim being false in
production, and call 24 is a second grammar the scrubber never knew existed.

**The size.** `seedAgentTemplates()` read each prompt file with
`Bun.file(...).text()` and wrote the **whole document** into
`agent_templates.default_persona_prompt`. These files are authoring documents:
each carries a `**File:**` header, a regulatory-grounding pointer, a variables
table sourced from column names, a "Why this template exists" rationale, a
"## Tools — explicit mapping" table, and a "Known gap, flagged not hidden"
paragraph. All of it was shipped to the model as if it were instruction to an
agent on a live call. Measured per file, 13-40% of each seeded persona was prose
addressed to a maintainer. The launch agent
(`09-insurance-final-expense-qualifier-agent.md`) was the worst: 19,711
characters, 272 lines, 40% metadata — re-sent on every turn of every call.

**The shape.** What remained was written as a numbered script: `SECTION 1`
through `SECTION 6`, steps 1-7, lettered `Branch A/B/C` closings, a "Reschedule
Module" cross-reference, and per-language closing lines to be delivered exactly.
Half of those labels are references to a document the model never sees. ADR-103
recorded the behavioural consequence from the synthetic harness: the agent
"repeated the canned line … near-verbatim across turns" and answered six
consecutive pricing pushes with restatements of the same refusal. The complaint
"the agent sounds scripted" was not a tuning problem. The agent was handed a
script and did the obedient thing.

**And a fourth, found while measuring providers.** Probing gateway transports for
ADR-105, `groq/llama-3.1-8b-instant` — served by **deepinfra**, not Groq — emitted
its own tool-call syntax as assistant text in **4 of 6** runs:

> `3"}</function>I've saved your order number, ORD-48213.`

`agent.ts` piped `result.textStream` straight into `onTextDelta`, whose consumers
(`stream.ts` → `sendTtsTextWithTone`, `test-call-stream.ts` → `tts.sendText`) hand
text to TTS. The only filter in the path was `tone-tags.ts`, which strips a
*leading* `[[tone:]]` marker. Nothing anywhere refused to speak a model's control
tokens. On a live call TTS would have pronounced that fragment.

## Decision

**1. A persona file has two audiences and now says which is which.**
`<!-- runtime:begin -->` / `<!-- runtime:end -->` markers delimit what gets
seeded. `extractRuntimePersona` (`voice/persona-source.ts`) returns only those
regions; multiple regions are supported so a file can interleave persona and
commentary. Everything else — header, regulatory pointer, variables table, tools
table, known gaps — stays in the file and never reaches the model.

**Absent markers throw.** There is no fall-back-to-whole-file, deliberately: a
silent fallback would restore this exact defect the moment a tenth prompt file is
added, invisibly, which is the shape of the seeder's earlier off-by-one that
skipped every template while logging success. The throw lands in
`seedAgentTemplates`'s existing per-template catch, so it surfaces as a loud
skip with the file named.

**2. The runtime regions are goal-based, not scripts.** All nine rewritten. Each
now states who the agent is, how it speaks, what it is trying to learn or
achieve, how the call opens, where it stops, and its guardrails — with example
phrasings marked as illustrations. Every regulatory guardrail is carried over
**verbatim**, including ADR-081's full boundary list, and the per-language
*audited wording* blocks stay inside the runtime region because the agent must
speak those verbatim. Removed: `SECTION n`, `Step n`, `Branch A/B/C`, "Reschedule
Module", every bracket-grammar slot, and every instruction that the ordering of a
conversation is fixed. Added to each: an explicit rule never to speak a
placeholder, a bracketed label, a field name, or text it could not fill in — say
the sentence without it instead. That last line is the direct fix for call 22.

**3. A spoken-output guard at the one chokepoint.** `voice/output-guard.ts`
scrubs tool-call syntax, leading JSON residue and bracket placeholders from the
text stream, wired into `runVoiceAgentTurn`'s delta loop. It buffers across delta
boundaries (`MAX_PATTERN_SPAN = 44`) so a pattern split across two chunks is
still caught, and carries whitespace across emit boundaries so removing a
fragment does not produce "is this ?". `full` — the stored transcript — is
accumulated from the *guarded* text, so the record matches what the caller heard.
Findings are `console.warn`ed loudly: the guard stops the caller hearing it, but a
finding always means a real defect upstream.

One chokepoint rather than four: live calls, the test chat, the synthetic harness
and the preview drawer all consume `onTextDelta`, so guarding there covers them
at once instead of asking four call sites to each remember.

**4. Persona size becomes a CI ratchet.** `bun run persona:gate`
(`tools/persona/persona-gate.ts`, budgets in `persona-budget.json`) fails when a
runtime region grows, when a seeded file has no budget entry, when a budget entry
has no file, or when authoring prose or a bracket slot leaks back inside the
markers. Budgets are the measured sizes at this commit, not round numbers — a
round number leaves silent headroom to grow into, which is how a persona reached
19k. Wired into `ci.yml` as `persona-size` and into `ci-success`'s `needs`.

**5. The existing prompt-hygiene gates now read the seeded region, not the
file.** G1.3 (merge tags) and G1.4 (engineering metadata) were written when file
and prompt were the same bytes. Re-pointing them is a **tightening**: G1.4 now
runs against all nine templates instead of only the three Shopify ones, because
with editorial prose out of scope the insurance six pass it. Two new assertions
per template: the runtime region contains no authoring prose or bracket slot, and
no script scaffolding (`SECTION n`, `Branch X`, `Step n`, "Reschedule Module").

## Measured

| | before | after |
|---|---|---|
| seeded persona chars, all 9 | 103,752 | 73,783 (−29%) |
| launch agent (09) | 19,711 | 11,754 (−40%) |
| bracket-grammar slots in seeded text | 6 files | 0 |
| script scaffolding labels in seeded text | 9 files | 0 |
| templates covered by G1.4 metadata gate | 3 | 9 |
| api tests | 1,188 | 1,221 |

Gates at commit: `bun run --cwd packages/api test` 1,221 pass / 0 fail, `lint` 0
errors, `knip:gate` 61/61 baseline, `design:guard` no increase, `contrast:gate`
9 of 9 declared, `persona:gate` OK, `tsc --noEmit` clean.

## Consequences

- **Production `agent_templates` still holds the old whole-file personas.** The
  code change alone fixes nothing on a live call; the four prod orgs keep
  reciting until `seedAgentTemplates()` is re-run against production. Nothing in
  this repo is hand-edited in that table, so a re-seed is safe — but it is a
  write to production and is done deliberately, not as a side effect of a deploy.
  **Until that re-seed, calls 22/24's behaviour is unchanged.**
- The guard is a net, not a fix. Every finding it logs is a defect somewhere else
  — a model leaking control tokens, or a persona still carrying a placeholder.
  Silence from it is the only acceptable steady state.
- "Goal-based" is a claim about how the agent will behave, and it is currently
  unverified on real audio. The synthetic harness (ADR-103) can now be re-run to
  see whether near-verbatim repetition drops; that measurement has **not** been
  taken yet.
- A tenth prompt file that forgets the markers fails at CI and, if it somehow
  reaches a deploy, is skipped loudly rather than seeded wrongly.
- The bracket-slot rule lives in `persona-source.ts`, not in `merge-tags.ts`.
  The runtime scrubber still cannot resolve bracket grammar; the decision is to
  forbid the grammar rather than teach the scrubber a second placeholder syntax
  with its own edge cases.

## Rejected

- **Teaching `merge-tags.ts` to strip bracket slots.** It treats the symptom and
  legitimises a second placeholder grammar in persona files. A placeholder the
  merge layer must guess at is one that eventually reaches a caller's ear; the
  files should not contain one.
- **Keeping the whole file seeded and simply deleting the editorial prose.** The
  prose is genuinely useful — the regulatory grounding pointer and the "Known
  gap" notes are why the guardrails are trustworthy. The problem was never that
  it existed, only that it was spoken to the model. Two audiences, one file, an
  explicit boundary.
- **A whole-file fallback when markers are missing.** Convenient, and it silently
  re-creates the defect. See ADR-090's defect class.
- **Filtering tool syntax in `tone-tags.ts`.** It is a tone-tag filter; loading it
  with unrelated safety scrubbing hides both. Separate concern, separate module,
  same chokepoint.
- **A round-number persona size limit (e.g. 8,000 chars).** Headroom is what got
  used up last time.
- **Rewriting the audited per-language lines into guidance.** They are regulatory
  text with reviewed translations. Goal-based phrasing is right for discovery and
  wrong for a compliance disclosure.
