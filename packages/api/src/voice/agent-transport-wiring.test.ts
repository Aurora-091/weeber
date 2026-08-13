import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTransportFailoverEnabled } from "./llm/transport-chain";

/**
 * ADR-109 — the wiring, not the logic.
 *
 * transport-chain.test.ts proves the chain resolves correctly and
 * transport-stream.test coverage proves the retry window closes at the first
 * token. Neither can prove agent.ts actually *calls* them: that is exactly the
 * defect class ADR-090 named — code written, documented, unit-tested, never
 * connected to a caller, which unit tests structurally hide.
 *
 * So this file asserts against agent.ts's source text. Blunt, but it is the only
 * check that fails when someone reverts the turn loop to a bare `streamText`
 * call or re-adds the nested gateway model list.
 */
describe("ADR-109 is wired into the live turn loop", () => {
  const agentSource = readFileSync(join(import.meta.dir, "agent.ts"), "utf8");

  test("the turn streams through the transport chain, not a bare streamText handle", () => {
    expect(agentSource).toContain("resolveLlmTransportChain({");
    expect(agentSource).toContain("streamWithTransportFailover<string>({");
    expect(agentSource).toContain("for await (const delta of textStream)");
  });

  /**
   * The invariant. Every link in the chain is one concrete model, so passing the
   * same fallback list to the gateway as well retries it at two layers and
   * multiplies one refusal by the whole turn's latency budget. Flag off ⇒ empty
   * chain ⇒ the pre-ADR gateway-native path, byte for byte.
   */
  test("failover runs at exactly one layer", () => {
    expect(agentSource).toContain(
      "chain.length > 0 ? undefined : buildGatewayProviderOptions(llmProvider, llmFallbackModels)",
    );
  });

  /**
   * ADR-107's lesson: a reading attributed to the wrong stage is worse than no
   * reading. If a fallback link speaks, its TTFT must not be booked against the
   * primary — otherwise the soak comparing the two transports measures nothing.
   */
  test("latency and diagnostics name the link that actually produced output", () => {
    expect(agentSource).not.toContain("getActiveModelLabel(");
    // TTFT callback (inline, inside the streaming loop) + the one
    // post-loop `activeModelLabel` assignment shared by the guard-findings
    // warning, onUsage, and empty-turn diagnostics (2026-08-14: collapsed
    // from three separate calls into one shared const when onUsage was
    // added, so this count did not grow with the new consumer).
    expect(agentSource.split("formatActiveModelLabel(activeLink)").length - 1).toBe(2);
  });

  test("the flag is off unless explicitly enabled", () => {
    const previous = process.env.LLM_TRANSPORT_FAILOVER;
    try {
      delete process.env.LLM_TRANSPORT_FAILOVER;
      expect(isTransportFailoverEnabled()).toBe(false);
      process.env.LLM_TRANSPORT_FAILOVER = "true";
      expect(isTransportFailoverEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LLM_TRANSPORT_FAILOVER;
      else process.env.LLM_TRANSPORT_FAILOVER = previous;
    }
  });
});
