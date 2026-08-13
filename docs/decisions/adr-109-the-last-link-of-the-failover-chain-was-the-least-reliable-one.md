# ADR-109 — The last link of the failover chain was the least reliable one

- **Date:** 2026-08-13
- **Status:** Accepted (implemented 2026-08-13, shipped dark behind `LLM_TRANSPORT_FAILOVER`, default off)

## Context

ADR-103 measured something on the way past and did not act on it: probing LLM transports
for the synthetic harness, gateway `groq/llama-3.3-70b-versatile` **failed 4 of 10
identical streaming-tool requests**. Not a capacity blip on one model — the gateway
attempts **bedrock first** (400, "doesn't support tool use in streaming mode") and only
then groq (503). This platform's workload is streaming with ~10 tools registered, so that
routing order is wrong for us on every request.

That slug is the **last link** of production's `AI_GATEWAY_FALLBACK_MODELS`. So the
declared failover chain's last resort is the least reliable link in it, which is the
inverse of what a chain is for. Direct Groq, probed in the same session, supported
streaming tool use on all four models tried.

There is a second, weaker observation: the gateway hop measured ~130 ms (334 ms vs 206 ms
median time-to-first-delta, same model both ways). It is **not** the justification here,
and saying why matters, because the temptation to lead with it is exactly the mistake
ADR-107 was written to correct. That measurement was taken from a dev sandbox, not from
Railway Singapore, and against ADR-107's corrected p50 decomposition (~127 ms dispatch /
1381 ms LLM / ~370 ms TTS) it is ~9% of LLM time. Shipping a transport decision on a
sandbox stopwatch would repeat the instrument error verbatim. The reliability case stands
without it.

`failover.ts` already chains STT and TTS across **providers** — Deepgram → ElevenLabs →
Sarvam — three vendors, so losing one leaves two. The obvious move was to copy that shape
for the LLM: a Groq-only chain of models. That is the wrong axis. A model chain protects
against one model being at capacity; it does not protect against Groq, or the hop to it,
being unreachable, which is the 503 actually observed.

## Decision

**Cross-transport failover: direct Groq primary, gateway as the last link.** The two
transports share no failure domain — direct Groq bypasses Vercel entirely, and the gateway
can reach models Groq does not serve — so each covers the other's outage rather than
duplicating it. Rejected alternatives are recorded below.

**Two new modules under `voice/llm/`, both pure:**

`transport-chain.ts` — `parseTransportId`, `formatTransportLink`,
`resolveLlmTransportChain`, `isTransportFailoverEnabled`.

`transport-stream.ts` — `streamWithTransportFailover`, an async generator that opens links
in order and yields the first one that produces output.

**The syntax is `direct:groq/<model>`, and the colon is the whole point.**
`groq/llama-3.3-70b-versatile` is **already a valid gateway model id** — it means "gateway,
routing to groq compute" — and it is literally the current value of production's
`AI_GATEWAY_FALLBACK_MODELS`. Reading a bare `groq/` prefix as direct-Groq would have
silently changed the meaning of a value already set in production: a redefinition with no
migration and no error, the failure mode this repo keeps writing ADRs about. A colon scheme
cannot collide with the gateway's `provider/model` namespace, so every id valid today keeps
its exact current meaning and only a newly-written `direct:` id opts in. `gateway:<id>` is
accepted as redundant-explicit. `direct:<provider>/<model>` where provider ≠ `groq` is
**dropped, not silently served by Groq** — Groq is the only transport with a direct path
wired (`createGroq` in `./index`), and being served by the wrong vendor is worse than being
dropped.

**Per-agent config reuses `org_agent_configs.llm_fallback_models`.** No new column, no
migration: same `jsonb` `string[]`, additive vocabulary, documented as a redefinition in the
schema comment. Unqualified entries behave exactly as they do today.

**The retry window closes at the first token.** Once a delta reaches `guard.push()` it has
gone to TTS and the caller has heard it; retrying then makes the agent say two things in one
turn. So a link that fails **before** its first delta is retried, and a link that fails
**after** rethrows. Mid-stream failover is deliberately not built — that is the boundary,
not a gap. Aborts (barge-in, our own timeout) never retry: the caller wants us to stop.

