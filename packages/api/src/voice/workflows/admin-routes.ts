import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../../database";
import { workflowTemplates, orgWorkflowConfigs, workflowRuns } from "../../database/schema";
import type { WorkflowGraph } from "./graph-types";
import { validateLockedNodesEnforced } from "./scaffold";
import { validateWorkflowGraph } from "./graph-validation";
import { requireAdminKey, type AdminAuthVariables } from "../middleware/admin-auth";
import { adminSessionAuth } from "../middleware/admin-session";

/**
 * SECURITY FIX (2026-07-16, found during unrelated workflow-analytics work):
 * this router is mounted at `/api/workflows` in index.ts, completely
 * separately from `voice/admin-routes.ts`'s own `admin` Hono instance —
 * Hono middleware registered on one router instance does NOT apply to a
 * different instance just because both get `.route()`-mounted onto the same
 * parent app. This file had ZERO authentication on every route: anyone who
 * could reach the API could read every org's workflow run data (customer
 * names, phone numbers, cart values, checkout tokens — real PII, via
 * GET /workflow-runs and /workflow-runs/:id), read or overwrite any org's
 * workflow config by guessing an orgId (GET/PUT /orgs/:orgId/workflow-
 * configs/...), and create/edit/delete the platform-wide workflow templates
 * every org's cart-recovery/COD workflow runs on (POST/PUT/DELETE
 * /workflow-templates). Same gate as voice/admin-routes.ts, applied here
 * directly since these are two separate Hono router instances.
 */
export const workflowAdminRoutes = new Hono<{ Variables: AdminAuthVariables }>()
  .use("*", adminSessionAuth)
  .use("*", requireAdminKey);

/**
 * Validate a workflow *template* graph before saving. Delegates to the shared
 * `validateWorkflowGraph` (graph-validation.ts) — the single source of truth
 * now used by both the admin template save (here) and the merchant customGraph
 * save (app/routes.ts). A shared production template is held to the strict bar:
 * both hard structural errors AND completeness blockers (empty persona, a split
 * with no `default`, etc.) reject the save. Warnings do not block.
 *
 * This preserves the original admin contract (trigger presence, edge endpoints,
 * split-default all still reject) while inheriting the newer checks for free.
 */
function validateGraph(graph: WorkflowGraph): { valid: boolean; errors: string[] } {
  const result = validateWorkflowGraph(graph);
  const blocking = [...result.errors, ...result.blockers];
  return { valid: blocking.length === 0, errors: blocking.map((i) => i.message) };
}

// --- Workflow Templates CRUD ---

workflowAdminRoutes.get("/workflow-templates", async (c) => {
  const vertical = c.req.query("vertical");
  const conditions = vertical ? eq(workflowTemplates.vertical, vertical) : undefined;
  const templates = await db
    .select()
    .from(workflowTemplates)
    .where(conditions)
    .orderBy(desc(workflowTemplates.createdAt));
  return c.json(templates);
});

workflowAdminRoutes.get("/workflow-templates/:id", async (c) => {
  const id = c.req.param("id");
  const [template] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, id)).limit(1);
  if (!template) return c.json({ error: "not_found" }, 404);
  return c.json(template);
});

workflowAdminRoutes.post("/workflow-templates", async (c) => {
  const body = await c.req.json<{
    id: string;
    vertical: string;
    name: string;
    graph: WorkflowGraph;
  }>();

  if (!body.id || !body.vertical || !body.name || !body.graph) {
    return c.json({ error: "missing_fields", required: ["id", "vertical", "name", "graph"] }, 400);
  }

  const validation = validateGraph(body.graph);
  if (!validation.valid) {
    return c.json({ error: "invalid_graph", details: validation.errors }, 422);
  }

  const [template] = await db
    .insert(workflowTemplates)
    .values({
      id: body.id,
      vertical: body.vertical,
      name: body.name,
      graph: body.graph,
    })
    .returning();

  return c.json(template, 201);
});

workflowAdminRoutes.put("/workflow-templates/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; graph?: WorkflowGraph; active?: boolean }>();

  const [existing] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, id)).limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);

  if (body.graph) {
    const validation = validateGraph(body.graph);
    if (!validation.valid) {
      return c.json({ error: "invalid_graph", details: validation.errors }, 422);
    }
  }

  const updates: Partial<typeof workflowTemplates.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.graph !== undefined) updates.graph = body.graph;
  if (body.active !== undefined) updates.active = body.active;

  const [updated] = await db
    .update(workflowTemplates)
    .set(updates)
    .where(eq(workflowTemplates.id, id))
    .returning();

  return c.json(updated);
});

workflowAdminRoutes.delete("/workflow-templates/:id", async (c) => {
  const id = c.req.param("id");
  const [updated] = await db
    .update(workflowTemplates)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(workflowTemplates.id, id))
    .returning();
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json({ status: "deactivated" });
});

// --- Org Workflow Configs ---

workflowAdminRoutes.get("/orgs/:orgId/workflow-configs", async (c) => {
  const orgId = c.req.param("orgId");
  const configs = await db
    .select()
    .from(orgWorkflowConfigs)
    .where(eq(orgWorkflowConfigs.orgId, orgId));
  return c.json(configs);
});

