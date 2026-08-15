---
doc: audit-17
status: findings — no code changed
date: 2026-08-14
scope: production DB re-read after the first real conversational test calls (11 calls, 2026-08-13/14) — tool execution, transfer honesty, latency, persona/deploy drift
grounded-against: HEAD 7f1d308 (`main`) + production DB (Supabase pooled, aws-1-ap-south-1)
supersedes-context: prior "prod is empty / latency not re-measurable" state is stale — the DB has been reseeded and 11 new calls exist
---

# Audit 17 — the agent narrates tools it does not have

The database is no longer empty. One org (`good insurance`, vertical `insurance`, created
2026-08-13 13:17 UTC) placed **11 outbound calls** on 13–14 August, 125 transcript lines, 72
measured turns, 16 executed tool calls, 76.66¢ total spend over 15.9 minutes.

These are still internal test calls — US Twilio DID `+16087090565` dialing two `+91` handsets —
but they are the **first calls in this system's history where a human actually held a
conversation with the agent**. Everything before was connectivity checks. So for the first time
the data says something about whether the product works, and the answer is: the telephony,
STT, TTS and latency layers work; **the tool layer does not.**

Headline: on 8 of 11 calls the model did not execute tools at all. It either produced empty
turns (heard as "Sorry, I didn't quite catch that", 15 times) or **spoke the tool call out loud
as text** (18 agent lines). Two callers were told they were being transferred to a licensed
advisor. No transfer was attempted on either call, and no transfer was possible on any call:
`orgs.human_transfer_number` is **NULL**.

---

## 0. The headline

| # | Finding | Sev |
|---|---|---|
| F1 | **The agent promises a human handoff it structurally cannot perform.** `orgs.human_transfer_number` is NULL, so `filterTransferTool` correctly strips `transferToHuman` from the tool list — but the persona still scripts the promise. Call 1: *"You're connected — the advisor will take great care of you."* Call 9: *"I'm going to transfer you to a licensed advisor now"*, then the literal text `transferToHuman{"reason": "final-expense qualified handoff"}` spoken aloud. `tool_calls` has zero transfer rows. The gate removed the capability and left the claim. | **P0** |
| F2 | **The model emits tool calls as spoken text.** 18 of 68 agent lines (26%) across calls 8, 9, 11 contain literal call syntax. On call 11 that means `captureField`, `setDisposition`, `crmSync`, `bookAppointment` and `hangUp` never ran — 4 tool rows recorded against 9 narrated calls. The caller heard `<function name="setIntent" >{...}` read out. | **P0** |
| F3 | **The 2026-08-13 fix for F2 (`eafc762`) is in the database but did not stop the leak.** All 9 `agent_templates.default_persona_prompt` rows match `extractRuntimePersona()` of the post-`eafc762` files byte-for-byte — the rewritten persona is what production serves. The other half, `output-guard.ts`, was executed against call 11's two leak shapes at HEAD `7f1d308`: **both pass through uncaught.** Unresolved: whether the deploy that refreshed those rows booted before or after call 11. | **P0** |
| F4 | **`bookAppointment` fabricated a confirmation.** Call 11: *"I've booked a callback for you. A licensed advisor will call you back."* No `bookAppointment` row exists, no Google Calendar is connected, `scheduled_calls` = 0 rows. A prospect was given a false commitment on a recorded insurance call. | **P0** |
| F5 | **15 fallback lines blame the caller for a model failure.** `FALLBACK_REPLY` fires when the model returns no spoken text (`agent.ts:1469`), yet says *"Sorry, I didn't quite catch that."* Calls 7 and 10 opened with it — the greeting turn itself produced nothing, and both calls died in a two-way loop of "Hello?" / "didn't catch that". Call 5 burned 4 of 7 agent lines on it. | **P1** |
| F6 | **Latency improved and the Groq-vs-gateway question is now answered with data.** v2v p50 **1591 ms** (was 1863 ms on 08-12). Split by provider across 72 turns: **groq 1121 ms p50 vs gateway 1793 ms** — a 672 ms gap, matching the ~600 ms estimate. ADR-109's `direct:groq/...` transport also executed for the first time, on call 11. | P2 |
| F7 | **Insurance has zero workflow templates.** All 3 `workflow_templates` rows are `shopify-*`. The operator opened `/workflows` four times and got `templateCount: 0` every time — the only tenant on the platform, in the launch vertical, sees an empty page. | P2 |
| F8 | **Cross-vertical tool leakage.** Agent config 6 (`insurance-final-expense-qualifier`) has 13 tools enabled including `confirmCodOrder` and `offerCartRecoveryDiscount`. The template's own `default_tools` is 8. | P2 |
| F9 | Migration `0050` (ADR-114, `org_agent_configs.human_transfer_number`) was **not applied** at the time of the read — 51 files in repo, 50 rows in `drizzle.__drizzle_migrations` — so an agent-config save against prod would have failed. **Applied during this audit (2026-08-15), now 51/51.** `0049` was already applied (2026-08-13 11:06), correcting the earlier note that both were pending. | **P1 — resolved** |
| F10 | `flagGuardrailEvent`'s only production firing is a false positive: category `unauthorized-promise`, detail *"caller asked about plan details"*. The caller asking a question is not the agent making a promise. Meanwhile the two real unauthorized promises on this dataset (F1, F4) fired nothing. | P2 |