**Invariant: when the chain is non-empty, `providerOptions` must be `undefined`.** Every
link is one concrete model, so handing the same list to the gateway as well would retry it
at two layers and multiply one refusal by the turn's whole latency budget. `agent.ts`
therefore passes `chain.length > 0 ? undefined : buildGatewayProviderOptions(...)`, and
because that invariant lives at the call site rather than inside the module, a source-text
assertion guards it (precedent: `handoff.test.ts` for ADR-105).

**Latency is labelled with the link that actually spoke.** `formatActiveModelLabel` emits
the same `transport/model` shape as `getActiveModelLabel`, so `turn_latency.llm_provider_used`
stays comparable and no dashboard learns a second format. Booking a fallback's TTFT against
the primary would make the soak comparing the two transports measure nothing — ADR-107 again.

**Ships dark. `LLM_TRANSPORT_FAILOVER` defaults to off, including in production.** Flag off
⇒ empty chain ⇒ `providerOptions` exactly as before ⇒ the gateway keeps doing its own native
multi-model failover and this path is behaviourally unchanged. `resolveLlmTransportChain`
returning `[]` must be read as "leave the existing gateway-native path alone", not "no
fallbacks exist" — conflating those two states is how a feature ships half-on.

## Rejected

**A Groq-only model chain mirroring `failover.ts`.** Protects against per-model capacity,
not against the transport being unreachable — which is the 503 that prompted this. Copying
an existing shape because it exists is not a reason.

**Both axes at once** (transports × models). Multiplies the worst-case turn latency by the
product of two chain lengths for a failure mode not yet observed. The transport axis is the
one with evidence.

**A new `llm_transport_chain` column.** A migration to express a vocabulary the existing
column can already hold, on a table whose every other override is a fail-open `string[]`.

**Reading a bare `groq/` prefix as direct.** Rejected above at length: it silently
redefines a value already live in production.

**Mid-stream failover.** Costs the caller a duplicated utterance to save a turn. See the
retry-window boundary.

**Measuring from staging first, then shipping.** Ruled out because it is impossible today:
`/health` runs no LLM, and test-chat needs auth plus an org that no longer exists after the
DB wipe. Measuring would itself require shipping code. So the code ships dark and the soak
is the measurement.

## Consequences

- With the flag off, nothing changes anywhere. That is the point, and it is the only claim
  in this ADR verified against a running system.
- **The latency claim stays unverified.** No Railway-side number exists. The ~130 ms is a
  sandbox reading and must not be quoted as a production figure until the soak replaces it.
- The reliability claim is verified only for the *gateway* side (4/10 failures, measured
  2026-08-12). That direct Groq is more reliable *in production, from Singapore* is an
  expectation, not a measurement.
- `agent.ts`'s stream handle is now typed by inference off a `makeStream` factory rather than
  annotated `ReturnType<typeof streamText>` — the bare form resolves its `ToolSet` parameter
  to the empty default, which the concrete tool set is not assignable to.
- The empty-turn diagnostics now read an optional handle. If no link ever opened, the chain
  rethrows before reaching them, but a diagnostic must not be the thing that crashes a turn,
  so it degrades instead of asserting.
- api tests 1,287 → 1,307 (20 in `transport-chain.test.ts`, 17 of them on the two pure
  modules). Non-vacuity proven by deleting `if (produced) throw error;` from
  `transport-stream.ts`: 16 pass / 1 fail, exactly the retry-window test, then restored.
- **Known and unfixed:** enabling the flag on staging does not isolate anything, because
  staging and production still share ~33 of 40 env vars including `DATABASE_URL` and the
  Twilio account. A staging soak dials and writes against production data. That is a
  pre-existing accepted risk, but it bounds what this flag's staging rollout can tell us.
- Nothing here touches `packages/weeber-compliance`, the ADR-081 scope boundary, or the
  compliance chokepoint. A model that cannot be reached still refuses no gates.
