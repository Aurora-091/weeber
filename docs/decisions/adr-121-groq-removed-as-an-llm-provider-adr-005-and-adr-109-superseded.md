---
adr: 121
title: "Groq removed as an LLM provider — ADR-005 and ADR-109 superseded"
date: 2026-09-04
status: Accepted
---

## ADR-121 — Groq removed as an LLM provider — ADR-005 and ADR-109 superseded
**Date:** 2026-09-04
**Status:** Accepted — supersedes ADR-005, supersedes ADR-109

**Context:** ADR-005 (2026-07-04) added Groq as a second, directly-integrated LLM transport
(`@ai-sdk/groq`, `LLM_PROVIDER=groq`) for its lower inference latency. ADR-109 (2026-08-13) built on
that: because Groq was the platform's one non-gateway transport, it added a cross-transport failover
system (`voice/llm/transport-chain.ts` + `transport-stream.ts`, the `direct:groq/<model>` id scheme,
the `LLM_TRANSPORT_FAILOVER` flag, dark by default) so an outage in one transport never took the other
down with it.

The decision now is to drop Groq as a standalone, directly-integrated provider entirely. With Groq gone
there is no longer a second transport, so ADR-109's cross-transport machinery has nothing left to
chain across — keeping it would mean carrying a "chain" of one, plus the `direct:`/`gateway:` id-prefix
parser it existed to disambiguate, purely on the chance a future provider reintroduces the need. That
is treated as dead weight to remove now, not infrastructure to keep warm: it can be rebuilt against
whatever the next real second transport turns out to be, and a chain designed against an imagined
future provider is exactly the kind of premature generality this codebase avoids elsewhere.

**Correction to how "dark" this actually shipped:** ADR-109 said `LLM_TRANSPORT_FAILOVER` would ship
"default off, including in production." That was true on 2026-08-13 and stopped being true by
2026-09-02: a live incident (`llm_ttft_ms` spiking to 13s, p95 4.7s, traced to slow Vercel AI Gateway
responses on 2026-08-27) got `f1dd786` — a first-token timeout added to `transport-stream.ts` so a
merely-slow (never-throwing) link would still fail over — and confirmed via Railway that
`LLM_TRANSPORT_FAILOVER` is in fact **set in the production environment** (staging does not have the
var at all). So this removal is not deleting inert, always-off machinery; it is replacing a live
mitigation that was two days old at the time of this ADR. The first-token timeout itself is kept (see
below) specifically because of this — only the multi-transport chain it was bounding goes away.

**Decision:**

- `packages/api/src/voice/llm/index.ts`: `LlmProvider` narrows to `"gateway"`. `resolveLlmProvider`
  keeps its existing fail-open behavior — an unrecognized value (including a stale `"groq"` left in an
  old `org_agent_configs` row) warns and falls back to `"gateway"` rather than throwing, same as before.
  `GROQ_MODEL` and the Groq model instance are removed.
- `voice/llm/transport-chain.ts`, `transport-chain.test.ts`, and `transport-stream.ts` are deleted.
  `agent.ts` reverts to calling `streamText` directly with `buildGatewayProviderOptions` — the gateway's
  own native multi-model failover (`providerOptions.gateway.models`), which is exactly the pre-ADR-109
  behavior whenever `LLM_TRANSPORT_FAILOVER` was off.
- **The first-token timeout is kept, generalized to the single gateway call.** `agent.ts` now races the
  *first* chunk of `streamText`'s output against `FIRST_TOKEN_TIMEOUT_MS` (2.5s, unchanged) via a
  dedicated `AbortController` combined into the turn's abort signal; a timeout aborts that one call and
  returns `FALLBACK_REPLY` — the same bounded-wait guarantee `f1dd786` shipped, applied to one call
  instead of a sequence of links. This is **not** proven equivalent to prod's exact prior behavior,
  because `AI_GATEWAY_FALLBACK_MODELS`'s real production value was never confirmed (the open question
  in `KRISHNA-TASK-LIST.md` this ADR inherits): if that list is unqualified model ids (no `direct:`
  prefix), the old chain was executing each as a **separate 2.5s-bounded `streamText` call in sequence**
  (up to ~`links.length × 2.5s` worst case) rather than handing the list to the gateway's own internal
  multi-model fallback — trading that for a single call means the gateway's fallback models are now
  reached via `providerOptions.gateway.models` in one request, still bounded to one 2.5s window
  overall. Net effect: a materially **tighter** worst-case latency bound, at the cost of **less total
  time** for a fallback model to succeed before the turn gives up. Whether that trade is net-positive
  depends on data this ADR does not have — flagged, not resolved, here.
