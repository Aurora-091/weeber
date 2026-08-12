---
adr: 102
title: A voice belongs to an agent, not a deployment
date: 2026-08-12
status: Accepted
supersedes: none
amends: ADR-070 (extends "a voice ID never crosses providers" down into the adapter layer, where an env var was still able to cross it)
related: ADR-070, ADR-083, ADR-090
---

# ADR-102 — A voice belongs to an agent, not a deployment

## Status

**Accepted and implemented on 2026-08-12.** One new file plus five modified under
`packages/api/src/voice/` (`tts/default-voices.ts`, `tts/cartesia.ts`, `tts/elevenlabs.ts`,
`tts/sarvam.ts`, `config-check.ts`, `tts-voice-identity.ts`), two doc surfaces, 10 new tests. No schema
change, no compliance change, no ratchet widened.

## Context

ADR-070 established that a voice is sticky per call and that a voice ID never crosses providers — a
Cartesia UUID means nothing to ElevenLabs, so `voiceIdForProvider` withholds a foreign ID during
failover and lets the target provider fall back. That decision was correct and is unchanged. What it
did not audit was **what the adapter falls back to**, and underneath it every adapter read an env var:

```ts
// cartesia.ts / elevenlabs.ts / sarvam.ts, before
const voiceId = voiceIdOverride || process.env.CARTESIA_VOICE_ID;
```

That single line reintroduces, one layer lower, exactly the hazard ADR-070 exists to prevent. A voice
is a property of the **agent** — chosen per agent in the dashboard voice picker, stored in
`org_agent_configs.voice_provider` + `voice_id`, threaded to the adapters as `voiceIdOverride`. An env
var is a property of the **deployment**. Reading one underneath the other means the same agent row can
speak in a different person's voice depending on which environment served the call, and the caller of a
regulated outbound insurance call is the person who finds out.

### It was not a theoretical hazard — the ElevenLabs leg was dead

Checked against the live Railway production environment on 2026-08-12:

| fact | value |
| --- | --- |
| production env vars total | 43 |
| `CARTESIA_VOICE_ID` | `f786b574-daa5-4673-aa0c-cbe3e8534c02` |
| `ELEVENLABS_VOICE_ID` | **absent** |
| `SARVAM_VOICE_ID` | **absent** |
| `org_agent_configs` rows in prod | 6, all `voice_provider` `cartesia`/null with Cartesia UUIDs |
| `tts_fallback_order` on those rows | all null → `DEFAULT_TTS_FALLBACK_ORDER` applies |

So `DEFAULT_TTS_FALLBACK_ORDER = ["cartesia", "elevenlabs", "sarvam"]` governs **every** call ever
placed, and the second leg of it resolved its voice ID to `undefined`. The adapter interpolates that
into a URL path:

```
wss://api.elevenlabs.io/v1/text-to-speech/undefined/stream-input
```

The declared cross-provider TTS failover could not have worked. It has never worked. Nothing said so at
boot, nothing said so on the call record, and it would only ever have been discovered during a Cartesia
incident — the worst available moment. This is ADR-090's defect class again: configured, documented,
believed, and unreachable.