---

## 1. F1 (P0) — the gate removed the tool, not the promise

`resolveTransferCapability` (`handoff.ts:148`) returns `no-transfer-number` when the resolved
target is blank, and `filterTransferTool` then materializes the tool list without
`transferToHuman`. That code is correct and it ran.

What it does not touch is the persona, which is 11,677 characters of script ending in *"you get
that advisor on the line."* The model followed the script:

```
[1] caller: Yeah. That's perfect.
[1] agent : That's great to hear! Let me get you connected with a licensed advisor right now …
[1] agent : You're connected — the advisor will take great care of you. Thanks, Goodbye!
```

```
[9] caller: I will prefer to speak with them now.
[9] agent : I'm going to transfer you to a licensed advisor now. Please hold for just a moment.
[9] agent : transferToHuman{"reason": "final-expense qualified handoff"}
```

Call 9 is the cleanest evidence in the dataset: the model reached for a tool it had been denied
and, having no tool, said its name. `tool_calls` for call 9: **zero rows**.

Under ADR-081 the agent's entire permitted job is qualify-and-warm-transfer. On this
configuration the transfer is the one thing it cannot do, and it is the thing it claimed twice.

**The structural point:** capability gating that hides a tool from the model, while leaving the
persona free to describe the outcome that tool produces, converts a configuration gap into a
false statement to the caller. The gate needs a matching persona constraint injected at runtime
(a call-control block line: *"you cannot transfer on this call; offer a callback instead"*), not
just an absent tool.

## 2. F2/F3 (P0) — the persona rewrite shipped and the leak continued anyway

Three distinct leak dialects, all from `llama-3.3-70b-versatile`:

| Call | Date | Route | Shape |
|---|---|---|---|
| 8 | 08-13 | gateway | `<function=captureField({"field": "coverage_purpose", "valu…` |
| 9 | 08-13 | gateway | `<captureField{"field": "income_type", "value": "fixed income"}</captureField>` |
| 11 | 08-14 | direct groq | `<captureField={"field": "tobacco", "value": "no"})</captureField>` |
| 11 | 08-14 | direct groq | `<function name="flagGuardrailEvent" >{"category": …}` |

`eafc762` (2026-08-13 17:41 UTC) diagnosed calls 8/9 correctly and did two things: rewrote 8 of
9 personas to stop teaching call-literal syntax, and added three regexes to
`TOOL_SYNTAX_PATTERNS`. Call 11 happened **23 hours later** and leaked 9 lines anyway.

**The persona half did ship — I got this wrong on the first pass and the correction matters.**
My initial read was that the rows were stale, on the evidence that every `created_at` is
2026-08-12 20:17. That is not a staleness signal: `agent_templates` has **no `updated_at`
column**, `seedAgentTemplates()` UPDATEs matching rows in place by `key` and never re-inserts,
so `created_at` is frozen at first insert regardless of how many times the content changed. And
the seeder is called unconditionally from `server.ts:59` on **every boot**, so a deploy is a
re-seed.

I then compared the actual bytes. `/tmp/personadiff.ts` pulls each row's
`default_persona_prompt` from production and diffs it against `extractRuntimePersona()` of the
corresponding `docs/agent-prompts/*.md` at HEAD `7f1d308`: **9 of 9 MATCH**, identical lengths
(`insurance-final-expense-qualifier` db=11677, file=11677). Production is serving the post-fix
persona. There is no data-source drift, and re-seeding is a verified no-op.

The one thing I cannot close without Railway: `eafc762` landed 2026-08-13 17:41 UTC, call 11 ran
2026-08-14 16:59 UTC, and the ADR-114 deploy went out ~17:44 the same day. If production did not
boot between those two commits, the rows could have been refreshed by the *later* deploy and
call 11 may still have run pre-fix text. The Railway token in the sandbox is dead
(`Not Authorized` on `backboard.railway.app/graphql/v2`), so the deployed SHA and its boot time
are unverified. Either way it does not rescue the fix — see below.

