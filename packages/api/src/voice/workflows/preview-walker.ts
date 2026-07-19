/**
 * Workflow Canvas v4 — Phase 3: flow preview via web call (2026-07-19).
 *
 * A PURE, log-only walk of a WorkflowGraph for the canvas "preview this flow"
 * feature. It produces an ordered storyboard the merchant can read before/while
 * a single live sandbox call runs:
 *
 *   - Non-call nodes (wait / sms / addToDnc / webhook) are NOT executed — they
 *     become a single visible log line ("→ would wait 45 min here"). A preview
 *     is a synchronous browser session; a 45-minute wait can't be waited out and
 *     nothing real should be sent/dialed from a sandbox.
 *   - Locked compliance nodes (dncCheck / callingWindowCheck) ARE included in the
 *     walk — the merchant sees them fire ("DNC check: pass (sandbox)"), reinforcing
 *     Phase 1's trust signal — but obviously do no real DNC lookup here.
 *   - `call` nodes are marked `live: true` — this is where the browser hands off to
 *     the real STT->LLM->TTS pipeline via the EXISTING preview infra
 *     (test-call-tokens.ts + test-call-stream.ts, ADR-051). This module does not
 *     itself open a socket or place a call; it only decides *where* the live call
 *     sits in the flow and with which persona.
 *   - At a `conditionalSplit`, the merchant pre-picks which outcome to walk
 *     (`branchSelections[nodeId]`), since a sandbox call has no real disposition —
 *     same idea as the existing preview's merchant-supplied form state.
 *
 * IMPORTANT — built to the real code, not the v3 plan doc: the v3 §2 `condition`
 * node (branch on cart value/tag/etc.) is NOT a real WorkflowNodeType and is not
 * handled here. `conditionalSplit` is the only branch node that exists. If a
 * `condition` node is ever added, extend the switch below.
 *
 * Traversal mirrors graph-engine.ts's advanceWorkflow (same edge/branch rules,
 * same MAX_ITERATIONS safety net) so the preview can't diverge from real
 * execution order — but every side effect is replaced with a log line.
 */
import { renderTemplate } from "./variables";
import type {
  WorkflowGraph,
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeType,
  WaitConfig,
  CallConfig,
  SmsConfig,
  AddToDncConfig,
  WebhookConfig,
  TriggerConfig,
} from "./graph-types";

export type PreviewStepType =
  | "trigger"
  | "compliance"
  | "wait"
  | "call"
  | "branch"
  | "sms"
  | "addToDnc"
  | "webhook"
  | "end"
  | "error";

export type PreviewStep = {
  nodeId: string;
  nodeType: WorkflowNodeType | "end" | "error";
  type: PreviewStepType;
  /** Human-readable log line shown in the preview UI. */
  label: string;
  /** True only for `call` steps — the browser runs a real sandbox call here. */
  live?: boolean;
  /** Persona to run the live call with — only set on `call` steps. */
  persona?: string;
  /** For `branch` steps — which outcome the merchant chose to walk. */
  branchChosen?: string;
  /** Mirrors WorkflowNode.locked so the UI can style compliance nodes. */
  locked?: boolean;
};

export type PreviewWalkInput = {
  graph: WorkflowGraph;
  /** conditionalSplit nodeId -> chosen outcome branch. Missing -> "default"/first edge. */
  branchSelections?: Record<string, string>;
  /** Sample merge-tag values for rendering SMS/persona templates in the log. */
  context?: Record<string, string | number>;
};

export type PreviewWalkResult = {
  steps: PreviewStep[];
  /** False if the walk hit an error step (bad node, missing target, loop cap). */
  ok: boolean;
};

const MAX_ITERATIONS = 50; // matches graph-engine.ts

function getOutgoing(graph: WorkflowGraph, nodeId: string): WorkflowEdge[] {
  return graph.edges.filter((e) => e.source === nodeId);
}

function getNode(graph: WorkflowGraph, nodeId: string): WorkflowNode | undefined {
  return graph.nodes.find((n) => n.id === nodeId);
}

function findTrigger(graph: WorkflowGraph): WorkflowNode | undefined {
  return graph.nodes.find((n) => n.type === "trigger");
}

/**
 * Walk a graph for preview. Pure — no DB, no network, no side effects.
 * Every node produces exactly one PreviewStep; the walk stops on the first
 * terminal (no outgoing edge) or error.
 */