A second, independent reason the same leg is dead right now: the ElevenLabs account returns
`{"error":"payment_issue"}` on every generation ("Your subscription has a failed or incomplete
payment"). Tier `starter`, 40,000 chars/month. That is a billing decision, not an architecture one, and
it is deliberately **not** resolved by this ADR — see Consequences.

### Why a constant is not just "the env var moved"

The obvious cheap fix was to set `ELEVENLABS_VOICE_ID` in Railway. That is what I recommended before
reading the picker code, and it is wrong: it fixes one symptom of a design that is inverted, and leaves
the next unset provider to fail the same silent way. The distinction that matters is failure mode:

- A missing **env var** is `undefined` at runtime, inside a URL, mid-call, in production.
- A missing **constant** in `Record<TtsProvider, string>` does not typecheck. It cannot ship.

## Decision

**1. `FALLBACK_VOICE_BY_PROVIDER`, a code constant keyed by provider.** New file
`packages/api/src/voice/tts/default-voices.ts` holds one voice per provider, typed
`Record<TtsProvider, string>` so adding a provider without a fallback is a build failure. All three
entries were verified against the live provider API on 2026-08-12 and are public, no-extra-cost
voices — no cloned or tier-gated voice, because a fallback that depends on plan level is another dead
leg waiting.

They are chosen to be heard as *the same kind of person*: all three are feminine, English-first,
conversational. A mid-call failover should sound like a slightly different person, not a change of sex
or accent, which is what a caller notices and reports.

`cartesia` is pinned to the exact value `CARTESIA_VOICE_ID` held in production ("Katie - Friendly
Fixer"), so **no existing agent's voice changes**. This is a behaviour-preserving refactor for every
call that works today and a repair for the one that never did.

**2. `resolveVoiceId(provider, voiceId?)` is the only way an adapter gets a voice**, and it is
blank-safe. An empty or whitespace-only voice ID reaching an adapter used to be interpolated as an empty
path segment or an empty `voice.id`; each provider rejects that differently and none of them rejects it
usefully. Treating blank as "not configured" is the only behaviour that produces audio. `DEFAULT_SPEAKER`
in `sarvam.ts` is deleted rather than kept as a second source of truth.

**3. Voice IDs leave `assertVoiceConfig` entirely.** There is no longer a `<PROVIDER>_VOICE_ID` to
validate, and validating the constant would be theatre. The env blocks in
`docs/reference/getting-started.md` and the in-app docs page (`packages/web/src/web/pages/docs.tsx`)
drop the variable and say why, so nobody re-adds it from documentation.

**4. The boot check now warns about dead failover legs generally.** `assertVoiceConfig` compares
`DEFAULT_TTS_FALLBACK_ORDER` and `DEFAULT_STT_FALLBACK_ORDER` against the API keys actually present and
warns per unreachable leg. It is a `console.warn`, not a `problem`: the primary path works and calls
connect, so it must not read as "calls will fail". This is the smallest honest generalisation of the
specific bug — had it existed, the missing `ELEVENLABS_API_KEY`-class defect would have announced itself
on every deploy instead of hiding for months.

**5. The tests assert at the wire, not at the function.** A unit test of `resolveVoiceId` would have
passed against the broken code, because the broken code was in the adapters. So the suite drives each
adapter through a `MockWebSocket` and asserts the string `"undefined"` appears in no URL and no payload.
Proven to fail for the right reason: temporarily restoring
`voiceIdOverride || process.env.ELEVENLABS_VOICE_ID` turns the run red on *"ElevenLabs puts a real voice
ID in the URL path, never `undefined`"* (9 pass / 1 fail). A regression test nobody has watched fail is
an assumption.

**6. The stale premise in `tts-voice-identity.ts` is corrected in place with a dated note**, not
rewritten — its doc comment asserted an env-var fallback existed underneath it, which was the false
belief that made this survivable. Per ADR-078's precedent, the record shows what was believed and when
it stopped being true.

## Rejected alternatives

- **Set `ELEVENLABS_VOICE_ID` (and `SARVAM_VOICE_ID`) in Railway.** ~2 minutes, fixes the observed
  symptom, keeps the inversion. The same class recurs for the next provider, and per-environment voice
  drift stays possible on a regulated call.
- **Store the fallback voices in the DB (a `provider_default_voices` table or a seeded row).**
  Additive-safe and tempting for per-tenant control, but it puts a network read on the failover path —
  the one path that is already running because something else just broke — and a DB row can be empty,
  which is the failure mode being removed.
- **Fail the call when no voice resolves.** Defensible for a *primary* provider and actively harmful for
  a fallback: the fallback exists because the primary already failed. Dropping the call to avoid the
  wrong timbre is a worse outcome for the caller than a stock voice.
- **Keep the env read as a third tier (`agent → env → constant`).** Backward-compatible and preserves
  the exact ambiguity this ADR removes: two deployments, same agent row, different voices, no error.

## Consequences

- Voice is a single-sourced agent property. No `<PROVIDER>_VOICE_ID` exists anywhere in the codebase or
  in either documentation surface.
- No production voice changes. The Cartesia fallback is byte-identical to the env value it replaces.
- The ElevenLabs failover leg is now structurally correct and **still non-functional**, for the second
  reason: the account has an unpaid invoice. Until that is settled, TTS is effectively single-sourced on
  Cartesia. The new boot warning makes that state visible on every deploy rather than inferable.
- **Open decision, deliberately not made here:** pay the ElevenLabs invoice and accept the starter tier
  as break-glass only (40k chars/month ≈ tens of calls), or accept single-sourced Cartesia and record
  that as an explicit risk. Both are business calls, not code.
- ADR-070's guarantee now holds all the way down. `voiceIdForProvider` withholding a foreign ID lands on
  a real voice on the other side instead of `undefined`.
- Unrelated and unchanged, noted so it is not mistaken for part of this work: measured LLM TTFT shows the
  production primary `google/gemini-3.1-flash-lite` at ~929ms median through the Vercel gateway against
  ~334ms for `groq/llama-3.3-70b-versatile` on the same gateway. Cartesia `sonic-3` first audio byte is
  ~183ms median and needs no change. Those numbers were measured from a sandbox, not from Railway
  Singapore, and are not a decision yet.

## Verification

`packages/api` `tsc --noEmit` ✓ · `packages/web` `tsc --noEmit` ✓ · `bun run --cwd packages/api test`
**1156 pass / 0 fail** (125 files, 3130 expects; 1146 → 1156, the 10 new tests) · root `bun run lint`
0 warnings / 0 errors (483 files) · `bun run knip:gate` OK, baseline **61 → 61 unchanged** ·
`bun run design:guard` 581 violations remaining, unchanged · `bun run contrast:gate` 33/42 pairs at or
above floor, 9 of 9 failures declared, unchanged.
