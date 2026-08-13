import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  formatTransportLink,
  parseTransportId,
  resolveLlmTransportChain,
  type LlmTransportLink,
} from "./transport-chain";
import { streamWithTransportFailover } from "./transport-stream";

const GATEWAY_PRIMARY: LlmTransportLink = { transport: "gateway", model: "google/gemini-3.1-flash-lite" };

describe("parseTransportId — the redefinition must not change any existing value", () => {
  it("reads production's current AI_GATEWAY_FALLBACK_MODELS with its ORIGINAL meaning", () => {
    // This is the exact value set on Railway production. `groq/...` here means
    // "gateway, routing to groq compute" and MUST keep meaning that — reading it
    // as direct-Groq would silently repoint production with no migration.
    const parsed = "openai/gpt-5.4-mini,groq/llama-3.3-70b-versatile"
      .split(",")
      .map((s) => parseTransportId(s));
    expect(parsed).toEqual([
      { transport: "gateway", model: "openai/gpt-5.4-mini" },
      { transport: "gateway", model: "groq/llama-3.3-70b-versatile" },
    ]);
  });

  it("only a direct: scheme opts into the new transport", () => {
    expect(parseTransportId("direct:groq/llama-3.3-70b-versatile")).toEqual({
      transport: "groq",
      model: "llama-3.3-70b-versatile",
    });
    expect(parseTransportId("direct:llama-3.3-70b-versatile")).toEqual({
      transport: "groq",
      model: "llama-3.3-70b-versatile",
    });
  });

  it("drops a direct: id for a provider that has no direct path, rather than serving it from Groq", () => {
    expect(parseTransportId("direct:openai/gpt-5.4-mini")).toBeNull();
  });

  it("drops schemes with no model instead of requesting a model named empty string", () => {
    expect(parseTransportId("direct:")).toBeNull();
    expect(parseTransportId("direct:groq/")).toBeNull();
    expect(parseTransportId("gateway:")).toBeNull();
    expect(parseTransportId("   ")).toBeNull();
  });

  it("accepts the redundant explicit gateway: scheme", () => {
    expect(parseTransportId("gateway:openai/gpt-5.4-mini")).toEqual({
      transport: "gateway",
      model: "openai/gpt-5.4-mini",
    });
  });
});

describe("resolveLlmTransportChain", () => {
  it("returns an EMPTY chain when the flag is off, so the gateway-native path is untouched", () => {
    expect(
      resolveLlmTransportChain({
        primary: GATEWAY_PRIMARY,
        envValue: "openai/gpt-5.4-mini,direct:groq/llama-3.3-70b-versatile",
        enabled: false,
      }),
    ).toEqual([]);
  });

  it("builds the cross-transport chain in order when enabled", () => {
    expect(
      resolveLlmTransportChain({
        primary: { transport: "groq", model: "llama-3.3-70b-versatile" },
        envValue: "openai/gpt-5.4-mini,google/gemini-3.1-flash-lite",
        enabled: true,
      }),
    ).toEqual([
      { transport: "gateway", model: "openai/gpt-5.4-mini" },
      { transport: "gateway", model: "google/gemini-3.1-flash-lite" },
    ]);
  });

  it("filters the primary out even when a caller lists it, and collapses duplicates", () => {
    const chain = resolveLlmTransportChain({
      primary: { transport: "groq", model: "llama-3.3-70b-versatile" },
      envValue: "direct:groq/llama-3.3-70b-versatile,openai/gpt-5.4-mini,openai/gpt-5.4-mini",
      enabled: true,
    });
    expect(chain).toEqual([{ transport: "gateway", model: "openai/gpt-5.4-mini" }]);
  });

  it("distinguishes the same model on two transports — they are different links", () => {
    const chain = resolveLlmTransportChain({
      primary: { transport: "groq", model: "llama-3.3-70b-versatile" },
      envValue: "groq/llama-3.3-70b-versatile",
      enabled: true,
    });
    // The gateway-routed copy is NOT the primary and must survive: it is a
    // different failure domain, which is the entire point of the topology.
    expect(chain).toEqual([{ transport: "gateway", model: "groq/llama-3.3-70b-versatile" }]);
  });

  it("per-agent override wins over the env default", () => {
    const chain = resolveLlmTransportChain({
      primary: GATEWAY_PRIMARY,
      override: ["direct:groq/llama-3.3-70b-versatile"],
      envValue: "openai/gpt-5.4-mini",
      enabled: true,
    });
    expect(chain).toEqual([{ transport: "groq", model: "llama-3.3-70b-versatile" }]);
  });

  it("fails open on garbage rather than throwing", () => {
    const chain = resolveLlmTransportChain({
      primary: GATEWAY_PRIMARY,
      envValue: ",,  ,direct:,openai/gpt-5.4-mini,",
      enabled: true,
    });
    expect(chain).toEqual([{ transport: "gateway", model: "openai/gpt-5.4-mini" }]);
  });

  it("every gateway link is a single model, so the caller must not ALSO nest gateway.models", () => {
    // Guards the stated invariant: if this chain is non-empty every entry is one
    // concrete model id with no comma-list smuggled inside it, so no link can
    // trigger a second layer of gateway-native failover.
    const chain = resolveLlmTransportChain({
      primary: GATEWAY_PRIMARY,
      envValue: "openai/gpt-5.4-mini,direct:groq/llama-3.3-70b-versatile",
      enabled: true,
    });
    expect(chain.length).toBeGreaterThan(0);
    for (const link of chain) expect(link.model).not.toContain(",");
  });
});

