# Audit 14 — The agent does not know what day it is, or who it is calling

**Date:** 2026-08-10 (later the same day as audit 13)
**Scope:** the four calls placed on 2026-08-10 (ids 22, 23, 24, 25) read turn by turn — `transcripts`, `tool_calls`, `turn_latency`, `calls` — against `packages/api/src/voice/{agent.ts,stream.ts,merge-tags.ts,tools/*,turn-detection/*}`.
**Type:** defect sweep + a correction to audit 13. No code changed. Nothing here is implemented.
**Status of the numbers:** every millisecond and every quoted line is read out of the production database. Nothing external was benchmarked — there are still no LLM/STT/TTS API keys in this environment.

---

## 0. Why this exists a few hours after audit 13

Audit 13 asked "where do the milliseconds go" and answered it against 9 calls / 35 turns, of which 13 had a complete voice-to-voice measurement. Almost none of those turns called a tool.

Calls **24 (237 s, 16 turns)** and **25 (319 s, 27 turns)** were placed after that document was written. They are the first production calls long enough to have a real conversation in them. They do two things:

1. They **invalidate one of audit 13's inferences** and promote a lever it could not see (§4).
2. They show that latency is not the thing that would sink a pilot. **Reading the transcripts is more alarming than reading the stopwatch.** Both calls opened by saying `[Caller Name]` out loud. One booked an appointment 25 days in the past. Neither is a model-quality problem; both are code.

Audit 13 is not edited — it was correct on its own data (ADR-078). §4 here supersedes its lever ordering.

---

## 1. The four calls

| call | org | secs | turns | tool calls | disposition | est. cost | ¢/min |
|---|---|---|---|---|---|---|---|
| 22 | `org_58c7…` krisn | 67 | 5 | 3 | `booked` | 5.41¢ | 4.8 |
| 23 | `org_58c7…` krisn | 89 | 7 | 6 | `booked` | 7.16¢ | 4.8 |
| 24 | `org_a4dd…` presistentads | 237 | 16 | 7 | *(none)* | 19.1¢ | 4.8 |
| 25 | `org_a4dd…` presistentads | 319 | 27 | 21 | `booked` | 25.72¢ | 4.8 |

Steady-state LLM+STT+TTS cost is **~$0.048/min**, consistent to three significant figures across four calls of wildly different length — comfortably inside the $0.06/min all-in COGS assumption, and that is before telephony. The one outlier in the whole dataset is call 21 at **12.7¢/min**, which also logged `provider_failover_count = 2` and `health_status = degraded`. **Failover costs ~2.6× per minute.** Worth knowing before pricing a plan around it.

---

## 2. F1 (P0) — nothing in the codebase ever tells the model what day it is

Call 23, placed **2026-08-10**. The caller asked for "tomorrow at 10 AM". Verbatim from `transcripts`:

> **agent:** "I have your request to book a call for tomorrow at 10:00 AM. Let me just confirm, that is the **17th of July** at 10:00 AM, correct?"
>
> **caller:** "Okay. That's correct."

`tool_calls` for the same call:

```json
{"tool":"bookAppointment","input":{"callerName":"the caller","dateTimeIso":"2026-07-17T10:00:00Z","notes":"Interested in health insurance, requested callback for tomorrow at 10 AM."}}
{"tool":"crmSync","input":{"callerName":"the caller","notes":"User interested in health insurance. Booked appointment for 2026-07-17 at 10:00 AM."}}
```

`disposition = booked`.

This is not the model being stupid. **It was never told the date.** Grepping the entire voice package for any injection of the current date or timezone into the system prompt returns nothing:

```
rg -n "Today is|current date|Current date|toLocaleDateString|toLocaleString|timeZone|Asia/Kolkata" \
   packages/api/src/voice/*.ts packages/api/src/voice/tools/*.ts
→ (no matches)
```

The composed prompt is exactly (`agent.ts:1136-1141`):

```ts
const systemPrompt = scrubSystemPrompt(
  (persona ?? DEFAULT_PERSONA) +
    buildWorkflowContextBlock(workflowMetadata) +
    buildCallerMemoryBlock(callerMemory) +
    buildKnownFactsBlock(capturedState),
);
```

Four blocks, no clock. So when a caller says "tomorrow", the model must guess today from its own weights, and it guessed a date in the training past. `2026-07-17` is not a random error — it is what "now" looks like from inside the model.

The tool schema does not catch it either (`tools/bookAppointment.ts:42`):

```ts
dateTimeIso: z.string().describe("ISO 8601 date-time for the appointment"),
```

