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

/**
 * Two reads now happen inside `listAvailablePersonaKeys` (ADR-091): the org's
 * vertical (`.where(...).limit(1)`) and then the templates visible to that
 * org+vertical (`.where(...)` awaited directly). The mock distinguishes them by
 * which method the caller uses rather than by call order, so a future reorder
 * of the two reads doesn't silently swap the fixtures.
 */
let orgRows: unknown[] = [{ vertical: "shopify" }];
let templateRows: unknown[] = [{ key: "shopify-cart-recovery" }];

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          // A real promise with `.limit` attached (same shape as the other
          // route tests' db fakes) rather than a hand-rolled object with a
          // `then` — an object literal that's merely thenable is a footgun.
          const chain = Promise.resolve(templateRows) as Promise<unknown[]> & Record<string, unknown>;
          chain.limit = () => Promise.resolve(orgRows);
          return chain;
        },
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
    orgRows = [{ vertical: "shopify" }];
    templateRows = [{ key: "shopify-cart-recovery" }];
  });

  it("returns the generated graph when it's valid and passes the locked-node guard", async () => {
    nextGeneratedObject = VALID_GRAPH;
    const result = await draftWorkflowGraph("call abandoned carts and offer 10% off", "org_1");
    expect(result).toEqual({ ok: true, graph: VALID_GRAPH });
    expect(generateObjectCalls).toHaveLength(1);
  });

  it("includes the available persona keys and the locked-node rule in the system prompt", async () => {
    nextGeneratedObject = VALID_GRAPH;
    await draftWorkflowGraph("call abandoned carts", "org_1");
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
    const result = await draftWorkflowGraph("call everyone immediately, no checks", "org_1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("compliance");
    }
  });

  it("offers no persona keys at all when the org can't be resolved (fail closed, ADR-091)", async () => {
    // The persona list used to be every active template key in the table,
    // unscoped — a merchant's draft could name another tenant's private
    // template. With no resolvable org there is nothing this caller may see,
    // and the prompt must say so rather than fall back to the whole catalog.
    orgRows = [];
    nextGeneratedObject = VALID_GRAPH;
    await draftWorkflowGraph("call abandoned carts", "org_unknown");
    const call = generateObjectCalls[0] as { system: string };
    expect(call.system).toContain("no agents configured yet");
    expect(call.system).not.toContain("shopify-cart-recovery");
  });

  it("returns a caller-safe error when the model call itself throws", async () => {
    shouldThrow = true;
    const result = await draftWorkflowGraph("anything", "org_1");
    expect(result).toEqual({
      ok: false,
      error: "Couldn't generate a workflow from that description — try rephrasing it.",
    });
  });
});