// A link that refuses at open time, before any delta: the pre-first-token
// window, the only window in which a retry is safe.
async function* fails(message: string): AsyncGenerator<string> {
  // The guard is what keeps oxlint's require-yield/no-unreachable pair happy:
  // a bare `throw` with a trailing yield is unreachable code, and a bare throw
  // with no yield is not a generator to the linter. Every caller passes a
  // non-empty message, so this always throws.
  if (message) throw new Error(message);
  yield message;
}
async function* emits(...chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}
async function* emitsThenFails(chunk: string, message: string): AsyncGenerator<string> {
  yield chunk;
  throw new Error(message);
}

describe("streamWithTransportFailover — the retry window closes at the first token", () => {
  const links: LlmTransportLink[] = [
    { transport: "groq", model: "llama-3.3-70b-versatile" },
    { transport: "gateway", model: "openai/gpt-5.4-mini" },
  ];

  it("fails over when the primary dies BEFORE producing anything", async () => {
    const tried: string[] = [];
    const out: string[] = [];
    for await (const chunk of streamWithTransportFailover<string>({
      links,
      open: (link) => {
        tried.push(formatTransportLink(link));
        return link.transport === "groq" ? fails("503 service unavailable") : emits("he", "llo");
      },
    })) {
      out.push(chunk);
    }
    expect(tried).toEqual(["direct:groq/llama-3.3-70b-versatile", "openai/gpt-5.4-mini"]);
    expect(out.join("")).toBe("hello");
  });

  it("does NOT fail over after a token was produced — the caller already heard it", async () => {
    const tried: string[] = [];
    const out: string[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of streamWithTransportFailover<string>({
        links,
        open: (link) => {
          tried.push(formatTransportLink(link));
          return link.transport === "groq"
            ? emitsThenFails("Sure, one ", "connection reset")
            : emits("completely different answer");
        },
      })) {
        out.push(chunk);
      }
    } catch (error) {
      thrown = error;
    }
    // The second link must never have been opened: speaking it would have made
    // the agent say two different things in one turn.
    expect(tried).toEqual(["direct:groq/llama-3.3-70b-versatile"]);
    expect(out.join("")).toBe("Sure, one ");
    expect((thrown as Error).message).toBe("connection reset");
  });

  it("never retries an aborted turn", async () => {
    const tried: string[] = [];
    let thrown: unknown;
    try {
      for await (const _chunk of streamWithTransportFailover<string>({
        links,
        open: (link) => {
          tried.push(formatTransportLink(link));
          return fails("aborted");
        },
        isAborted: () => true,
      })) {
        // no-op
      }
    } catch (error) {
      thrown = error;
    }
    expect(tried).toEqual(["direct:groq/llama-3.3-70b-versatile"]);
    expect((thrown as Error).message).toBe("aborted");
  });

  it("rethrows the LAST error when every link fails, rather than swallowing the turn", async () => {
    let thrown: unknown;
    try {
      for await (const _chunk of streamWithTransportFailover<string>({
        links,
        open: (link) => fails(`${link.transport} down`),
      })) {
        // no-op
      }
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("gateway down");
  });

  it("reports which link actually produced the output, for per-transport latency attribution", async () => {
    const resolved: string[] = [];
    for await (const _chunk of streamWithTransportFailover<string>({
      links,
      open: (link) => (link.transport === "groq" ? fails("503") : emits("ok")),
      onLinkResolved: (link) => resolved.push(formatTransportLink(link)),
    })) {
      // no-op
    }
    // Exactly once, and naming the link that spoke — not the one that was asked
    // first. ADR-107's lesson: a metric attributed to the wrong stage is worse
    // than no metric.
    expect(resolved).toEqual(["openai/gpt-5.4-mini"]);
  });
});

/**
 * The two-layer-failover invariant is not enforceable from inside this module —
 * it is a property of how agent.ts calls it. If someone "simplifies" that call
 * site by always passing providerOptions, the flag-on path retries the same
 * model list at two layers and one gateway refusal costs several multiples of
 * the turn's latency budget, silently. Asserting against the source text is
 * blunt (precedent: handoff.test.ts for ADR-105), but it is the only check that
 * fails when the call site drifts.
 */
describe("agent.ts wiring cannot re-enable failover at two layers", () => {
  const agentSource = readFileSync(join(import.meta.dir, "..", "agent.ts"), "utf8");

  it("passes providerOptions only when this module's chain is empty", () => {
    // Flag off => chain empty => the pre-ADR-109 gateway-native path, verbatim.
    // Flag on => chain non-empty => undefined, because every link is one
    // concrete model and the gateway must do no nested failover of its own.
    expect(agentSource).toContain(
      "chain.length > 0 ? undefined : buildGatewayProviderOptions(llmProvider, llmFallbackModels)",
    );
  });

  it("still derives the chain from the same primary link it streams first", () => {
    const primaryAt = agentSource.indexOf("resolvePrimaryTransportLink(llmProvider, llmModel)");
    const chainAt = agentSource.indexOf("resolveLlmTransportChain({ primary: primaryLink");
    expect(primaryAt).toBeGreaterThan(-1);
    expect(chainAt).toBeGreaterThan(primaryAt);
    expect(agentSource).toContain("const links = [primaryLink, ...chain];");
  });

  it("labels latency with the link that actually spoke, not the one asked first", () => {
    // Otherwise a fallback's TTFT is booked against the primary and the soak
    // comparing the two transports measures nothing (ADR-107).
    expect(agentSource).toContain("onLatency?.(firstTokenAt - turnStartedAt, formatActiveModelLabel(activeLink))");
    expect(agentSource).not.toContain("getActiveModelLabel(");
  });
});