No minimum, no future-date check, no timezone requirement. And note the `Z`: even a *correct* date would be booked in UTC, so a 10:00 confirmed with an Indian or US caller lands at the wrong local hour.

Three things make this worse than a single bad booking:

- **It fails silently.** `bookAppointment` returned `(not configured) No Google Calendar connected for this organization.` Nobody noticed. The day a pilot merchant connects a calendar, this starts writing real events into the past.
- **It propagated.** `crmSync` recorded the wrong date as fact, so the error survives the call.
- **The caller confirmed it.** "Okay. That's correct." Callers do not audit us. A read-back is not a validation.

An appointment-setting product that cannot determine the current date has no working core loop. Of everything in this document, this is the one that must be fixed before a pilot call is placed.

---

## 3. F2 (P0) — deleting a merge tag makes the model invent a placeholder and say it out loud

Calls 24 and 25 both opened, verbatim:

> "Quick heads up before we start — this call may be recorded, and you're speaking with an AI assistant. **Hi, is this [Caller Name]? This is [Agent Name] with presistentads** …"

Call 22 opened:

> "… **Hello, is this ?** **This is calling on behalf of** krisn …"

There is no string `[Caller Name]` anywhere in the repo, and no square-bracket placeholder in any `agent_templates.default_persona_prompt` or `org_agent_configs.persona_prompt` row (checked with a regex over both; the only bracket in any template is a literal `[number]`). **The model wrote those brackets itself.** Here is why it had to.

The chain, all four links verified:

1. **The template opener is tag-based.** `insurance-final-expense-qualifier` §2: `"Hi, is this {{lead_name}}? This is {{agent_name}} with {{company_name}} — you'd recently reached out about {{interest_area}}…"`
2. **The fast render path bails.** `stream.ts:2150-2153` renders `literalGreetingTemplate`, and `renderTemplate` (`workflows/variables.ts:47`) leaves an unresolvable `{{tag}}` as literal text, so the guard `if (!/\{\{\w+\}\}/.test(rendered))` rejects the entire line. Audit 13 §2 established why this always fails: the leads rows hold no `name` and no `interest_area`.
3. **The fallback is the LLM, reading the same opener out of the persona body — with the tags deleted.** `scrubSystemPrompt` (`merge-tags.ts`) strips every `{{tag}}` rather than substituting it. So the model receives, as a literal instruction: `"Hi, is this ? This is with presistentads — you'd recently reached out about, and I wanted to follow up."`
4. **The model repairs the sentence.** Handed a grammatical hole in its most authoritative channel, it does the only sensible thing a next-token predictor can do: it fills the slot. Sometimes verbatim as the hole (call 22, "is this ?"), sometimes with a canonical slot marker (calls 24/25, `[Caller Name]`).

`merge-tags.ts` documents the delete-not-substitute decision at length and is explicit about the expected outcome:

> *"Deleting the hole degrades the sentence to a slightly vaguer instruction ("calling on behalf of ."), which the model handles gracefully…"*

**It does not handle it gracefully. Three of the four calls today spoke the damage aloud on the first sentence.** That assumption is now falsified by production data, which is the whole reason this is an ADR (094) and not a bug ticket. The reasoning in `merge-tags.ts` for *not* substituting a placeholder is correct and should be kept — a placeholder is speakable and a guessed default is a lie. The error is the third option it never considered: **an instruction that has a hole in it must not be sent at all.** A sentence the runtime cannot complete should be replaced by a different, complete sentence, not by a mutilated version of itself.

Note also that this is the same root cause as audit 13's P0 latency finding, which is the strongest argument for fixing it: the greeting fast path is now **0 for 11** (every call in production, ids 15–25, has a non-null `llm_ttft_ms` on `turn_index = 0`; the literal path goes through `speakCannedLine` and would record none). One fix buys **~1.5 s off every call's pickup-to-first-audio *and* stops the agent introducing itself as `[Agent Name]`.**

---

## 4. Correction to audit 13 — the largest measured latency lever is sequential tool calls

Audit 13's dataset had almost no tool-using turns, so it read `llm_ttft_ms` as model time-to-first-token. On any turn that calls a tool, **it is not**. `onLatency` fires on the first token of the *text* stream (`agent.ts:1167-1171`), and `stopWhen: stepCountIs(6)` (`agent.ts:1158`) means up to six sequential model↔tool round trips can complete before a single spoken token appears. On those turns `llm_ttft_ms` measures tool orchestration, not the model.

