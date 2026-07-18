import { describe, it, expect } from "bun:test";
import { buildBlankWorkflowScaffold, validateLockedNodesEnforced } from "./scaffold";
import type { WorkflowGraph } from "./graph-types";

describe("buildBlankWorkflowScaffold", () => {
  it("produces a graph with a trigger, two locked compliance nodes, and a call node, in a valid chain", () => {
    const graph = buildBlankWorkflowScaffold();
    expect(graph.nodes.find((n) => n.type === "trigger")).toBeDefined();
    const dnc = graph.nodes.find((n) => n.type === "dncCheck");
    const window = graph.nodes.find((n) => n.type === "callingWindowCheck");
    expect(dnc?.locked).toBe(true);
    expect(window?.locked).toBe(true);
    expect(graph.nodes.find((n) => n.type === "call")).toBeDefined();
    // A freshly-built scaffold should always pass its own validator.
    expect(validateLockedNodesEnforced(graph)).toEqual({ valid: true });
  });

  it("generates fresh, non-colliding IDs across repeated calls", () => {
    const a = buildBlankWorkflowScaffold();
    const b = buildBlankWorkflowScaffold();
    // IDs are monotonically counter-based, not random, but must not be identical across two builds
    // used together (e.g. two orgs building a blank flow in the same process).
    expect(a.nodes.map((n) => n.id)).not.toEqual(b.nodes.map((n) => n.id));
  });
});

describe("validateLockedNodesEnforced", () => {
  function graphWith(overrides: Partial<WorkflowGraph>): WorkflowGraph {
    return { nodes: [], edges: [], ...overrides };
  }

  it("rejects a graph with no trigger node", () => {
    const result = validateLockedNodesEnforced(graphWith({ nodes: [] }));
    expect(result).toEqual({ valid: false, error: "Graph has no trigger node." });
  });

  it("rejects a graph missing a locked dncCheck node entirely", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "order_placed" } },
        { id: "w1", type: "callingWindowCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
        { id: "c1", type: "call", position: { x: 0, y: 0 }, config: { persona: "x", discountPercent: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "w1" },
        { id: "e2", source: "w1", target: "c1" },
      ],
    };
    const result = validateLockedNodesEnforced(graph);
    expect(result).toEqual({ valid: false, error: "Graph is missing a required locked dncCheck node." });
  });

  it("rejects a graph where a call node is reachable via a path that bypasses both locked nodes", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "order_placed" } },
        { id: "d1", type: "dncCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
        { id: "w1", type: "callingWindowCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
        { id: "c1", type: "call", position: { x: 0, y: 0 }, config: { persona: "x", discountPercent: 0 } },
        // Second, non-compliant branch straight from trigger to a call node.
        { id: "c2", type: "call", position: { x: 0, y: 0 }, config: { persona: "y", discountPercent: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "d1" },
        { id: "e2", source: "d1", target: "w1" },
        { id: "e3", source: "w1", target: "c1" },
        { id: "e4", source: "t1", target: "c2" }, // bypass
      ],
    };
    const result = validateLockedNodesEnforced(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("c2");
  });

  it("accepts a graph where every call/sms node is only reachable through both locked nodes", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "order_placed" } },
        { id: "d1", type: "dncCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
        { id: "w1", type: "callingWindowCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
        { id: "s1", type: "sms", position: { x: 0, y: 0 }, config: { template: "hi" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "d1" },
        { id: "e2", source: "d1", target: "w1" },
        { id: "e3", source: "w1", target: "s1" },
      ],
    };
    expect(validateLockedNodesEnforced(graph)).toEqual({ valid: true });
  });

  it("accepts a graph with no call/sms nodes yet (nothing to bypass)", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "order_placed" } },
        { id: "d1", type: "dncCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
        { id: "w1", type: "callingWindowCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
      ],
      edges: [
        { id: "e1", source: "t1", target: "d1" },
        { id: "e2", source: "d1", target: "w1" },
      ],
    };
    expect(validateLockedNodesEnforced(graph)).toEqual({ valid: true });
  });

  it("allows addToDnc/webhook nodes reachable without locked nodes — not customer-contact actions", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "order_placed" } },
        { id: "d1", type: "dncCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
        { id: "w1", type: "callingWindowCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
        { id: "wh1", type: "webhook", position: { x: 0, y: 0 }, config: { url: "https://example.com" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "wh1" }, // direct, no locked nodes — fine, webhook isn't a contact action
        { id: "e2", source: "t1", target: "d1" },
        { id: "e3", source: "d1", target: "w1" },
      ],
    };
    expect(validateLockedNodesEnforced(graph)).toEqual({ valid: true });
  });
});