**The guard half is a pattern chase and it is losing.** Ran at HEAD `7f1d308` against the
literal strings from the transcripts:

```
LEAKS   "<captureField={\"field\": \"income_type\", \"value\": \"still working\"})</captureField>…"
LEAKS   "<function name=\"flagGuardrailEvent\" >{\"category\": \"unauthorized-promise\"…"
CAUGHT  "<captureField{…}</captureField>"          ← the 08-13 shape
CAUGHT  "transferToHuman{…}"                        ← the 08-13 shape
CAUGHT  "<function=captureField({…})"               ← the 08-13 shape
```

`/<\/?function(?:=[^>]*)?>/` requires `=` after `function`; call 11 wrote ` name="…" >`.
`/<(\w+)\{[^{}]*\}<\/\1>/` requires `<name{`; call 11 wrote `<name={`. Every added regex fits
the last leak exactly and the next one arrives in a new dialect within a day. Three dialects in
two days is the signal: **the scrubber cannot be the primary defense.** The primary defense is
not asking a 70B open model to drive 13 tools from an 11.7k-character prompt.

The persona finding above sharpens this rather than softening it. The prompt-side fix is in the
database, verified byte-for-byte, and the model still emitted 9 literal-syntax lines on call 11.
Telling `llama-3.3-70b-versatile` more clearly not to speak tool syntax is not a control. Both
levers pulled on 08-13 were prompt-and-regex; neither changes the thing actually producing the
output.

Worth stating plainly: the model that produced clean structured tool calls on calls 1–3 was
whatever the gateway default resolves to (`/api/health` reports
`gateway/google/gemini-3.1-flash-lite`). Every leaking and every empty turn is on
`llama-3.3-70b-versatile`, pinned at the agent level on config 6. That is a one-field change to
test.

## 3. F5 (P1) — "I didn't quite catch that" is not about hearing

`FALLBACK_REPLY` is emitted from exactly two places (`agent.ts:1469`, `:1479`): the model
returned no spoken text, or the turn exceeded its own timeout. Neither is an STT failure. The
caller's words are in the transcript table — they were heard, transcribed and stored.

| Call | Agent lines | Fallback | Literal tool syntax |
|---|---|---|---|
| 1–3 | 16 | 0 | 0 |
| 4 | 6 | 3 | 0 |
| 5 | 7 | 4 | 0 |
| 6 | 4 | 2 | 0 |
| 7 | 2 | 2 | 0 |
| 8 | 6 | 0 | 3 |
| 9 | 11 | 1 | 6 |
| 10 | 3 | 3 | 0 |
| 11 | 13 | 0 | 9 |

Calls 1–3 are clean and used the appointment-setter / post-sale / renewal personas. Everything
from call 4 onward is `insurance-final-expense-qualifier` — the longest persona (11,677 chars)
with the most tools. The defect tracks the **persona**, not the provider, not the feature flags
(those were flipped at 18:21 UTC on 08-13, after every 08-13 call).

Calls 7 and 10 are the worst case: the *greeting* turn produced nothing, so the very first
thing two callers heard was the agent asking them to repeat themselves before it had said
anything.

```
[10] agent : Sorry, I didn't quite catch that — could you say that again?
[10] caller: Hello?
[10] agent : Sorry, I didn't quite catch that — could you say that again?
```

Two changes are separable here. The wording should not blame the caller for a model failure
(*"Give me one second"* is honest and buys the same time). And an empty greeting turn should
retry once, or fall back to the template's stored `greeting_line`, before speaking a
clarification request into silence.

## 4. F6 (P2) — the one thing that got better

`turn_latency`, 72 turns, all calls:

| Route | Turns | v2v p50 | v2v p90 | LLM TTFT p50 | TTS first byte p50 |
|---|---|---|---|---|---|
| gateway | 37 | 1793 ms | 2234 ms | 1395 ms | 414 ms |
| **groq (direct)** | **35** | **1122 ms** | 1868 ms | **628 ms** | 433 ms |
| combined | 72 | 1591 ms | 2050 ms | 1150 ms | 420 ms |

Combined p50 is 1591 ms against 1863 ms on 2026-08-12. The entire delta, and more, is LLM TTFT:
Groq direct is **767 ms faster to first token** than the gateway. STT connect is 540–800 ms and
TTS first byte is flat at ~420 ms across both — neither is the bottleneck.

