import { mock, describe, it, expect, afterAll, beforeEach } from "bun:test";

/**
 * Security fix (2026-07-16, found during unrelated workflow-analytics work):
 * `workflowAdminRoutes` is mounted as a completely separate Hono instance
 * from `voice/admin-routes.ts`'s `admin` router — Hono middleware registered
 * on one instance never applies to another instance just because both get
 * `.route()`-mounted onto the same parent app in index.ts. This router had
 * ZERO authentication on every route (workflow-templates CRUD, org workflow
 * configs, workflow-runs read — real PII: customer names, phone numbers,
 * cart values). This test locks in the fix (same requireAdminKey/
 * adminSessionAuth gate voice/admin-routes.ts already uses) so it can't
 * silently regress back to unauthenticated.
 */

let rowsByTable: Record<string, unknown[]> = {};

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  promise.orderBy = () => thenable(rows);
  return promise;
}

const dbLike = {
  select: () => ({
    from: (table: unknown) => thenable(rowsByTable[getTableName(table) ?? ""] ?? []),
  }),
};

// ADR-116 addendum: this file's admin-routes.ts now imports `dbBackground`
// — both names must resolve here or the import throws.
mock.module("../../database", () => ({ db: dbLike, dbBackground: dbLike }));

process.env.ADMIN_API_KEY = "test-admin-key";
afterAll(() => {
  delete process.env.ADMIN_API_KEY;
});

import { workflowAdminRoutes } from "./admin-routes";

const adminHeaders = { "X-Weeber-Admin-Key": "test-admin-key" };

describe("workflowAdminRoutes — auth gate (security fix, 2026-07-16)", () => {
  beforeEach(() => {
    rowsByTable = { workflow_templates: [], org_workflow_configs: [], workflow_runs: [] };
  });

  it("rejects an unauthenticated GET /workflow-templates", async () => {
    const res = await workflowAdminRoutes.request("/workflow-templates");
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated GET /workflow-runs (real PII: customer names, phone numbers, cart values)", async () => {
    const res = await workflowAdminRoutes.request("/workflow-runs");
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated GET /orgs/:orgId/workflow-configs", async () => {
    const res = await workflowAdminRoutes.request("/orgs/some-org-id/workflow-configs");
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated PUT /workflow-templates/:id", async () => {
    const res = await workflowAdminRoutes.request("/workflow-templates/some-template", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph: { nodes: [], edges: [] } }),
    });
    expect(res.status).toBe(401);
  });

  it("lets a valid admin key through to /workflow-templates", async () => {
    const res = await workflowAdminRoutes.request("/workflow-templates", { headers: adminHeaders });
    expect(res.status).toBe(200);
  });

  it("lets a valid admin key through to /workflow-runs", async () => {
    const res = await workflowAdminRoutes.request("/workflow-runs", { headers: adminHeaders });
    expect(res.status).toBe(200);
  });
});

describe("workflowAdminRoutes — GET /workflow-templates/:id/analytics (2026-07-16)", () => {
  beforeEach(() => {
    rowsByTable = {
      workflow_templates: [
        {
          id: "shopify-cart-recovery-v1",
          graph: {
            nodes: [
              { id: "trigger-1", type: "trigger" },
              { id: "call-1", type: "call" },
              { id: "wait-1", type: "wait" },
            ],
            edges: [],
          },
        },
      ],
      workflow_runs: [
        // Run 1: trigger -> call -> wait, still running (last node's duration measured to updatedAt)
        {
          templateKey: "shopify-cart-recovery-v1",
          status: "running",
          updatedAt: new Date("2026-07-16T10:10:00Z"),
          nodeHistory: [
            { nodeId: "trigger-1", enteredAt: "2026-07-16T10:00:00Z" },
            { nodeId: "call-1", enteredAt: "2026-07-16T10:02:00Z" },
            { nodeId: "wait-1", enteredAt: "2026-07-16T10:05:00Z" },
          ],
        },
        // Run 2: trigger -> call, completed at call-1 (a real termination)
        {
          templateKey: "shopify-cart-recovery-v1",
          status: "completed",
          updatedAt: new Date("2026-07-16T11:03:00Z"),
          nodeHistory: [
            { nodeId: "trigger-1", enteredAt: "2026-07-16T11:00:00Z" },
            { nodeId: "call-1", enteredAt: "2026-07-16T11:01:00Z" },
          ],
        },
      ],
    };
  });

  it("returns entry counts, avg duration, and termination counts per node", async () => {
    const res = await workflowAdminRoutes.request("/workflow-templates/shopify-cart-recovery-v1/analytics", {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalRuns: number; nodes: Array<Record<string, unknown>> };
    expect(body.totalRuns).toBe(2);

    const byId: Record<string, any> = {};
    for (const n of body.nodes) byId[n.nodeId as string] = n;

    // trigger-1: entered in both runs, never a termination.
    expect(byId["trigger-1"].entryCount).toBe(2);
    expect(byId["trigger-1"].terminationCount).toBe(0);
    // trigger-1's duration: run1 = 2min (10:00->10:02), run2 = 1min (11:00->11:01) -> avg 90000ms
    expect(byId["trigger-1"].avgDurationMs).toBe(90_000);

    // call-1: entered in both runs; run2 terminated here (status completed, last entry).
    expect(byId["call-1"].entryCount).toBe(2);
    expect(byId["call-1"].terminationCount).toBe(1);

    // wait-1: only run1 reached it, still running (not a termination), never left it in the data
    // we have (duration measured to updatedAt).
    expect(byId["wait-1"].entryCount).toBe(1);
    expect(byId["wait-1"].terminationCount).toBe(0);
    expect(byId["wait-1"].avgDurationMs).toBe(5 * 60 * 1000); // 10:05 -> updatedAt 10:10
  });

  it("returns 404 for a template that doesn't exist", async () => {
    // Mock's `.where()` doesn't actually apply filters (see thenable() above) — so simulate
    // "not found" the same way the other tests simulate "found": via rowsByTable's contents,
    // not a real id-matching query.
    rowsByTable.workflow_templates = [];
    const res = await workflowAdminRoutes.request("/workflow-templates/does-not-exist/analytics", {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await workflowAdminRoutes.request("/workflow-templates/shopify-cart-recovery-v1/analytics");
    expect(res.status).toBe(401);
  });
});
