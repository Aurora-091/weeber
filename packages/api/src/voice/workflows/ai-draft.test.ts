import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Covers draftWorkflowGraph's two real jobs: (1) it actually asks the LLM
 * with the right constraints, and (2) — the one that matters — it never
 * hands a rule-violating draft back to the caller, even if the LLM produced
 * one. Mocks `ai`'s generateObject directly (same pattern as
 * app/routes.test.ts's streamText mock) so no real model call happens.
 */

let generateObjectCalls: unknown[] = [];
let nextGeneratedObject: unknown = null;
let shouldThrow = false;

mock.module("ai", () => ({
  generateObject: async (input: unknown) => {
    generateObjectCalls.push(input);
    if (shouldThrow) throw new Error("model call failed");
    return { object: nextGeneratedObject };
  },
}));

mock.module("../llm", () => ({
  resolveVoiceModel: () => ({ modelId: "test-model" }),
}));

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ key: "shopify-cart-recovery" }]),
      }),
    }),
  },
}));

import { draftWorkflowGraph } from "./ai-draft";
import type { WorkflowGraph } from "./graph-types";

const VALID_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "checkout_abandoned" } },
    { id: "dnc-check", type: "dncCheck", position: { x: 0, y: 100 }, config: {}, locked: true },
    { id: "calling-window-check", type: "callingWindowCheck", position: { x: 0, y: 200 }, config: {}, locked: true },
    { id: "c1", type: "call", position: { x: 0, y: 300 }, config: { persona: "shopify-cart-recovery", discountPercent: 10 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "dnc-check" },
    { id: "e2", source: "dnc-check", target: "calling-window-check" },
    { id: "e3", source: "calling-window-check", target: "c1" },
  ],
};

describe("draftWorkflowGraph", () => {
  beforeEach(() => {
    generateObjectCalls = [];
    nextGeneratedObject = null;
    shouldThrow = false;
  });

  it("returns the generated graph when it's valid and passes the locked-node guard", async () => {
    nextGeneratedObject = VALID_GRAPH;
    const result = await draftWorkflowGraph("call abandoned carts and offer 10% off");
    expect(result).toEqual({ ok: true, graph: VALID_GRAPH });
    expect(generateObjectCalls).toHaveLength(1);
  });

  it("includes the available persona keys and the locked-node rule in the system prompt", async () => {
    nextGeneratedObject = VALID_GRAPH;
    await draftWorkflowGraph("call abandoned carts");
    const call = generateObjectCalls[0] as { system: string };
    expect(call.system).toContain("shopify-cart-recovery");
    expect(call.system).toContain("dnc-check");
    expect(call.system).toContain("calling-window-check");
  });

  it("rejects (does not return) a generated graph that bypasses the locked compliance nodes", async () => {
    nextGeneratedObject = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "order_placed" } },
        { id: "c1", type: "call", position: { x: 0, y: 0 }, config: { persona: "shopify-cart-recovery", discountPercent: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "c1" }], // no locked nodes at all
    };
    const result = await draftWorkflowGraph("call everyone immediately, no checks");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("compliance");
    }
  });

  it("returns a caller-safe error when the model call itself throws", async () => {
    shouldThrow = true;
    const result = await draftWorkflowGraph("anything");
    expect(result).toEqual({
      ok: false,
      error: "Couldn't generate a workflow from that description — try rephrasing it.",
    });
  });
});