Split the 56 turns that have a TTFT by whether any tool fired in the same turn window:

| | n | p50 `llm_ttft_ms` |
|---|---|---|
| turns with ≥1 tool call | 16 | **2956 ms** |
| turns with no tool call | 40 | **1329 ms** |

**Delta: +1627 ms, on 29% of turns.** And the separation is total — **every one of the 12 turns above 2500 ms has at least one tool call; not one no-tool turn exceeds 1852 ms.** The tail:

| call | turn | TTFT | v2v | tools in window |
|---|---|---|---|---|
| 24 | 10 | **7636** | 8173 | `captureField` |
| 24 | 13 | **6561** | 7106 | `captureField, sendSms, crmSync, transferToHuman` |
| 25 | 26 | 3826 | 4394 | 15 calls incl. `captureField`×7, `transferToHuman`×2, `crmSync`×2, `sendSms`×2 |
| 23 | 6 | 3321 | 3792 | `setIntent, crmSync, bookAppointment, captureField, setDisposition, hangUp` |

Two consequences.

**(a) This is the top lever, and it is measured, not cited.** It outranks audit 13's lever #3 (reasoning effort, 300–700 ms, cited) on both size and confidence. It is also the only lever in either document with a *negative* cost delta — fewer model steps is fewer tokens.

**(b) It is mostly waste, not work.** Most of these tools return nothing the reply depends on. `captureField`, `crmSync`, `setIntent`, `setDisposition` and `sendSms` are write-only side effects, yet each is awaited inside the caller's silence. And they are fired redundantly — duplicate `tool_calls` rows, same call:

| call | tool | times |
|---|---|---|
| 25 | `captureField` | **11** |
| 25 | `setIntent` | 3 |
| 25 | `sendSms` / `crmSync` / `transferToHuman` | 2 each |
| 24 | `captureField` | 4 |
| 21 | `transferToHuman` / `hangUp` | 2 each |

Several are byte-identical re-captures — `income_type: "business owner"`, `banking_ready: "yes"` and `benefit_timing: "first of the month"` were each written twice on call 25. Nothing in the tool layer is idempotent and nothing dedupes, so **the redundancy and the latency are the same defect.** Fixing idempotency and moving write-only tools off the speech path should be a single change.

Also worth recording as a *non*-lever: `await turnDetector.decide()` on the critical path is free. `HeuristicTurnDetector` (`turn-detection/heuristic.ts:36`) is local regex, and `withLatencyBudget` only matters when an EOT model is configured — none is. Ruled out.

**Third blind spot, added to audit 13 §5:** `llm_ttft_ms` conflates model latency with tool orchestration. Until tool time is recorded separately, no model-side lever can be evaluated, because the metric that would show the improvement is dominated by something else on a third of turns.

---

## 5. Everything else the transcripts show (P1/P2)

**F3 (P1) — TTS control markup spoken aloud.** Call 25, agent turn, verbatim: `"…right now. \n\n*Sending text message...* \n\n[[tone:upbeat]] And that's everything I need."` The `DEFAULT_PERSONA` instruction not to emit markdown or symbols is advisory, and `[[tone:...]]` is a real control tag `stream.ts` is supposed to parse out (`tts/cartesia.ts:36` refers to it). It reached the caller's ear as speech. There is no sanitiser between the text stream and TTS.

**F4 (P1) — a transfer we claim but never make.** Calls 24 and 25, verbatim: *"Let me connect you with a licensed advisor right now"* and *"**You're connected** — the advisor will take great care of you. Thanks!"* `transferToHuman`'s entire output is `{"transferRequested": true}`. No transfer occurred; both calls ended with the caller saying "Okay. Okay." into a dead line. We are telling callers they are connected to a licensed insurance advisor when they are connected to nothing. On a regulated product this is the worst-looking line in the dataset.

**F5 (P1) — placeholder sent by SMS too.** Call 25 `sendSms` body: `"…Here is our contact information for your records: **[Advisor Desk Number]**."` A later SMS on the same call used `888-555-0199`; call 24 used `(800) 555-0199`. Same class as F2, different channel, and this one is a written artefact the recipient keeps.

**F6 (P1) — health data captured after an explicit refusal.** Call 25, the caller declined the tobacco question — *"I'm not comfortable sharing this information"* — then later volunteered *"I'm sugar patient"*. `crmSync` wrote: `"Health: diabetes/sugar patient (prefers to discuss with advisor)"`. A volunteered aside became a stored health record on a caller who had just refused health questions. Whatever the legal read, there is no code path that treats a refusal as a capture boundary.

