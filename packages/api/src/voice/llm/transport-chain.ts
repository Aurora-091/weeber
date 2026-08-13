import type { LlmProvider } from "./index";

/**
 * ADR-109 — cross-TRANSPORT LLM failover.
 *
 * `failover.ts` chains across *providers* (Deepgram -> ElevenLabs -> Sarvam):
 * three different vendors, so losing one leaves the other two. This module is
 * deliberately NOT a copy of that shape, because the LLM axis that actually
 * broke is a different one.
 *
 * What broke: production's `AI_GATEWAY_FALLBACK_MODELS` ends in
 * `groq/llama-3.3-70b-versatile`, and that link failed 4 of 10 identical
 * streaming-tool requests (measured 2026-08-12) because gateway routing attempts
 * **bedrock first** (400, "doesn't support tool use in streaming mode") before
 * groq (503). The tail of the declared failover chain is ~40% broken for this
 * platform's own 10-tool streaming workload — so the chain's last resort is the
 * least reliable link in it, which is the inverse of what a chain is for.
 *
 * A Groq-only model chain would not fix that: it protects against one model
 * being at capacity, not against Groq (or the hop to it) being unreachable,
 * which is exactly the 503 observed. So the topology here is cross-transport —
 * direct Groq primary, **gateway as the last link** — because the two
 * transports share no failure domain: direct Groq bypasses Vercel entirely,
 * and the gateway can reach models Groq does not serve.
 *
 * Latency is the secondary benefit, deliberately not the headline. The
 * gateway hop measured ~130ms (334ms vs 206ms median time-to-first-delta,
 * same model both ways) but that was measured from a dev sandbox, not from
 * Railway Singapore. Against ADR-107's corrected p50 decomposition
 * (~127ms dispatch / 1381ms LLM / ~370ms TTS) it is ~9% of LLM time, and
 * shipping a transport on a sandbox measurement would repeat the exact
 * instrument error ADR-107 was written to correct. The reliability case
 * stands on its own; the latency claim stays unverified until the soak
 * produces Railway-side numbers.
 */

/** One link in the chain: which transport, and which model on it. */
export type LlmTransportLink = { transport: LlmProvider; model: string };

/**
 * The prefix that means "talk to this provider directly, not through the
 * gateway".
 *
 * This is the whole reason the syntax is `direct:groq/<model>` and not the
 * more obvious `groq/<model>`: **`groq/llama-3.3-70b-versatile` is already a
 * valid *gateway* model id today**, and it is literally the current value of
 * production's `AI_GATEWAY_FALLBACK_MODELS`, where it means "gateway, routing
 * to groq compute". Reading a bare `groq/` prefix as direct-Groq would
 * silently change the meaning of a value already set in production — a
 * redefinition with no migration and no error, which is the failure mode this
 * repo keeps writing ADRs about.
 *
 * A colon scheme cannot collide with the gateway's `provider/model` namespace,
 * so every id that is valid today keeps its exact current meaning and only a
 * newly-written `direct:` id opts into the new behaviour.
 */
const DIRECT_PREFIX = "direct:";
/** Accepted but redundant — an unqualified id already means gateway. */
const GATEWAY_PREFIX = "gateway:";

/**
 * Parses one entry of `AI_GATEWAY_FALLBACK_MODELS` / an agent's
 * `llm_fallback_models` into a transport + model.
 *
 * Back-compatible by construction: anything without a recognized scheme is a
 * gateway model id, verbatim, which is precisely what every existing value
 * means today. Returns null only for input with no model left after the
 * scheme, so a typo like `direct:` alone is dropped rather than becoming a
 * request for a model named "".
 */
export function parseTransportId(raw: string): LlmTransportLink | null {
  const id = raw.trim();
  if (!id) return null;
  if (id.startsWith(DIRECT_PREFIX)) {
    const rest = id.slice(DIRECT_PREFIX.length).trim();
    if (!rest) return null;
    // `direct:groq/llama-3.3-70b-versatile` and `direct:llama-3.3-70b-versatile`
    // both mean the same thing: Groq is the only transport with a direct path
    // wired today (createGroq in ./index), so the provider segment is optional
    // and, when present, must be groq — a `direct:openai/...` would otherwise
    // be silently served by Groq, which is worse than being dropped.
    const slash = rest.indexOf("/");
    if (slash === -1) return { transport: "groq", model: rest };
    const provider = rest.slice(0, slash);
    const model = rest.slice(slash + 1).trim();
    if (!model) return null;
    if (provider !== "groq") return null;
    return { transport: "groq", model };
  }
  if (id.startsWith(GATEWAY_PREFIX)) {
    const rest = id.slice(GATEWAY_PREFIX.length).trim();
    if (!rest) return null;
    return { transport: "gateway", model: rest };
  }
  return { transport: "gateway", model: id };
}

/** Stable identity for dedup and for logging a link without leaking a key. */
export function formatTransportLink(link: LlmTransportLink): string {
  return link.transport === "groq" ? `${DIRECT_PREFIX}groq/${link.model}` : link.model;
}

/**
 * Is this platform allowed to execute the fallback chain itself?
 *
 * Default **off**. With the flag off, `resolveLlmTransportChain` returns an
 * empty chain and every existing path behaves byte-identically to before this
 * ADR — the gateway keeps doing its own native multi-model failover via
 * `providerOptions.gateway.models` (`buildGatewayProviderOptions`). The flag is
 * the whole safety story: this ships dark, and the soak decides.
 */
export function isTransportFailoverEnabled(): boolean {
  return (process.env.LLM_TRANSPORT_FAILOVER ?? "").toLowerCase() === "true";
}

/**
 * The ordered list of links to try after `primary` fails at request time.
 *
 * Returns an EMPTY array when the flag is off, which callers must read as
 * "leave the existing gateway-native path alone" rather than "no fallbacks
 * exist" — the two are different states and conflating them is how a feature
 * ships half-on.
 *
 * INVARIANT (asserted in the tests): when this chain is non-empty, the caller
 * must NOT also pass `providerOptions.gateway.models`. Each gateway link here
 * is a single model, so the gateway does no nested failover of its own —
 * otherwise the same list would be retried at two layers and one refusal would
 * cost several multiples of the turn's latency budget.
 *
 * Fail-open on garbage, matching every other per-agent override in this
 * codebase: unparseable entries are dropped, the primary is filtered out even
 * if a caller lists it, and duplicates collapse.
 */
export function resolveLlmTransportChain(input: {
  primary: LlmTransportLink;
  /** Per-agent `llm_fallback_models` (org_agent_configs). */
  override?: readonly string[] | null;
  /** Platform default; defaults to AI_GATEWAY_FALLBACK_MODELS. */
  envValue?: string;
  /** Test seam. Defaults to the LLM_TRANSPORT_FAILOVER flag. */
  enabled?: boolean;
}): LlmTransportLink[] {
  const enabled = input.enabled ?? isTransportFailoverEnabled();
  if (!enabled) return [];
  const source =
    input.override && input.override.length > 0
      ? input.override
      : (input.envValue ?? process.env.AI_GATEWAY_FALLBACK_MODELS ?? "").split(",");
  const seen = new Set<string>([formatTransportLink(input.primary)]);
  const chain: LlmTransportLink[] = [];
  for (const candidate of source) {
    const link = parseTransportId(candidate);
    if (!link) continue;
    const key = formatTransportLink(link);
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(link);
  }
  return chain;
}