Caveat this honestly: not a randomized A/B. Different calls, different times, different turn
content, n=35/37 turns across 11 calls, one org, one route (US→IN). It is directionally strong
and consistent with the earlier decomposition, and it is not a controlled experiment.

Also resolved: `llm_fallback_models = ["direct:groq/llama-3.3-70b-versatile"]` was set on config
6 at 16:59:16, sixteen seconds before call 11 started. ADR-109's direct transport had never
executed in production before that call. It executed, after 2 provider failovers
(`health_status: degraded`), and delivered 705 ms TTFT. The path works.

## 5. Production state, for the record

| | |
|---|---|
| orgs | 1 — `good insurance`, vertical `insurance`, `human_transfer_number` **NULL**, `plan_name` NULL, `country_code` NULL, `timezone` NULL, twilio_mode `platform`, `calling_window_test_mode_until` **2026-08-15T16:56Z** (expires tomorrow) |
| org_phone_numbers | 1 — `+16087090565`, twilio, active, `number_series` NULL, `source` NULL |
| org_agent_configs | 6, all `enabled`; only id 6 configured (groq / llama-3.3-70b-versatile / deepgram / cartesia / 13 tools) |
| calls | 11, all outbound, all `completed`, 2 `degraded`, 3 with a disposition |
| transcripts / turn_latency / tool_calls | 125 / 72 / 16 |
| leads | 2 — both `name` NULL, `fields` `{}` |
| caller_memory | 1 row, 1 fact |
| guardrail_events | 1 (false positive, F10) |
| insurance_advisors / do_not_call / consent_records / scheduled_calls / org_integrations | **0** |
| feature flags on | backchannels, hybrid-audio-cache, adaptive-noise-filter (all 08-13 18:21) |
| spend | 76.66¢ / 15.9 min ≈ 4.8¢ per minute |

ADR-098's producer-licensing gate remains allow-and-warn with `insurance_advisors` empty. It
did not matter on this dataset — every call dialed `+91`, so no US solicitation occurred — and
it matters on the first real US call.

---

## 6. What I would do, in order

1. **Stop the false transfer promise (F1).** Two options, both cheap: set
   `orgs.human_transfer_number` so the claim becomes true, or inject a "no transfer available on
   this call" line into the call-control block whenever `resolveTransferCapability` returns
   `no-transfer-number`. The second is the real fix; the first unblocks a demo. Do not ship a
   pilot with neither.
2. **Test the model swap before adding a fourth regex (F2).** Point config 6 at the gateway
   default that produced clean tool calls on calls 1–3 and place three calls on the
   final-expense persona. If the leaks stop, the answer was never the scrubber. This is now the
   only untried lever on F2 — prompt and regex have both been pulled and both failed.
3. **Get a working Railway token and record the deployed SHA + boot time (F3).** Not to rescue
   the persona theory, which is closed, but because "what commit is actually serving traffic"
   should not be unanswerable. A `/api/health` field carrying the build SHA would close it
   permanently.
4. **Reword `FALLBACK_REPLY` and retry the greeting turn (F5).**
5. **Cut config 6's tool list from 13 to the template's 8 (F8)** — and separately decide whether
   an 11.7k-character persona is defensible at all for a 70B model driving tools.

Closed during this audit: migration `0050` (F9) was applied to production after a full backup
(`weeber-full-backup-pre-0050-20260815.json`, 196,709 bytes). `drizzle.__drizzle_migrations`
went 50 → 51, `org_agent_configs.human_transfer_number` exists as nullable `text`, all 6 rows
still present with no override set. `0049` had already been applied 2026-08-13.

Re-seeding `agent_templates` was authorized but is a **no-op** — the rows already match the
files, and the seeder runs on every boot regardless. Not executed. No Railway change was made;
the token is dead. No code change. Everything else here is findings only.

---

# Addendum — 2026-08-15: the step change inside call 11

Written after the body above was committed (`7c5cfb4`). ADR-078: this is a new dated entry, not
an edit to the paragraphs above. It **corrects two conclusions in section 3 and section 5** and
supersedes remediation item 2. Everything here is per-turn data from `turn_latency`,
`tool_calls`, and `transcripts` on call 11 — one call, one persona, one provider.

## The observation the body missed

Audit 17 counted leaks per call. Counting them **per turn** shows call 11 is not a leaky call.
It is a clean call followed by a broken one, with a hard boundary:

| turn | at | TTFT | real tool row? | leaked syntax? |
|---|---|---|---|---|
| 0 | 16:59:37 | 705 ms | — | no |
| 1 | 16:59:48 | 463 ms | — | no |
| 2 | 17:00:06 | **3194 ms** | ✅ `captureField` 17:00:02 | no |
| 3 | 17:00:25 | **3862 ms** | ✅ `flagGuardrailEvent`, `setIntent`, `captureField` 17:00:21–22 | no |
| 4 | 17:00:44 | 1025 ms | ✗ | **yes** |
| 5–12 | 17:01:04 → 17:03:47 | 495–681 ms | ✗ (zero rows after 17:00:22) | **yes, every turn** |

Nine agent turns after 17:00:41. Nine leaks. Zero tool executions. Before it: four tool
executions, zero leaks. The persona did not change at 17:00:41. The provider did not change. The
org config did not change. **A constant cannot explain a step change**, which is the problem with
the body's conclusion that the defect "tracks the persona, not the provider" — the persona is
equally present in the clean half of this call.

## Correction 1 — the provider latency comparison is confounded

Section 5 reported groq v2v p50 1122 ms against gateway 1793 ms and treated it as a provider
result. It is not. TTFT tracks **whether the turn executed a tool**, not who served it:

| call | provider | tool rows | leaks | p50 TTFT |
|---|---|---|---|---|
| 1 | gateway | 6 | 0 | 2357 ms |
| 2 | gateway | 4 | 0 | 1481 ms |
| 3 | gateway | 2 | 0 | 1237 ms |
| 4, 5 | groq | 0 | 0 | 876 / 547 ms |
| 8 | groq | 0 | 3 | 627 ms |
| 9 | gateway | 0 | 5 | 1384 ms |
| 11 | groq | 4 | 9 | 638 ms |

Every call that actually ran tools is slow. Every call that did not is fast. A real tool call is
two round trips — generate the call, execute, generate the reply — and the leak is one. The
cleanest control is inside call 11, where provider and persona are held constant: turns 2–3
(tools executed) average **3528 ms** TTFT, turns 4–12 (leaked) average **652 ms**.

Groq was not 672 ms faster. Groq was, on these calls, mostly not doing the work. Any decision to
flip the LLM primary to Groq on the strength of section 5's number should be considered
unsupported until a comparison is run where both arms execute the same tools.

## Correction 2 — `provider_failover_count` cannot be read as "the LLM switched"

Call 11 carries `provider_failover_count = 2`, and the obvious story — two mid-call model
switches, three dialects, hence the two distinct leak shapes (`<captureField={…})</captureField>`
until 17:01:34, then `<function name="…" >{…}` from 17:01:54) — is **not supported by the code**.
`recordProviderFailover()` has exactly two call sites: `stream.ts:1579` (TTS) and `stream.ts:2167`
(STT). No LLM path increments it. Those two events are audio-path failovers.

That is a finding in itself. `call-health.ts:191` degrades a call whenever the counter is
non-zero, under the name "provider failover" — while the provider whose failure would matter most
to a tool-driven conversation is the one never counted. LLM transport failover
(`resolveLlmTransportChain`, default-off behind `LLM_TRANSPORT_FAILOVER`) is invisible in the
call record, and no table records which model served which turn. So the question "did the model
change at 17:00:41?" is **unanswerable from production data**, not answered in the negative.

## What this leaves

The boundary is real, sharp, and unexplained. The candidates that survive:

1. **Context growth.** The boundary sits right after the first two tool round trips inflate the
   message history. A 70B model losing its tool-calling grammar as context grows is the
   hypothesis that best fits a step change partway through every affected call — and calls 8 and
   9 also start clean and degrade.
2. **A model or route change we cannot see**, per Correction 2.
3. **A parse failure on the tool-call channel** that falls through to content, which would show
   up in Railway logs and nowhere else.

None of the three is the persona, and none is the scrubber. Adding a fourth regex would catch
the two 17:00:41+ dialects and would not stop the tenth.

## Revised order of work

1. **Instrument before experimenting.** Record the transport + model per turn, and increment a
   counter on LLM failover the way STT and TTS already do. Without this the model-swap test in
   the body's item 2 produces a number nobody can attribute. This is the blocking item.
2. **Then** the model swap — and measure it on *tool-executing turns only*, or it will reproduce
   Correction 1's mistake.
3. Everything else in the body stands, F1 first: the agent is still promising a transfer it
   cannot perform. Note that F4 (the fabricated callback confirmation) and F10 (the false
   guardrail event) are now better read as **consequences** of the post-boundary state than as
   independent defects — the model emitted the call as text, nothing executed, and it then
   narrated the result as though something had.