**F7 (P2) — entity murder in captured fields.** Call 25 `captureField budget_comfort = "$8.03"` from spoken "about two hundred a month"; corrected later to `"200 a month"`, and **both rows persist** with no supersession marker. Also `"Made of both"` transcribed for "bit of both". `callerName` across all calls is `"caller"`, `"the caller"` or `"unknown"` — never a name.

**F8 (P2) — no disqualification gate.** Call 25's caller said *"I'm a student"*; the agent continued the full final-expense qualification and booked. Every call today ended `booked` except 24. Call 22 was a post-sale welcome call with no booking and no referral and is also `booked` — the disposition vocabulary is not being applied, so **`disposition` is currently unusable as a success metric**, which matters because it is what a pilot would be judged on.

**F9 (P2) — silence warning fires over a thinking caller.** Call 25 said *"Are you still there? Let me know if you need anything else."* at 16:12:49, 16:13:46 and 16:14:51, each time while the caller was mid-thought on a money question. `SILENCE_WARNING_MS = 8000` (`stream.ts:127`) is a fixed threshold with no awareness of question type. ADR-074 and audit 10 covered the timer's *mechanics*; this is the threshold's *appropriateness*, which is a separate call.

---

## 6. What this means for the "latency and intelligence" framing

The working hypothesis going in was that the two problems are latency and intelligence. The data splits that differently.

**Latency is real, table stakes, and mostly self-inflicted.** Measured across 78 turns: voice-to-voice p50 **1878 ms**, p90 **4123 ms**, p95 **4364 ms**, max **8173 ms** (n=44 complete). Three exclusions all bias it *low* — STT endpointing (~300–1000 ms, upstream of our clock), Twilio egress and PSTN (downstream of it), and now tool orchestration hiding inside the metric that was supposed to isolate the model. The market bar is ~800 ms. But of the p90, roughly 1.6 s is sequential redundant tool calls and ~1.5 s of every call's opening is a dead fast path — both ours, both free to fix. And it is not differentiation: a builder on Gemini Flash publicly reports sitting at 1600 ms, i.e. parity. Nobody wins on latency; you only lose on it.

**"Intelligence" is the wrong diagnosis.** Not one defect in §2–§5 is fixed by a better model. The model was never told the date. It was handed a sentence with a hole in it. Nothing dedupes its tool calls, nothing sanitises its output before TTS, nothing verifies a transfer actually connected, nothing treats a refusal as a boundary, nothing validates that a booking is in the future. Every one of those is scaffolding we have not built. Upgrading the LLM would change nothing about any of them, and a cheaper faster model would not make them worse.

The uncomfortable version: **we instrument none of the top failure modes and we would not have caught any of this without a human reading transcripts.** Two of these calls would have failed a design-partner evaluation in their first sentence, before latency was ever a factor.

---

## 7. Recommended sequence

Nothing here is implemented. Ordered by pilot risk, not by effort:

1. **Inject current date/time + org timezone into the system prompt, and validate `dateTimeIso` is in the future** (F1). Nothing else in this list matters if a booking can land in July.
2. **Stop sending instructions with holes in them** (F2) — see ADR-094. Buys the audit-13 latency P0 for free.
3. **Make transfers assert, not announce** (F4). Do not speak a connection claim until the bridge is confirmed.
4. **Sanitise the text stream before TTS** (F3) — strip markdown, `*stage directions*` and `[[tone:]]` tags at the TTS boundary rather than asking the persona nicely.
5. **Idempotency + move write-only tools off the speech path** (§4). One change, buys the largest measured latency win and kills the duplicate writes.
6. **Then** the model-side latency levers from audit 13 §4 — but only after tool time is recorded separately, or they cannot be measured.

Deliberately not proposed here: a refusal-boundary policy (F6) and a disqualification policy (F8) are product/compliance decisions, not engineering ones, and should not be settled in an audit doc.

---

## Appendix — provenance

- Production reads: `transcripts`, `tool_calls`, `turn_latency` (78 rows), `calls` (11), `agent_templates` (9), `org_agent_configs` (17). Every quoted agent line and tool input is verbatim.
- Code read at `main` = `8498e58`. Not verified against the deployed binary — `api.weeber.ai` still returns `DEPLOYMENT_NOT_FOUND` and there is still no version route (audit 13 §5.5).
- No external API was called. No number here is vendor-cited except the ~800 ms market bar and the 1600 ms third-party comparison, both carried over from audit 13 §0.
- n is small. Four calls, two of them by the same org. Directions, not targets.