- `LLM_TRANSPORT_FAILOVER` and `GROQ_API_KEY`/`GROQ_MODEL` are dropped from `.env.example` and both
  Railway environments — the timeout above is now unconditional, matching what was already true in
  practice once the flag was turned on.
- **A `groq/<model>` string is still a valid value** anywhere an AI Gateway model id is accepted
  (`llmModel`, `llmFallbackModels`, `AI_GATEWAY_FALLBACK_MODELS`) — it means what it always meant
  outside ADR-109: "gateway, routed to Groq's compute". What's removed is the *direct*, non-gateway
  path and the `direct:`-prefix scheme ADR-109 invented to reach it. Any `direct:groq/...` or
  `gateway:...`-prefixed entry left over from ADR-109 being flipped on anywhere needs to be stripped
  back to a plain id before this ships, since the parser that understood that prefix no longer exists —
  see the removal PR's rollout checklist.
- The synthetic-caller test harness (`synthetic-scenarios.ts`'s `BOUNDARY_CALLER_MODEL`,
  `synthetic-test.ts`'s `SYNTHETIC_CALLER_PROVIDER`) used direct Groq for one specific reason: the
  platform's default gateway model refused the adversarial personas the ADR-081 boundary scenarios need,
  producing a vacuous pass. It now uses `{ provider: "gateway", model: "groq/llama-3.1-70b-versatile" }`
  instead — the identical underlying model, reached through the gateway, so the harness keeps the
  behavior it was built for without a direct `GROQ_API_KEY`.

**Consequences:**

- One fewer required-env-var branch in `config-check.ts`, one fewer dependency (`@ai-sdk/groq`), ~20
  fewer tests (all of them exercising the deleted transport-chain machinery), and the LLM-provider
  selector in both agent-config UIs (`dashboard/agents.tsx`, `app/agents.tsx`) drops to a single option.
- Confirmed via Railway (2026-09-04): `LLM_TRANSPORT_FAILOVER` and `GROQ_API_KEY` are present in
  **production**; `LLM_TRANSPORT_FAILOVER` is **absent** from staging entirely (`GROQ_API_KEY` and
  `LLM_PROVIDER` are present there too, consistent with `docs/brain/active-context.md`'s note that
  staging ran `LLM_PROVIDER=groq`). Values were not readable through the connected Railway app (names
  only), so **actual current values of `LLM_PROVIDER` and `AI_GATEWAY_FALLBACK_MODELS` in both
  environments must be read from the dashboard before this ships** — see the removal PR's rollout
  checklist. Staging's `LLM_PROVIDER` needs to move to `gateway`; prod's `AI_GATEWAY_FALLBACK_MODELS`
  needs checking for a stray `direct:`/`gateway:`-prefixed entry that the deleted parser would no
  longer understand.
- The reliability property ADR-109 was chasing — a bedrock-then-groq gateway routing order that failed
  ~4 of 10 streaming-tool requests — is not re-solved here. It reverts to being a live gateway-model-
  ordering risk, mitigated by whatever `AI_GATEWAY_FALLBACK_MODELS`/`llmFallbackModels` list is
  configured (native gateway fallback) plus the kept first-token timeout, rather than by cross-transport
  redundancy.
- `turn_latency.llm_provider_used` keeps recording the `provider/model` label via
  `getActiveModelLabel` (the pre-ADR-109 function, kept); it just never varies in `provider` anymore
  since there is only one.
