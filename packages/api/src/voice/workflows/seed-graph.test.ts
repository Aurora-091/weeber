import { describe, it, expect } from "bun:test";
import {
  CART_RECOVERY_TEMPLATE,
  COD_CONFIRMATION_TEMPLATE,
  FEEDBACK_TEMPLATE,
  SHOPIFY_WORKFLOW_TEMPLATES,
} from "./seed-graph";
import { validateLockedNodesEnforced } from "./scaffold";
import type { WorkflowGraph } from "./graph-types";

/**
 * Structural invariants every seeded graph must hold. These are the same
 * guarantees the canvas + engine assume, so a broken seed can't ship silently.
 */
function assertGraphWellFormed(graph: WorkflowGraph) {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // No duplicate node ids.
  expect(nodeIds.size).toBe(graph.nodes.length);

  // Exactly one trigger.
  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  expect(triggers.length).toBe(1);

  // Every edge references real nodes.
  for (const e of graph.edges) {
    expect(nodeIds.has(e.source)).toBe(true);
    expect(nodeIds.has(e.target)).toBe(true);
  }

  // Every conditionalSplit outcome has a matching outgoing edge branch.
  for (const split of graph.nodes.filter((n) => n.type === "conditionalSplit")) {
    const outgoing = graph.edges.filter((e) => e.source === split.id);
    const branches = new Set(outgoing.map((e) => e.branch));
    const outcomes = (split.config as { outcomes: string[] }).outcomes;
    for (const outcome of outcomes) {
      expect(branches.has(outcome)).toBe(true);
    }
    // A default fallback branch is always wired so no disposition dead-ends.
    expect(branches.has("default")).toBe(true);
  }

  // No orphan nodes (every non-trigger node is an edge target).
  const targets = new Set(graph.edges.map((e) => e.target));
  for (const n of graph.nodes) {
    if (n.type === "trigger") continue;
    expect(targets.has(n.id)).toBe(true);
  }
}

describe("seed-graph templates", () => {
  it("exports all three shopify templates in gallery order", () => {
    expect(SHOPIFY_WORKFLOW_TEMPLATES.map((t) => t.id)).toEqual([
      CART_RECOVERY_TEMPLATE.id,
      COD_CONFIRMATION_TEMPLATE.id,
      FEEDBACK_TEMPLATE.id,
    ]);
    // All are shopify-vertical and have unique ids.
    const ids = new Set(SHOPIFY_WORKFLOW_TEMPLATES.map((t) => t.id));
    expect(ids.size).toBe(SHOPIFY_WORKFLOW_TEMPLATES.length);
    for (const t of SHOPIFY_WORKFLOW_TEMPLATES) {
      expect(t.vertical).toBe("shopify");
    }
  });

  describe("Cart Recovery", () => {
    const graph = CART_RECOVERY_TEMPLATE.graph;

    it("is triggered by checkout_abandoned", () => {
      const trigger = graph.nodes.find((n) => n.type === "trigger")!;
      expect((trigger.config as { event: string }).event).toBe("checkout_abandoned");
    });

    it("passes the locked-node compliance validator", () => {
      expect(validateLockedNodesEnforced(graph)).toEqual({ valid: true });
    });

    it("has locked dncCheck + callingWindowCheck nodes", () => {
      expect(graph.nodes.some((n) => n.type === "dncCheck" && n.locked)).toBe(true);
      expect(graph.nodes.some((n) => n.type === "callingWindowCheck" && n.locked)).toBe(true);
    });

    it("is structurally well-formed", () => {
      assertGraphWellFormed(graph);
    });
  });

  describe("COD Confirmation", () => {
    const graph = COD_CONFIRMATION_TEMPLATE.graph;

    it("is triggered by order_placed", () => {
      const trigger = graph.nodes.find((n) => n.type === "trigger")!;
      expect((trigger.config as { event: string }).event).toBe("order_placed");
    });

    it("passes the locked-node compliance validator", () => {
      expect(validateLockedNodesEnforced(graph)).toEqual({ valid: true });
    });

    it("has locked dncCheck + callingWindowCheck nodes", () => {
      expect(graph.nodes.some((n) => n.type === "dncCheck" && n.locked)).toBe(true);
      expect(graph.nodes.some((n) => n.type === "callingWindowCheck" && n.locked)).toBe(true);
    });

    it("is structurally well-formed", () => {
      assertGraphWellFormed(graph);
    });
  });

  describe("Post-Delivery Feedback", () => {
    const graph = FEEDBACK_TEMPLATE.graph;

    it("is triggered by order_fulfilled", () => {
      const trigger = graph.nodes.find((n) => n.type === "trigger")!;
      expect((trigger.config as { event: string }).event).toBe("order_fulfilled");
    });

    it("passes the locked-node compliance validator", () => {
      expect(validateLockedNodesEnforced(graph)).toEqual({ valid: true });
    });

    it("has locked dncCheck + callingWindowCheck nodes", () => {
      expect(graph.nodes.some((n) => n.type === "dncCheck" && n.locked)).toBe(true);
      expect(graph.nodes.some((n) => n.type === "callingWindowCheck" && n.locked)).toBe(true);
    });

    it("is structurally well-formed", () => {
      assertGraphWellFormed(graph);
    });
  });
});
