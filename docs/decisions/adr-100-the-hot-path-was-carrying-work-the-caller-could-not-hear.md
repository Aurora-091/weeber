---
adr: 100
title: The hot path was carrying work the caller could not hear
date: 2026-08-12
status: Accepted
supersedes: none
amends: ADR-087 (adds the second missing producer, on the same defect class), ADR-094 (records what the silent fallback actually costs; does not implement its tagless alternate line)
related: ADR-085, ADR-087, ADR-090, ADR-094, audit 13 P0
---

# ADR-100 — The hot path was carrying work the caller could not hear

## Status

**Accepted and implemented on 2026-08-12.** Four changes, all inside `packages/api/src/voice/`. No
schema change, no compliance change, no ratchet widened.

## Context

The question asked was "why do the calls feel slow." Before changing anything, the 11 calls that exist
in production were measured — `call_latency` (11 rows), `turn_latency` (78 rows, 44 with a complete
voice-to-voice measurement), 123 transcripts.

Measured baseline, production, all-time:

| metric | p50 | p90 | p95 | max |
| --- | --- | --- | --- | --- |
| `voice_to_voice_ms` | **1863** | 4180 | 4394 | 8173 |
| `llm_ms` | 1376 | — | 3826 | — |
| `tts_ms` | 1736 | — | 4267 | — |

`pickup_to_first_audio_ms` ranged 1770–2588ms across all 11 calls.

Two corrections to earlier readings of this same data, recorded here because both were wrong in a way
that would have sent the work in the wrong direction:

- **The numbers are not geographically poisoned.** `voiceToVoiceMs` is measured server-side from STT
  `speech_final` to the first TTS byte. Twilio's US-number-to-India-number leg sits outside both
  endpoints, so it inflates what the tester heard but not what the table recorded.
- **`tts_first_byte_ms` is cumulative from turn start, not the TTS stage alone.** Decomposing one
  representative turn (call 25, turn 18) with that in mind: pre-LLM 129ms (8%), **LLM TTFT 1136ms
  (71%)**, TTS 336ms (21%), total 1601ms.

So the dominant cost is model time-to-first-token, which is not something this batch can fix
honestly — it needs per-request gateway-vs-model timing that does not exist yet. What this batch is,
instead, is the set of costs that were being paid for nothing: work on the turn hot path whose result
no caller can hear, plus the two defects that were making a deterministic sentence unreachable.

The largest of those: **the literal-greeting fast path has never fired in production. 0 for 11.** Every
call ever placed paid a full LLM round-trip to produce an opening line that was already authored. The
cause is data, not code — 3 of the 4 rows in `leads` have `name = NULL` and `fields = {}`, so
`{{lead_name}}` cannot resolve, and the guard rejects the rendered string. That guard logged nothing,
which is why 11 calls went by without it being noticed.

## Decision

Four changes.

**1. The silent greeting fallback now says which tag was empty.** The guard tested the rendered
greeting for leftover `{{tags}}`, discarded it, and fell through to the LLM without a word. Knowing
*that* the fallback fired was never the hard part; knowing *which* tag had no value is, and it was
unrecoverable after the fact because the rendered string was thrown away. It now logs at `warn` with
the deduplicated tag names and the call SID, and states the cost in the message (`+~1.3s TTFT on
pickup`) so the line is self-explanatory to whoever greps it. This is a diagnostic, not ADR-094 — the
authored tagless alternate line ADR-094 calls for is still unbuilt, and this ADR does not claim
otherwise.

**2. `transcripts` INSERTs come off the turn hot path — chained, not fire-and-forget.** The caller's
final transcript was written with `await` between STT `speech_final` and the LLM request, so its full
round-trip sat inside the caller-perceived gap. In production that round-trip is cross-region: the API
runs on Railway Singapore, Postgres is Supabase `ap-south-1` (Mumbai). It buys the caller nothing —
the model is fed from the in-memory `history` array, never from this table, which exists for the
dashboard and the post-call record.

Pure fire-and-forget would have been wrong, and this is the part worth recording. Rows are read back
ordered by their identity column, so two un-awaited inserts racing would let a turn's agent line be
stored before the caller line it replies to — a transcript that reads as the agent answering a question
nobody asked yet. The writes are therefore chained through a single `transcriptWriteChain` promise:
order is preserved exactly, and the hot path only pays for appending to the chain. `finalizeCall`
drains the chain behind `Promise.race([chain, sleep(2000)])`, because a call that finalizes right after
its last turn (a `hangUp` tool call, or the caller hanging up mid-sentence) would otherwise lose
exactly the lines that explain why it ended — and because a slow drain must not block finalization.

**3. Merchant-typed greeting values are trimmed at the render site.** `org_agent_configs.name` and
`orgs.name` are free text and production already contains `"alice "` with a trailing space. Untrimmed
that renders "This is alice  calling from …", a doubled space the TTS provider can voice as an audible
stumble in the introduction. Trimmed where the value becomes speech, not on write: the bad rows
already exist, and this is the only place they are spoken. No prod-data mutation was performed.

**4. `{{interaction_type}}` gets a producer.** It is the same defect ADR-087 fixed for
`interest_area`: the tag appears in the NPS opener and in its audited Hindi and Hinglish translations
in `insurance-greetings.ts` and in `seed.ts`, and **nothing anywhere in `packages/api/src` could ever
supply a value** — verified by search, not assumption. It is added to the insurance intake schema and
given `interaction_type` / `interaction` CSV header aliases, following the `interest_area` precedent
exactly.

The alternative for (4) was rewording the spoken line to drop the tag. Rejected: the English wording
and its two audited translations all carry it, and rewording an audited spoken line in an insurance
script is a compliance review, not a latency fix. Giving the tag a producer is the cheaper and more
reversible half.

## Consequences

- One `warn` line per call whose greeting cannot resolve. At the current 0-for-11 rate that is every
  call, which is the point — it should be loud until the `leads` rows are fixed.
- Transcript rows can now land a few hundred ms after the turn that produced them. Anything that reads
  `transcripts` immediately after a turn (nothing does today) would need to tolerate that. Insert
  order is still guaranteed; row *visibility* is not immediate.
- Fixes (1) and (4) do not by themselves make the fast path fire. The lead data is still empty; this
  batch makes the failure visible and removes one of the two reasons it cannot succeed.
- `interaction_type` is spoken text supplied by the merchant. It must name the interaction and never a
  plan, carrier, or amount — ADR-081's boundary applies to it unchanged.

## What was deliberately not done

- **The LLM TTFT fat tail** (p50 1376ms → p95 3826ms). Needs per-request gateway-vs-model timing
  before anyone can say whether the tail is the gateway, the model, or the fallback chain. Guessing
  here would mean swapping a model on a hunch.
- **10 of 78 turns reserved a turn index and recorded no TTS first byte.** A real defect — a turn that
  started and produced no audio — but a separate one, with its own root cause to find.
- **Cartesia-vs-ElevenLabs first-byte comparison.** n=2 in the data. A hypothesis, not a finding.
- **Any write to production data** (the trailing space, the three empty `leads` rows). Not done
  without asking.
