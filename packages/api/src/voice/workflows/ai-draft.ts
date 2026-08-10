/**
 * Workflow Canvas v4, Phase 2 (2026-07-18) — AI-assisted graph drafting.
 * See docs/workflow-canvas/v4-locked-scaffold-ai-draft-and-flow-preview-plan.md §2.
 *
 * A merchant describes what they want in plain language; one LLM call drafts
 * a graph in the existing typed node/edge JSON shape. The draft is generated
 * *around* the locked compliance scaffold (never instead of it) and is
 * validated with the exact same save-time guard (`validateLockedNodesEnforced`,
 * scaffold.ts) before it's ever returned to the client — a malformed or
 * rule-violating draft is a generation error, never silently handed to the
 * merchant as if it were valid.
 *
 * One-shot generation, not a multi-turn agent — drafting a workflow is a
 * rare, per-org action, not a per-call cost, so this doesn't move the unit-
 * economics numbers already locked in docs/product-strategy/pricing-lock-
 * 2026-07-18.md.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { resolveVoiceModel } from "../llm";
import { db } from "../../database";
import { agentTemplates, orgs } from "../../database/schema";
import { and, eq } from "drizzle-orm";
import { visibleTemplatesForVertical } from "../template-visibility";
import { validateLockedNodesEnforced } from "./scaffold";
import { validateWorkflowGraph } from "./graph-validation";
import type { WorkflowGraph } from "./graph-types";
import { WORKFLOW_OUTCOMES } from "./graph-types";

// Deliberately permissive on `config` (a plain key/value record) rather than
// a strict discriminated union — generateObject's structured-output mode
// handles a flatter shape far more reliably than a union keyed on a sibling
// field, and validateLockedNodesEnforced (plus the existing graph-engine's
// own per-node-type handling) is what actually catches a malformed graph,
// not this schema. This schema's job is just "make the LLM emit valid JSON
// in the right shape," not full runtime type safety.
const nodeSchema = z.object({
  id: z.string(),
  type: z.enum([
    "trigger",
    "wait",
    "call",
    "conditionalSplit",
    "sms",
    "addToDnc",
    "webhook",
    "dncCheck",
    "callingWindowCheck",
  ]),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  locked: z.boolean().optional(),
});

const edgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  branch: z.string().optional(),
});

const graphSchema = z.object({
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
});

export type DraftWorkflowResult = { ok: true; graph: WorkflowGraph } | { ok: false; error: string };

/**
 * Fixed IDs for the locked nodes in every draft — the system prompt is
 * instructed to always reuse these exact IDs for the compliance nodes
 * (rather than inventing new ones each time), which keeps drafts consistent
 * with `scaffold.ts`'s own blank-scaffold IDs and makes the "never touch a
 * locked node" instruction concrete instead of abstract.
 */
const LOCKED_DNC_CHECK_ID = "dnc-check";
const LOCKED_CALLING_WINDOW_CHECK_ID = "calling-window-check";

/**
 * The persona keys this org may actually use in a drafted graph (ADR-091).
 *
 * This used to select every `active` template key in the table, with no org,
 * vertical, or visibility scoping — so the system prompt handed a merchant a
 * list of every other tenant's private template keys, and a drafted graph
 * could name one. Enumeration is the whole point of `visibility`, so it goes
 * through the same predicate as the agent list (`visibleTemplatesForVertical`):
 * this vertical's public catalog plus this org's own bespoke templates.
 *
 * An unknown org (or one with no visible active templates) yields an empty
 * list, and the system prompt already renders that as "no agents configured
 * yet" — fail closed, not fail open to the whole catalog.
 */
async function listAvailablePersonaKeys(orgId: string): Promise<string[]> {
  const [org] = await db.select({ vertical: orgs.vertical }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) return [];
  const rows = await db
    .select({ key: agentTemplates.key })
    .from(agentTemplates)
    .where(and(visibleTemplatesForVertical(org.vertical, orgId), eq(agentTemplates.active, true)));
  return rows.map((r) => r.key);
}

function buildSystemPrompt(personaKeys: string[]): string {
  return `You design workflow automation graphs for a voice-AI platform. Output ONLY a graph
matching the given schema — nodes and edges, nothing else.

Available node types and their config shape:
- trigger: { event: "checkout_abandoned" | "order_placed" | "order_fulfilled" }. Exactly one per graph, no incoming edges.
- wait: { delayMinutes: number }
- call: { persona: string (must be one of: ${personaKeys.join(", ") || "no agents configured yet"}), discountPercent: number }
- conditionalSplit: { outcomes: string[] (each one of: ${WORKFLOW_OUTCOMES.join(", ")}) } — one outgoing edge per outcome, edge.branch set to that outcome string
- sms: { template: string }
- addToDnc: { reason: string }
- webhook: { url: string }
- dncCheck: {} (no config — a required compliance checkpoint, see below)
- callingWindowCheck: {} (no config — a required compliance checkpoint, see below)

MANDATORY compliance rule, never break this:
Every graph MUST include exactly one dncCheck node (id: "${LOCKED_DNC_CHECK_ID}") and exactly one
callingWindowCheck node (id: "${LOCKED_CALLING_WINDOW_CHECK_ID}"), both marked "locked": true. Every
path from the trigger to ANY call or sms node MUST pass through both of these nodes first, with no
alternate path that reaches a call/sms node without going through them. Do not omit them, rename
their IDs, unlock them, or create any call/sms node reachable without passing through both.

Design the rest of the graph (waits, retries, conditional branches, discount escalation, SMS
follow-ups) based on the user's description. Keep it realistic — don't invent trigger events,
outcomes, or persona keys outside the lists above.`;
}

export async function draftWorkflowGraph(prompt: string, orgId: string): Promise<DraftWorkflowResult> {
  const personaKeys = await listAvailablePersonaKeys(orgId);

  let generated: z.infer<typeof graphSchema>;
  try {
    const result = await generateObject({
      model: resolveVoiceModel(),
      schema: graphSchema,
      system: buildSystemPrompt(personaKeys),
      prompt,
    });
    generated = result.object;
  } catch (err) {
    console.error("[workflow-ai-draft] generation failed", err);
    return { ok: false, error: "Couldn't generate a workflow from that description — try rephrasing it." };
  }

  const graph = generated as WorkflowGraph;
  const validation = validateLockedNodesEnforced(graph);
  if (!validation.valid) {
    // Never hand a rule-violating draft to the client, even labeled as a
    // draft — surfaced as a generation error instead, matching the plan
    // doc's explicit "reject and re-prompt, never silently return" rule.
    console.error(`[workflow-ai-draft] generated graph failed validation: ${validation.error}`);
    return { ok: false, error: "The generated workflow didn't meet compliance requirements — try describing it differently." };
  }

  // Structural integrity (graph-validation.ts): a draft with a broken edge or
  // duplicate node id would fail at runtime, so it's a generation error too.
  // Completeness "blockers" (e.g. a call node with no persona yet) are NOT
  // rejected here — filling those in is precisely what the merchant does after
  // the draft lands in the canvas; the save gate catches them at activation.
  const structural = validateWorkflowGraph(graph);
  if (structural.errors.length > 0) {
    console.error(`[workflow-ai-draft] generated graph has structural errors: ${structural.errors.map((i) => i.code).join(", ")}`);
    return { ok: false, error: "The generated workflow came out malformed — try describing it again." };
  }

  return { ok: true, graph };
}
