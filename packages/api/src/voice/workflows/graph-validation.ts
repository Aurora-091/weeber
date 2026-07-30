/**
 * Workflow Canvas — shared graph validation (2026-07-30, P1).
 *
 * Before this existed, graph validation was asymmetric: the *admin template*
 * save (admin-routes.ts) had its own `validateGraph` (trigger presence, edge
 * endpoints, conditionalSplit `default`), while the *merchant* customGraph save
 * (app/routes.ts PUT /workflow-configs/:templateKey) ran ONLY the compliance
 * guard (`validateLockedNodesEnforced` in scaffold.ts). A merchant could
 * therefore persist a graph with an edge to a nonexistent node, a call node
 * with no agent, or a split that dead-ends outcomes — none of which the
 * compliance guard looks at. This module is the single source of truth both
 * paths now share.
 *
 * It is deliberately SEPARATE from `validateLockedNodesEnforced`: that function
 * is the compliance suspenders (call/sms can't be reached without passing the
 * locked DNC/window nodes) and is a hard, always-on guarantee. This function is
 * the structural/completeness belt. Both run at save time; neither replaces the
 * runtime enforcement in scheduler.ts.
 *
 * Severity maps directly to what the engine (graph-engine.ts) actually does:
 *
 *  - "error"   — the run would fail or be ambiguous. ALWAYS blocks a save
 *                (admin + merchant), and a generated ai-draft with any error is
 *                a generation failure, not something handed to the merchant.
 *                e.g. an edge to a missing node → node_not_found → markRunFailed.
 *
 *  - "blocker" — the graph runs but does the wrong thing or nothing. Blocks an
 *                admin template save and a merchant *activation* (enabled=true),
 *                but is allowed on a merchant draft save so a half-built graph
 *                can be persisted. e.g. a call node with no persona would dial
 *                with no agent; a split with no `default` silently completes.
 *
 *  - "warning" — a nit the merchant probably didn't intend but the engine
 *                tolerates. Never blocks; surfaced so the UI can nudge.
 *                e.g. a wait delay <= 0 is clamped to 1 at runtime.
 */
import { WORKFLOW_OUTCOMES } from "./graph-types";
import type { WorkflowGraph, CallConfig, SmsConfig, WaitConfig, WebhookConfig } from "./graph-types";

export type GraphIssueSeverity = "error" | "blocker" | "warning";

export type GraphIssue = {
  severity: GraphIssueSeverity;
  code: string;
  /** Node this issue is about, when applicable — lets the UI focus it. */
  nodeId?: string;
  message: string;
};

export type GraphValidationResult = {
  issues: GraphIssue[];
  /** Convenience buckets — derived from `issues`, never out of sync. */
  errors: GraphIssue[];
  blockers: GraphIssue[];
  warnings: GraphIssue[];
};

/** Linear nodes: the engine follows only outgoing[0]; extra edges are dropped. */
const LINEAR_NODE_TYPES = new Set(["trigger", "wait", "dncCheck", "callingWindowCheck"]);

/** Known branch labels a conditionalSplit edge may carry (graph-types WORKFLOW_OUTCOMES). */
const KNOWN_BRANCHES = new Set<string>(WORKFLOW_OUTCOMES);

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A URL is "clearly malformed" only if it is non-empty, carries no merge tag
 * (webhook URLs legitimately contain `{{shop_name}}`-style tags resolved at
 * dispatch), and does not parse as an absolute http(s) URL. Empty is handled
 * separately as a warning (runtime falls back to the WEBHOOK_URL env var).
 */
function isClearlyMalformedUrl(url: string): boolean {
  if (!url) return false;
  if (url.includes("{{") && url.includes("}}")) return false; // templated — resolved later
  try {
    const parsed = new URL(url);
    return parsed.protocol !== "http:" && parsed.protocol !== "https:";
  } catch {
    return true;
  }
}

/**
 * Structural + completeness validation for a workflow graph. Pure, no I/O.
 * Ordering within `issues` is: errors, then blockers, then warnings, roughly in
 * discovery order — the UI can rely on the first error being the most important
 * thing to fix.
 */
