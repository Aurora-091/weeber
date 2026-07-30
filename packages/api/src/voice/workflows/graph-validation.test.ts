import { describe, it, expect } from "bun:test";
import { validateWorkflowGraph, canActivate, hasStructuralErrors } from "./graph-validation";
import { buildBlankWorkflowScaffold } from "./scaffold";
import { CART_RECOVERY_GRAPH } from "./seed-graph";
import type { WorkflowGraph } from "./graph-types";

// Small helpers to build graphs tersely.
function graph(nodes: WorkflowGraph["nodes"], edges: WorkflowGraph["edges"]): WorkflowGraph {
  return { nodes, edges };
}
const trigger = (id = "t1") =>
  ({ id, type: "trigger" as const, position: { x: 0, y: 0 }, config: { event: "checkout_abandoned" as const } });
const call = (id: string, persona = "shopify-cart-recovery") =>
  ({ id, type: "call" as const, position: { x: 0, y: 0 }, config: { persona, discountPercent: 0 } });
const edge = (id: string, source: string, target: string, branch?: string) => ({ id, source, target, branch });

describe("validateWorkflowGraph — real seed + scaffold graphs", () => {
  it("the cart-recovery seed template has no errors or blockers", () => {
    const result = validateWorkflowGraph(CART_RECOVERY_GRAPH);
    expect(result.errors).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(canActivate(result)).toBe(true);
  });

  it("the blank scaffold has no structural errors but blocks activation (unconfigured call)", () => {
    const result = validateWorkflowGraph(buildBlankWorkflowScaffold());
    expect(hasStructuralErrors(result)).toBe(false);
    // The scaffold's call node ships with persona:"" — a draft-save is fine,
    // but it can't go live until an agent is picked.
    expect(result.blockers.map((i) => i.code)).toContain("call-empty-persona");
    expect(canActivate(result)).toBe(false);
  });
});

describe("validateWorkflowGraph — structural errors (always block)", () => {
  it("flags an edge to a nonexistent node", () => {
    const g = graph([trigger(), call("c1")], [edge("e1", "t1", "ghost")]);
    const result = validateWorkflowGraph(g);
    expect(result.errors.map((i) => i.code)).toContain("edge-missing-target");
    expect(hasStructuralErrors(result)).toBe(true);
  });

  it("flags a duplicate node id", () => {
    const g = graph([trigger("dup"), call("dup")], []);
    const result = validateWorkflowGraph(g);
    expect(result.errors.map((i) => i.code)).toContain("duplicate-node-id");
  });

  it("flags a self-looping edge", () => {
    const g = graph([trigger(), call("c1")], [edge("e1", "t1", "c1"), edge("e2", "c1", "c1")]);
    const result = validateWorkflowGraph(g);
    expect(result.errors.map((i) => i.code)).toContain("edge-self-loop");
  });

  it("flags a graph with no trigger", () => {
    const g = graph([call("c1")], []);
    const result = validateWorkflowGraph(g);
    expect(result.errors.map((i) => i.code)).toContain("no-trigger");
  });
});

describe("validateWorkflowGraph — completeness blockers (block activation only)", () => {
  it("flags a call node with an empty persona", () => {
    const g = graph([trigger(), call("c1", "")], [edge("e1", "t1", "c1")]);
    const result = validateWorkflowGraph(g);
    expect(result.errors).toEqual([]);
    expect(result.blockers.map((i) => i.code)).toContain("call-empty-persona");
    expect(canActivate(result)).toBe(false);
  });

  it("flags an sms node with no template", () => {
    const g = graph(
      [trigger(), { id: "s1", type: "sms", position: { x: 0, y: 0 }, config: { template: "  " } }],
      [edge("e1", "t1", "s1")],
    );
    const result = validateWorkflowGraph(g);
    expect(result.blockers.map((i) => i.code)).toContain("sms-empty-template");
  });

  it("flags a conditionalSplit with no default edge", () => {
    const g = graph(
      [
        trigger(),
        call("c1"),
        { id: "sp1", type: "conditionalSplit", position: { x: 0, y: 0 }, config: { outcomes: ["answered"] } },
        call("c2"),
      ],
      [edge("e1", "t1", "c1"), edge("e2", "c1", "sp1"), edge("e3", "sp1", "c2", "answered")],
    );
    const result = validateWorkflowGraph(g);
    expect(result.blockers.map((i) => i.code)).toContain("split-no-default");
  });

  it("flags a trigger with no outgoing path", () => {
    const g = graph([trigger()], []);
    const result = validateWorkflowGraph(g);
    expect(result.blockers.map((i) => i.code)).toContain("trigger-no-path");
  });

  it("flags a clearly malformed webhook url but tolerates a templated one", () => {
    const bad = graph(
      [trigger(), { id: "w1", type: "webhook", position: { x: 0, y: 0 }, config: { url: "not a url" } }],
      [edge("e1", "t1", "w1")],
    );
    expect(validateWorkflowGraph(bad).blockers.map((i) => i.code)).toContain("webhook-invalid-url");

    const templated = graph(
      [trigger(), { id: "w1", type: "webhook", position: { x: 0, y: 0 }, config: { url: "https://{{shop_name}}.example.com/hook" } }],
      [edge("e1", "t1", "w1")],
    );
    expect(validateWorkflowGraph(templated).blockers.map((i) => i.code)).not.toContain("webhook-invalid-url");
  });
});

describe("validateWorkflowGraph — warnings (never block)", () => {
  it("warns on a non-positive wait delay without blocking", () => {
    const g = graph(
      [trigger(), { id: "wt", type: "wait", position: { x: 0, y: 0 }, config: { delayMinutes: 0 } }, call("c1")],
      [edge("e1", "t1", "wt"), edge("e2", "wt", "c1")],
    );
    const result = validateWorkflowGraph(g);
    expect(result.warnings.map((i) => i.code)).toContain("wait-nonpositive-delay");
    expect(canActivate(result)).toBe(true);
  });

  it("warns on an unreachable node", () => {
    const g = graph(
      [trigger(), call("c1"), call("orphan")],
      [edge("e1", "t1", "c1")],
    );
    const result = validateWorkflowGraph(g);
    expect(result.warnings.map((i) => i.code)).toContain("unreachable-node");
    expect(result.warnings.find((i) => i.code === "unreachable-node")?.nodeId).toBe("orphan");
  });

  it("warns on multiple triggers and on extra edges from a linear node", () => {
    const g = graph(
      [trigger("t1"), trigger("t2"), call("c1"), call("c2")],
      [edge("e1", "t1", "c1"), edge("e2", "t1", "c2")],
    );
    const result = validateWorkflowGraph(g);
    expect(result.warnings.map((i) => i.code)).toContain("multiple-triggers");
    expect(result.warnings.map((i) => i.code)).toContain("linear-node-extra-edges");
    expect(result.errors).toEqual([]);
  });
});
