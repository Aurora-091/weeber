import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-121 — the wiring, not the logic, for the post-Groq-removal LLM call
 * shape. Replaces `agent-transport-wiring.test.ts` (deleted with ADR-109's
 * transport-chain machinery), which asserted the exact opposite of this file
 * on purpose: it existed to fail if the turn loop ever reverted to a bare
 * `streamText` call, and that revert is precisely what ADR-121 does
 * intentionally. Keeping the old file would have meant either deleting it
 * silently (losing the "someone changed the LLM call site, go read why"
 * signal ADR-090 named) or leaving it failing in the tree — so this file
 * takes its place, asserting the new invariants instead.
 *
 * Source-text, not behavioral, for the same reason ADR-109's version was:
 * a unit test can prove `streamWithTransportFailover` (or, now, the first-
 * token race) behaves correctly in isolation without proving `agent.ts`
 * actually calls it that way.
 */
describe("the LLM call site keeps its post-ADR-121 shape", () => {
  const agentSource = readFileSync(join(import.meta.dir, "agent.ts"), "utf8");

  test("providerOptions is unconditional — no transport chain toggling it off", () => {
    expect(agentSource).toContain("providerOptions: buildGatewayProviderOptions(llmProvider, llmFallbackModels)");
    // The ADR-109 invariant this replaces no longer applies — there is no
    // chain to make providerOptions conditional on.
    expect(agentSource).not.toContain("resolveLlmTransportChain");
    expect(agentSource).not.toContain("streamWithTransportFailover");
  });

  test("the first chunk is raced against FIRST_TOKEN_TIMEOUT_MS before the normal drain loop runs", () => {
    expect(agentSource).toContain("const firstTokenAbort = new AbortController();");
    expect(agentSource).toContain("wrapToolsWithInFlightCounter(");
    expect(agentSource).toContain("shouldAbortOnFirstTokenTimeout(toolsInFlight.started)");
    expect(agentSource).toContain("shouldSpeakEmptyTurnFallback(toolCallsThisTurn)");
    expect(agentSource).toContain("firstTokenAbort.abort();");
  });

  test("latency and diagnostics are labelled via getActiveModelLabel, not a per-link label", () => {
    expect(agentSource).toContain("getActiveModelLabel(llmProvider, llmModel)");
    expect(agentSource).not.toContain("formatActiveModelLabel");
  });
});
