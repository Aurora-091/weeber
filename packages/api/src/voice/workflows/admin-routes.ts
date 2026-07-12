import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../../database";
import { workflowTemplates, orgWorkflowConfigs, workflowRuns } from "../../database/schema";
import type { WorkflowGraph } from "./graph-types";

export const workflowAdminRoutes = new Hono();

/**
 * Validate a workflow graph before saving:
 * - Every conditionalSplit node must have a "default" outgoing edge
 * - All edges reference existing node IDs
 * - At least one trigger node exists
 */
function validateGraph(graph: WorkflowGraph): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  const triggerNodes = graph.nodes.filter((n) => n.type === "trigger");
  if (triggerNodes.length === 0) {
    errors.push("Graph must have at least one trigger node");
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge ${edge.id} references non-existent source node: ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge ${edge.id} references non-existent target node: ${edge.target}`);
    }
  }

  const conditionalSplitNodes = graph.nodes.filter((n) => n.type === "conditionalSplit");
  for (const node of conditionalSplitNodes) {
    const outgoing = graph.edges.filter((e) => e.source === node.id);
    const hasDefault = outgoing.some((e) => e.branch === "default");
    if (!hasDefault) {
      errors.push(
        `ConditionalSplit node "${node.id}" must have a "default" outgoing edge to prevent dead-ending runs`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
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
  const body = await c.req.json<{ enabled?: boolean; overrides?: Record<string, Record<string, unknown>> }>();

  const values: typeof orgWorkflowConfigs.$inferInsert = {
    orgId,
    templateKey,
    enabled: body.enabled ?? true,
    overrides: body.overrides ?? null,
  };

  const [config] = await db
    .insert(orgWorkflowConfigs)
    .values(values)
    .onConflictDoUpdate({
      target: [orgWorkflowConfigs.orgId, orgWorkflowConfigs.templateKey],
      set: { enabled: values.enabled, overrides: values.overrides },
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
