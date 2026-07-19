import { describe, it, expect } from "bun:test";
import { walkForPreview } from "./preview-walker";
import type { WorkflowGraph } from "./graph-types";

/**
 * Workflow Canvas v4 Phase 3 — preview graph-walker.
 * The walker is pure and log-only: it must fast-forward non-call nodes (not
 * execute them), include locked compliance nodes in the walk, mark call nodes
 * as live handoff points, and follow the merchant's pre-picked branch.
 */

// A realistic cart-recovery-shaped graph:
// trigger -> dncCheck(locked) -> callingWindowCheck(locked) -> call -> split
//   split "no-answer" -> wait -> (back to call is a loop; here go to sms) sms -> end
//   split "interested" -> webhook -> end
//   split "not-interested" -> addToDnc -> end
function buildGraph(): WorkflowGraph {
  return {
    nodes: [
      { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "checkout_abandoned" } },
      { id: "dnc1", type: "dncCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
      { id: "cw1", type: "callingWindowCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
      { id: "c1", type: "call", position: { x: 0, y: 0 }, config: { persona: "cart-recovery", discountPercent: 10 } },
      { id: "s1", type: "conditionalSplit", position: { x: 0, y: 0 }, config: { outcomes: ["no-answer", "interested", "not-interested"] } },
      { id: "w1", type: "wait", position: { x: 0, y: 0 }, config: { delayMinutes: 45 } },
      { id: "sms1", type: "sms", position: { x: 0, y: 0 }, config: { template: "Hi {{customer_name}}, still {{cart_value}} in your cart!" } },
      { id: "wh1", type: "webhook", position: { x: 0, y: 0 }, config: { url: "https://example.com/hook" } },
      { id: "dnc2", type: "addToDnc", position: { x: 0, y: 0 }, config: { reason: "opted out" } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "dnc1" },
      { id: "e2", source: "dnc1", target: "cw1" },
      { id: "e3", source: "cw1", target: "c1" },
      { id: "e4", source: "c1", target: "s1" },
      { id: "e5", source: "s1", target: "w1", branch: "no-answer" },
      { id: "e6", source: "w1", target: "sms1" },
      { id: "e7", source: "s1", target: "wh1", branch: "interested" },
      { id: "e8", source: "s1", target: "dnc2", branch: "not-interested" },
    ],
  };
}

describe("walkForPreview", () => {
  it("includes locked compliance nodes in the walk as compliance steps", () => {
    const { steps, ok } = walkForPreview({ graph: buildGraph(), branchSelections: { s1: "interested" } });
    expect(ok).toBe(true);
    const compliance = steps.filter((s) => s.type === "compliance");
    expect(compliance.map((s) => s.nodeId)).toEqual(["dnc1", "cw1"]);
    expect(compliance.every((s) => s.locked)).toBe(true);
    expect(compliance[0].label).toContain("sandbox");
  });

  it("marks the call node as a live handoff point carrying its persona", () => {
    const { steps } = walkForPreview({ graph: buildGraph(), branchSelections: { s1: "interested" } });
    const call = steps.find((s) => s.type === "call");
    expect(call).toBeDefined();
    expect(call!.live).toBe(true);
    expect(call!.persona).toBe("cart-recovery");
  });

  it("fast-forwards non-call nodes as log lines, not execution", () => {
    const { steps } = walkForPreview({
      graph: buildGraph(),
      branchSelections: { s1: "no-answer" },
      context: { customer_name: "Asha", cart_value: 2400 },
    });
    const wait = steps.find((s) => s.type === "wait");
    expect(wait!.label).toContain("would wait 45 min");
    const sms = steps.find((s) => s.type === "sms");
    // template rendered with supplied context, but NOT sent
    expect(sms!.label).toContain("Asha");
    expect(sms!.label).toContain("2400");
    expect(sms!.label.toLowerCase()).toContain("would send");
  });

  it("follows the merchant's chosen branch at a conditionalSplit", () => {
    const interested = walkForPreview({ graph: buildGraph(), branchSelections: { s1: "interested" } });
    expect(interested.steps.some((s) => s.type === "webhook")).toBe(true);
    expect(interested.steps.some((s) => s.type === "addToDnc")).toBe(false);

    const notInterested = walkForPreview({ graph: buildGraph(), branchSelections: { s1: "not-interested" } });
    expect(notInterested.steps.some((s) => s.type === "addToDnc")).toBe(true);
    expect(notInterested.steps.some((s) => s.type === "webhook")).toBe(false);

    const branchStep = interested.steps.find((s) => s.type === "branch");
    expect(branchStep!.branchChosen).toBe("interested");
  });

  it("falls back to the default branch when no selection is given", () => {
    const g = buildGraph();
    g.edges.push({ id: "e9", source: "s1", target: "wh1", branch: "default" });
    const { steps } = walkForPreview({ graph: g }); // no branchSelections
    // first matching edge with branch "default" -> webhook
    const branchStep = steps.find((s) => s.type === "branch");
    expect(branchStep!.branchChosen).toBe("default");
  });

  it("ends the flow at a terminal node", () => {
    const { steps, ok } = walkForPreview({ graph: buildGraph(), branchSelections: { s1: "interested" } });
    expect(ok).toBe(true);
    expect(steps[steps.length - 1].type).toBe("end");
  });

  it("errors cleanly when there is no trigger", () => {
    const g: WorkflowGraph = { nodes: [{ id: "c1", type: "call", position: { x: 0, y: 0 }, config: { persona: "x", discountPercent: 0 } }], edges: [] };
    const { steps, ok } = walkForPreview({ graph: g });
    expect(ok).toBe(false);
    expect(steps[0].type).toBe("error");
    expect(steps[0].label).toContain("no trigger");
  });

  it("errors cleanly when an edge points to a missing node", () => {
    const g: WorkflowGraph = {
      nodes: [{ id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "order_placed" } }],
      edges: [{ id: "e1", source: "t1", target: "ghost" }],
    };
    const { steps, ok } = walkForPreview({ graph: g });
    expect(ok).toBe(false);
    expect(steps.some((s) => s.type === "error" && s.label.includes("ghost"))).toBe(true);
  });

  it("stops with an error on a graph that loops forever", () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, config: { event: "order_placed" } },
        { id: "cw1", type: "callingWindowCheck", position: { x: 0, y: 0 }, config: {}, locked: true },
      ],
      edges: [
        { id: "e1", source: "t1", target: "cw1" },
        { id: "e2", source: "cw1", target: "t1" }, // loop
      ],
    };
    const { ok, steps } = walkForPreview({ graph: g });
    expect(ok).toBe(false);
    expect(steps[steps.length - 1].label).toContain("loops");
  });
});