workflowAdminRoutes.put("/orgs/:orgId/workflow-configs/:templateKey", async (c) => {
  const orgId = c.req.param("orgId");
  const templateKey = c.req.param("templateKey");
  const body = await c.req.json<{
    enabled?: boolean;
    overrides?: Record<string, Record<string, unknown>>;
    // Workflow Canvas v4 (2026-07-18, Phase 1) — mirrors the merchant-side
    // endpoint's same field/validation; admin can also set/inspect an org's
    // custom graph on their behalf.
    customGraph?: WorkflowGraph;
  }>();

  if (body.customGraph !== undefined) {
    const validation = validateLockedNodesEnforced(body.customGraph);
    if (!validation.valid) {
      return c.json({ error: `Invalid workflow graph: ${validation.error}` }, 400);
    }
  }

  const values: typeof orgWorkflowConfigs.$inferInsert = {
    orgId,
    templateKey,
    enabled: body.enabled ?? true,
    overrides: body.overrides ?? null,
    customGraph: body.customGraph ?? null,
  };

  const [config] = await db
    .insert(orgWorkflowConfigs)
    .values(values)
    .onConflictDoUpdate({
      target: [orgWorkflowConfigs.orgId, orgWorkflowConfigs.templateKey],
      // Same non-clobbering rule as the merchant-side endpoint — don't wipe
      // an existing customGraph just because this particular save omitted it.
      set: {
        enabled: values.enabled,
        overrides: values.overrides,
        ...(body.customGraph !== undefined ? { customGraph: values.customGraph } : {}),
      },
    })
    .returning();

  return c.json(config);
});

// --- Workflow Runs (observability) ---

workflowAdminRoutes.get("/workflow-runs", async (c) => {
  const orgId = c.req.query("orgId");
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);

  const conditions: ReturnType<typeof eq>[] = [];
  if (orgId) conditions.push(eq(workflowRuns.orgId, orgId));
  if (status) conditions.push(eq(workflowRuns.status, status as "running" | "waiting" | "completed" | "failed"));

  const runs = await db
    .select()
    .from(workflowRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit);

  return c.json(runs);
});

workflowAdminRoutes.get("/workflow-runs/:id", async (c) => {
  const id = c.req.param("id");
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
  if (!run) return c.json({ error: "not_found" }, 404);
  return c.json(run);
});

// --- Analytics overlay (2026-07-16) ---
// docs/workflow-canvas-v2-and-multivoice-research.md's Option A, informed by researching
// ElevenLabs' (per-node entry/duration/termination overlay) and Bolna's ("easy to debug — when
// something breaks, you know which node failed and why") graph-agent analytics. Aggregated in
// application code, not SQL, matching this codebase's general style for read-side aggregation at
// this data volume — revisit with a real SQL aggregate query if a template's run count ever gets
// large enough for this to matter.

type NodeHistoryEntry = { nodeId: string; enteredAt: string };

workflowAdminRoutes.get("/workflow-templates/:id/analytics", async (c) => {
  const id = c.req.param("id");
  const [template] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, id)).limit(1);
  if (!template) return c.json({ error: "not_found" }, 404);

  const graph = template.graph as WorkflowGraph;
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.templateKey, id));

  const entryCounts: Record<string, number> = {};
  const durationSums: Record<string, number> = {};
  const durationCounts: Record<string, number> = {};
  const terminationCounts: Record<string, number> = {};

  for (const run of runs) {
    const history = (run.nodeHistory as NodeHistoryEntry[]) ?? [];
    for (let i = 0; i < history.length; i++) {
      const entry = history[i]!;
      entryCounts[entry.nodeId] = (entryCounts[entry.nodeId] ?? 0) + 1;

      // Time spent at this node: until the next entry, or (for the last entry) until the run's
      // own updatedAt — best-effort, since a still-"running"/"waiting" run's last node hasn't
      // technically finished yet, but updatedAt is the closest real signal available without a
      // dedicated "node exited at" timestamp (out of scope for this pass — see doc for why
      // nodeHistory's {nodeId, enteredAt} shape was kept minimal).
      const nextEntry = history[i + 1];
      const enteredAt = new Date(entry.enteredAt).getTime();
      const exitedAt = nextEntry ? new Date(nextEntry.enteredAt).getTime() : new Date(run.updatedAt).getTime();
      const durationMs = exitedAt - enteredAt;
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        durationSums[entry.nodeId] = (durationSums[entry.nodeId] ?? 0) + durationMs;
        durationCounts[entry.nodeId] = (durationCounts[entry.nodeId] ?? 0) + 1;
      }

      const isLastEntry = i === history.length - 1;
      if (isLastEntry && (run.status === "completed" || run.status === "failed")) {
        terminationCounts[entry.nodeId] = (terminationCounts[entry.nodeId] ?? 0) + 1;
      }
    }
  }

  const nodes = graph.nodes.map((node) => ({
    nodeId: node.id,
    nodeType: node.type,
    entryCount: entryCounts[node.id] ?? 0,
    avgDurationMs: durationCounts[node.id] ? Math.round(durationSums[node.id]! / durationCounts[node.id]!) : null,
    terminationCount: terminationCounts[node.id] ?? 0,
  }));

  return c.json({ templateKey: id, totalRuns: runs.length, nodes });
});
