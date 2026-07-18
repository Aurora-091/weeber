/**
 * Workflow Canvas v4, Phase 1 (2026-07-18) — the locked compliance scaffold.
 * See docs/workflow-canvas/v4-locked-scaffold-ai-draft-and-flow-preview-plan.md §1.
 *
 * Two things live here:
 * 1. `buildBlankWorkflowScaffold()` — the starting graph a merchant gets when
 *    building a workflow from scratch (not forking a template). Never truly
 *    empty: it's seeded with locked `dncCheck`/`callingWindowCheck` nodes a
 *    merchant can see but can't delete, plus an unconfigured trigger and an
 *    unconfigured call node for them to fill in.
 * 2. `validateLockedNodesEnforced()` — the save-time guard. UI-level locking
 *    (disabling delete/disconnect on a `locked` node) is a client-side
 *    convenience, not a guarantee — a direct API call could still submit a
 *    graph that omits the locked nodes entirely, or wires around them. This
 *    function is the actual guarantee at the one point that matters: before
 *    a customGraph is ever persisted. It does NOT replace the real
 *    enforcement (scheduler.ts's dispatchScheduledCall already checks
 *    DNC/consent and the calling window before placing any call regardless
 *    of graph shape) — it exists so the *authoring* experience can't
 *    silently produce a graph that looks like it skips compliance, even
 *    though the engine would still enforce it underneath.
 */
import type { WorkflowGraph, WorkflowNode } from "./graph-types";

let scaffoldIdCounter = 0;
function nextScaffoldId(prefix: string): string {
  scaffoldIdCounter += 1;
  return `${prefix}-${scaffoldIdCounter}`;
}

/**
 * Builds a fresh blank-flow starting graph: trigger (unconfigured) -> locked
 * dncCheck -> locked callingWindowCheck -> call (unconfigured). A merchant
 * fills in the trigger event and the call's agent; they cannot remove or
 * reconfigure the two locked nodes in between. IDs are freshly generated per
 * call (not module-level singletons) so building two scaffolds in the same
 * process never collides.
 */
export function buildBlankWorkflowScaffold(): WorkflowGraph {
  const triggerId = nextScaffoldId("trigger");
  const dncId = nextScaffoldId("dnc-check");
  const windowId = nextScaffoldId("calling-window-check");
  const callId = nextScaffoldId("call");

  const nodes: WorkflowNode[] = [
    { id: triggerId, type: "trigger", position: { x: 0, y: 0 }, config: { event: "checkout_abandoned" } },
    { id: dncId, type: "dncCheck", position: { x: 0, y: 150 }, config: {}, locked: true },
    { id: windowId, type: "callingWindowCheck", position: { x: 0, y: 300 }, config: {}, locked: true },
    { id: callId, type: "call", position: { x: 0, y: 450 }, config: { persona: "", discountPercent: 0 } },
  ];

  const edges = [
    { id: nextScaffoldId("edge"), source: triggerId, target: dncId },
    { id: nextScaffoldId("edge"), source: dncId, target: windowId },
    { id: nextScaffoldId("edge"), source: windowId, target: callId },
  ];

  return { nodes, edges };
}

export type LockedNodeValidationResult =
  | { valid: true }
  | { valid: false; error: string };

/** Node types a compliance path must protect — anything that actually
 * places a call or sends an SMS. `addToDnc`/`webhook` don't contact the
 * customer directly (webhook is an outbound notification to the merchant's
 * own system, not the customer) so they're not gated here. */
const CUSTOMER_CONTACT_NODE_TYPES = new Set(["call", "sms"]);

/**
 * Confirms every `call`/`sms` node in the graph is only reachable from the
 * trigger through at least one locked node. Method: remove all locked
 * nodes (and edges touching them) from the graph, then BFS from the
 * trigger — if a customer-contact node is still reachable, a path exists
 * that bypasses every locked node, which is exactly the thing this
 * validator exists to catch. This deliberately doesn't require *every*
 * locked node type to appear on every path (a graph with just a dncCheck
 * and no callingWindowCheck node at all is a different, simpler problem —
 * "did the merchant delete a required node," covered by the presence check
 * below) — it's specifically a reachability-without-locked-nodes check.
 */
export function validateLockedNodesEnforced(graph: WorkflowGraph): LockedNodeValidationResult {
  const triggerNode = graph.nodes.find((n) => n.type === "trigger");
  if (!triggerNode) {
    return { valid: false, error: "Graph has no trigger node." };
  }

  const lockedIds = new Set(graph.nodes.filter((n) => n.locked).map((n) => n.id));
  const requiredLockedTypes: Array<"dncCheck" | "callingWindowCheck"> = ["dncCheck", "callingWindowCheck"];
  for (const requiredType of requiredLockedTypes) {
    const hasLockedNodeOfType = graph.nodes.some((n) => n.locked && n.type === requiredType);
    if (!hasLockedNodeOfType) {
      return { valid: false, error: `Graph is missing a required locked ${requiredType} node.` };
    }
  }

  const contactNodes = graph.nodes.filter((n) => CUSTOMER_CONTACT_NODE_TYPES.has(n.type));
  if (contactNodes.length === 0) {
    // Nothing that contacts a customer yet (e.g. a fresh, still-being-built
    // graph) — nothing to validate a bypass against.
    return { valid: true };
  }

  // BFS from the trigger using only edges that don't pass through a locked node.
  const reachableWithoutLocked = new Set<string>([triggerNode.id]);
  const queue = [triggerNode.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.source !== current) continue;
      if (lockedIds.has(edge.source) || lockedIds.has(edge.target)) continue; // can't pass through a locked node
      if (!reachableWithoutLocked.has(edge.target)) {
        reachableWithoutLocked.add(edge.target);
        queue.push(edge.target);
      }
    }
  }

  const bypassed = contactNodes.filter((n) => reachableWithoutLocked.has(n.id));
  if (bypassed.length > 0) {
    return {
      valid: false,
      error: `Node(s) ${bypassed.map((n) => n.id).join(", ")} can be reached without passing through the required compliance nodes.`,
    };
  }

  return { valid: true };
}