export function walkForPreview(input: PreviewWalkInput): PreviewWalkResult {
  const { graph, branchSelections = {}, context = {} } = input;
  const steps: PreviewStep[] = [];

  const trigger = findTrigger(graph);
  if (!trigger) {
    steps.push({
      nodeId: "",
      nodeType: "error",
      type: "error",
      label: "This flow has no trigger node — nothing to preview.",
    });
    return { steps, ok: false };
  }

  let currentNodeId: string | undefined = trigger.id;
  let iterations = 0;

  while (currentNodeId && iterations < MAX_ITERATIONS) {
    iterations++;
    const node = getNode(graph, currentNodeId);
    if (!node) {
      steps.push({
        nodeId: currentNodeId,
        nodeType: "error",
        type: "error",
        label: `Broken flow: node "${currentNodeId}" is referenced by an edge but doesn't exist.`,
      });
      return { steps, ok: false };
    }
    const outgoing = getOutgoing(graph, currentNodeId);
    const base = { nodeId: node.id, locked: node.locked };

    switch (node.type) {
      case "trigger": {
        const cfg = node.config as TriggerConfig;
        steps.push({ ...base, nodeType: "trigger", type: "trigger", label: `Trigger: ${cfg.event}` });
        currentNodeId = outgoing[0]?.target;
        break;
      }
      case "dncCheck": {
        steps.push({ ...base, nodeType: "dncCheck", type: "compliance", label: "DNC / consent check: pass (sandbox)" });
        currentNodeId = outgoing[0]?.target;
        break;
      }
      case "callingWindowCheck": {
        steps.push({ ...base, nodeType: "callingWindowCheck", type: "compliance", label: "Calling-window check: pass (sandbox)" });
        currentNodeId = outgoing[0]?.target;
        break;
      }
      case "wait": {
        const cfg = node.config as WaitConfig;
        const mins = Math.max(1, Math.min(10080, cfg.delayMinutes || 1));
        steps.push({ ...base, nodeType: "wait", type: "wait", label: `→ would wait ${mins} min here, then continue` });
        currentNodeId = outgoing[0]?.target;
        break;
      }
      case "call": {
        const cfg = node.config as CallConfig;
        steps.push({
          ...base,
          nodeType: "call",
          type: "call",
          live: true,
          persona: cfg.persona,
          label: `Live call runs here (persona: ${cfg.persona})`,
        });
        currentNodeId = outgoing[0]?.target;
        break;
      }
      case "conditionalSplit": {
        const chosen = branchSelections[node.id];
        let matched: WorkflowEdge | undefined;
        if (chosen) matched = outgoing.find((e) => e.branch === chosen);
        if (!matched) matched = outgoing.find((e) => e.branch === "default");
        if (!matched) matched = outgoing[0];
        steps.push({
          ...base,
          nodeType: "conditionalSplit",
          type: "branch",
          branchChosen: matched?.branch ?? chosen,
          label: `Branch on call outcome → took "${matched?.branch ?? chosen ?? "(none)"}" path`,
        });
        currentNodeId = matched?.target;
        break;
      }
      case "sms": {
        const cfg = node.config as SmsConfig;
        const rendered = renderTemplate(cfg.template, context);
        steps.push({ ...base, nodeType: "sms", type: "sms", label: `→ would send SMS: "${rendered}"` });
        currentNodeId = outgoing[0]?.target;
        break;
      }
      case "addToDnc": {
        const cfg = node.config as AddToDncConfig;
        steps.push({ ...base, nodeType: "addToDnc", type: "addToDnc", label: `→ would add caller to Do-Not-Call (reason: ${cfg.reason})` });
        currentNodeId = outgoing[0]?.target;
        break;
      }
      case "webhook": {
        const cfg = node.config as WebhookConfig;
        steps.push({ ...base, nodeType: "webhook", type: "webhook", label: `→ would POST webhook to ${cfg.url}` });
        currentNodeId = outgoing[0]?.target;
        break;
      }
      default: {
        steps.push({
          ...base,
          nodeType: "error",
          type: "error",
          label: `Unknown node type "${(node as WorkflowNode).type}" — can't preview.`,
        });
        return { steps, ok: false };
      }
    }

    if (!currentNodeId) {
      steps.push({ nodeId: node.id, nodeType: "end", type: "end", label: "End of flow." });
      return { steps, ok: true };
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    steps.push({
      nodeId: currentNodeId ?? "",
      nodeType: "error",
      type: "error",
      label: "Flow is too long or loops back on itself — preview stopped after 50 steps.",
    });
    return { steps, ok: false };
  }

  return { steps, ok: true };
}