export function validateWorkflowGraph(graph: WorkflowGraph): GraphValidationResult {
  const issues: GraphIssue[] = [];
  const push = (severity: GraphIssueSeverity, code: string, message: string, nodeId?: string) =>
    issues.push({ severity, code, message, nodeId });

  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];

  // --- Node id integrity (error) ---
  const nodeIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const n of nodes) {
    if (nodeIds.has(n.id)) duplicateIds.add(n.id);
    nodeIds.add(n.id);
  }
  for (const id of duplicateIds) {
    push("error", "duplicate-node-id", `Two or more nodes share the id "${id}".`, id);
  }

  // --- Trigger presence (error) / multiplicity (warning) ---
  const triggers = nodes.filter((n) => n.type === "trigger");
  if (triggers.length === 0) {
    push("error", "no-trigger", "Workflow has no trigger — nothing would ever start it.");
  } else if (triggers.length > 1) {
    push(
      "warning",
      "multiple-triggers",
      `Workflow has ${triggers.length} trigger nodes; only the first is used to start a run.`,
      triggers[1]?.id,
    );
  }
  const entryTrigger = triggers[0];

  // --- Edge endpoint integrity (error) + self-loop (error) ---
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      push("error", "edge-missing-source", `Edge "${edge.id}" starts from a node that doesn't exist.`);
    }
    if (!nodeIds.has(edge.target)) {
      push("error", "edge-missing-target", `Edge "${edge.id}" points to a node that doesn't exist.`);
    }
    if (edge.source === edge.target) {
      push("error", "edge-self-loop", `Node "${edge.source}" connects to itself, which would loop forever.`, edge.source);
    }
  }

  const outgoingByNode = new Map<string, typeof edges>();
  for (const edge of edges) {
    const list = outgoingByNode.get(edge.source) ?? [];
    list.push(edge);
    outgoingByNode.set(edge.source, list);
  }
  const outgoing = (nodeId: string) => outgoingByNode.get(nodeId) ?? [];

  // --- Per-node structural + completeness checks ---
  for (const node of nodes) {
    const out = outgoing(node.id);

    // Linear nodes only ever follow the first outgoing edge.
    if (LINEAR_NODE_TYPES.has(node.type) && out.length > 1) {
      push(
        "warning",
        "linear-node-extra-edges",
        `"${node.type}" node "${node.id}" has ${out.length} outgoing connections but only the first is followed.`,
        node.id,
      );
    }

    switch (node.type) {
      case "trigger": {
        if (out.length === 0) {
          push("blocker", "trigger-no-path", "The trigger isn't connected to anything, so the workflow does nothing.", node.id);
        }
        break;
      }
      case "call": {
        const persona = trimmed((node.config as CallConfig)?.persona);
        if (!persona) {
          push("blocker", "call-empty-persona", `Call step "${node.id}" has no agent selected.`, node.id);
        }
        break;
      }
      case "sms": {
        const template = trimmed((node.config as SmsConfig)?.template);
        if (!template) {
          push("blocker", "sms-empty-template", `SMS step "${node.id}" has no message text.`, node.id);
        }
        break;
      }
      case "wait": {
        const delay = (node.config as WaitConfig)?.delayMinutes;
        if (typeof delay !== "number" || delay <= 0) {
          push(
            "warning",
            "wait-nonpositive-delay",
            `Wait step "${node.id}" has no positive delay; it will be treated as 1 minute.`,
            node.id,
          );
        }
        break;
      }
      case "webhook": {
        const url = trimmed((node.config as WebhookConfig)?.url);
        if (!url) {
          push("warning", "webhook-empty-url", `Webhook step "${node.id}" has no URL (falls back to the org default, if any).`, node.id);
        } else if (isClearlyMalformedUrl(url)) {
          push("blocker", "webhook-invalid-url", `Webhook step "${node.id}" has a URL that isn't valid.`, node.id);
        }
        break;
      }
      case "conditionalSplit": {
        const hasDefault = out.some((e) => e.branch === "default");
        if (!hasDefault) {
          push(
            "blocker",
            "split-no-default",
            `Branch step "${node.id}" has no "default" path, so some outcomes would dead-end.`,
            node.id,
          );
        }
        for (const e of out) {
          if (e.branch && !KNOWN_BRANCHES.has(e.branch)) {
            push(
              "warning",
              "split-unknown-branch",
              `Branch step "${node.id}" routes an unknown outcome "${e.branch}" that a call can never produce.`,
              node.id,
            );
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // --- Reachability from the entry trigger (warning) ---
  if (entryTrigger) {
    const reachable = new Set<string>([entryTrigger.id]);
    const queue = [entryTrigger.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const e of outgoing(current)) {
        if (!reachable.has(e.target) && nodeIds.has(e.target)) {
          reachable.add(e.target);
          queue.push(e.target);
        }
      }
    }
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        push("warning", "unreachable-node", `"${node.type}" node "${node.id}" can't be reached from the trigger.`, node.id);
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const blockers = issues.filter((i) => i.severity === "blocker");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { issues, errors, blockers, warnings };
}

/** True when nothing would block a *draft save* (no hard structural errors). */
export function hasStructuralErrors(result: GraphValidationResult): boolean {
  return result.errors.length > 0;
}

/** True when the graph is safe to *activate* (no errors and no blockers). */
export function canActivate(result: GraphValidationResult): boolean {
  return result.errors.length === 0 && result.blockers.length === 0;
}
