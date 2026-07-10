/**
 * Admin-panel endpoints added in the frontend round (CLAUDE-BUILD-BRIEF §4)
 * — org oversight, agent-template catalog, billing/compliance overviews,
 * feature flags, and merchant impersonation. Split from routes.ts to keep
 * that file's Twilio/call-pipeline surface readable; both are mounted under
 * /api/voice in ../index.ts, so paths here behave exactly as if they lived
 * in routes.ts.
 *
 * All routes are admin-key gated. Impersonation is the sensitive one: every
 * start/stop writes to the append-only impersonationSessions audit table
 * (the §4.6 hard requirement), attributed to the admin key that did it.
 */
import { Hono } from "hono";
import { desc, eq, gte, inArray, isNull, and } from "drizzle-orm";
import { db } from "../database";
import {
  agentTemplates,
  calls,
  doNotCall,
  featureFlags,
  orgMembers,
  orgs,
  shopLinks,
  toolCalls,
  orgAgentConfigs,
} from "../database/schema";
import { requireAdminKey, type AdminAuthVariables } from "./middleware/admin-auth";
import {
  startImpersonation,
  stopImpersonation,
  listImpersonationAudit,
  listActiveImpersonations,
} from "../app/impersonation";

type AdminEnv = { Variables: AdminAuthVariables };

const GUARDRAIL_TOOL_NAMES = ["flagGuardrailEvent", "guardrail-heuristic-detector"];

export const admin = new Hono<AdminEnv>()
  .use("*", requireAdminKey)

  // Org list with rollups for the admin orgs page (the picker keeps using
  // the lighter GET /orgs in routes.ts). Registered before /orgs/:orgId so
  // "overview" isn't swallowed by the param route.
  .get("/orgs/overview", async (c) => {
    const [orgRows, shopRows, memberRows, configRows] = await Promise.all([
      db.select().from(orgs).orderBy(orgs.createdAt),
      db.select({ orgId: shopLinks.orgId, disconnectedAt: shopLinks.disconnectedAt }).from(shopLinks),
      db.select({ orgId: orgMembers.orgId }).from(orgMembers),
      db
        .select({ orgId: orgAgentConfigs.orgId, enabled: orgAgentConfigs.enabled })
        .from(orgAgentConfigs),
    ]);

    const count = (rows: { orgId: string }[]) => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.orgId, (m.get(r.orgId) ?? 0) + 1);
      return m;
    };
    const shopCounts = count(shopRows.filter((s) => !s.disconnectedAt));
    const memberCounts = count(memberRows);
    const enabledAgentCounts = count(configRows.filter((r) => r.enabled));

    return c.json(
      {
        orgs: orgRows.map((org) => ({
          ...org,
          connectedShops: shopCounts.get(org.id) ?? 0,
          members: memberCounts.get(org.id) ?? 0,
          enabledAgents: enabledAgentCounts.get(org.id) ?? 0,
        })),
      },
      200,
    );
  })

  .get("/orgs/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (!org) return c.json({ error: "org not found" }, 404);
    const [shops, members, configs, activeImpersonations] = await Promise.all([
      db.select().from(shopLinks).where(eq(shopLinks.orgId, orgId)),
      db
        .select({
          id: orgMembers.id,
          supabaseUserId: orgMembers.supabaseUserId,
          role: orgMembers.role,
          createdAt: orgMembers.createdAt,
        })
        .from(orgMembers)
        .where(eq(orgMembers.orgId, orgId)),
      db
        .select({
          templateKey: orgAgentConfigs.templateKey,
          enabled: orgAgentConfigs.enabled,
          updatedAt: orgAgentConfigs.updatedAt,
        })
        .from(orgAgentConfigs)
        .where(eq(orgAgentConfigs.orgId, orgId)),
      listActiveImpersonations(orgId),
    ]);
    return c.json({ org, shops, members, agentConfigs: configs, activeImpersonations }, 200);
  })

  // Agent template catalog (ADR-031's vertical-agnostic seam). Templates are
  // deactivated, never deleted — scheduled calls and org configs reference
  // keys, and the additive-only convention applies to catalog rows too.
  .get("/agent-templates", async (c) => {
    const rows = await db.select().from(agentTemplates).orderBy(agentTemplates.vertical, agentTemplates.key);
    return c.json({ agentTemplates: rows }, 200);
  })

  .post("/agent-templates", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { vertical, key, name, description, defaultPersonaPrompt, defaultTools, active } = body as {
      vertical?: string;
      key?: string;
      name?: string;
      description?: string;
      defaultPersonaPrompt?: string;
      defaultTools?: string[];
      active?: boolean;
    };
    if (!vertical?.trim() || !key?.trim() || !name?.trim()) {
      return c.json({ error: "`vertical`, `key`, and `name` are required" }, 400);
    }
    const [existing] = await db.select({ id: agentTemplates.id }).from(agentTemplates).where(eq(agentTemplates.key, key.trim())).limit(1);
    if (existing) return c.json({ error: `template key "${key.trim()}" already exists` }, 409);
    const [row] = await db
      .insert(agentTemplates)
      .values({
        vertical: vertical.trim(),
        key: key.trim(),
        name: name.trim(),
        description: description ?? null,
        defaultPersonaPrompt: defaultPersonaPrompt ?? null,
        defaultTools: Array.isArray(defaultTools) ? defaultTools : [],
        active: active ?? true,
      })
      .returning();
    return c.json({ agentTemplate: row }, 201);
  })

  .put("/agent-templates/:key", async (c) => {
    const key = c.req.param("key");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { name, description, defaultPersonaPrompt, defaultTools, active } = body as {
      name?: string;
      description?: string | null;
      defaultPersonaPrompt?: string | null;
      defaultTools?: string[];
      active?: boolean;
    };
    const set: Partial<typeof agentTemplates.$inferInsert> = {};
    if (name !== undefined) set.name = name;
    if (description !== undefined) set.description = description;
    if (defaultPersonaPrompt !== undefined) set.defaultPersonaPrompt = defaultPersonaPrompt;
    if (defaultTools !== undefined) set.defaultTools = defaultTools;
    if (active !== undefined) set.active = active;
    if (Object.keys(set).length === 0) return c.json({ error: "nothing to update" }, 400);
    const [row] = await db.update(agentTemplates).set(set).where(eq(agentTemplates.key, key)).returning();
    if (!row) return c.json({ error: "template not found" }, 404);
    return c.json({ agentTemplate: row }, 200);
  })

  // Billing oversight — read-only against orgs.planName + computed usage
  // until the Razorpay integration workstream lands (ADR-034).
  .get("/billing/overview", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [orgRows, callRows] = await Promise.all([
      db.select().from(orgs).orderBy(orgs.createdAt),
      db
        .select({ orgId: calls.orgId, startedAt: calls.startedAt, endedAt: calls.endedAt })
        .from(calls)
        .where(gte(calls.startedAt, since)),
    ]);
    const usage = new Map<string, { calls: number; minutes: number }>();
    for (const call of callRows) {
      if (!call.orgId) continue;
      const entry = usage.get(call.orgId) ?? { calls: 0, minutes: 0 };
      entry.calls += 1;
      if (call.endedAt) entry.minutes += (call.endedAt.getTime() - call.startedAt.getTime()) / 60000;
      usage.set(call.orgId, entry);
    }
    return c.json(
      {
        rangeDays: days,
        orgs: orgRows.map((org) => ({
          id: org.id,
          name: org.name,
          vertical: org.vertical,
          planName: org.planName,
          currency: org.currency,
          calls: usage.get(org.id)?.calls ?? 0,
          minutes: Math.round((usage.get(org.id)?.minutes ?? 0) * 10) / 10,
        })),
      },
      200,
    );
  })

  // Compliance oversight. `dncScope: "global"` is load-bearing: the DNC list
  // is one global list today (per-org DNC is WEEBER-PLAN workstream P), and
  // the UI must say so rather than imply per-org isolation that doesn't exist.
  .get("/compliance/overview", async (c) => {
    const [dncRows, guardrailRows, undispositioned] = await Promise.all([
      db.select().from(doNotCall).orderBy(desc(doNotCall.addedAt)),
      db
        .select({ orgId: calls.orgId, input: toolCalls.input })
        .from(toolCalls)
        .innerJoin(calls, eq(toolCalls.callId, calls.id))
        .where(inArray(toolCalls.toolName, GUARDRAIL_TOOL_NAMES)),
      db
        .select({ id: calls.id })
        .from(calls)
        .where(and(isNull(calls.disposition), eq(calls.status, "completed"))),
    ]);

    const guardrailEventsByOrg: Record<string, Record<string, number>> = {};
    for (const row of guardrailRows) {
      const orgKey = row.orgId ?? "(no org)";
      const category =
        row.input && typeof row.input === "object" && "category" in row.input
          ? String((row.input as { category: unknown }).category)
          : "unknown";
      guardrailEventsByOrg[orgKey] ??= {};
      guardrailEventsByOrg[orgKey][category] = (guardrailEventsByOrg[orgKey][category] ?? 0) + 1;
    }

    return c.json(
      {
        dncScope: "global" as const,
        dncCount: dncRows.length,
        recentDnc: dncRows.slice(0, 10),
        guardrailEventsByOrg,
        completedCallsWithoutDisposition: undispositioned.length,
      },
      200,
    );
  })

  // Feature flags — flat table, global (orgId "") or org-scoped rows.
  .get("/flags", async (c) => {
    const rows = await db.select().from(featureFlags).orderBy(featureFlags.key, featureFlags.orgId);
    return c.json({ flags: rows }, 200);
  })

  .post("/flags", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { key, orgId, enabled, description } = body as {
      key?: string;
      orgId?: string;
      enabled?: boolean;
      description?: string;
    };
    if (!key?.trim()) return c.json({ error: "`key` is required" }, 400);
    const [row] = await db
      .insert(featureFlags)
      .values({ key: key.trim(), orgId: orgId?.trim() || "", enabled: enabled ?? false, description })
      .onConflictDoUpdate({
        target: [featureFlags.key, featureFlags.orgId],
        set: { enabled: enabled ?? false, description, updatedAt: new Date() },
      })
      .returning();
    return c.json({ flag: row }, 201);
  })

  .put("/flags/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { enabled, description } = body as { enabled?: boolean; description?: string | null };
    const set: Partial<typeof featureFlags.$inferInsert> = { updatedAt: new Date() };
    if (enabled !== undefined) set.enabled = enabled;
    if (description !== undefined) set.description = description;
    const [row] = await db.update(featureFlags).set(set).where(eq(featureFlags.id, id)).returning();
    if (!row) return c.json({ error: "flag not found" }, 404);
    return c.json({ flag: row }, 200);
  })

  .delete("/flags/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    await db.delete(featureFlags).where(eq(featureFlags.id, id));
    return c.json({ deleted: true }, 200);
  })

  // Merchant impersonation (§4.6). The plaintext token is returned exactly
  // once; the frontend presents it via the X-Weeber-Impersonation header on
  // /api/app/* routes. Sessions auto-expire; Stop closes them early. Both
  // paths leave the audit row behind.
  .post("/impersonation/start", async (c) => {
    const body = await c.req.json().catch(() => null);
    const orgId = body && typeof body === "object" ? (body as { orgId?: string }).orgId : undefined;
    if (!orgId?.trim()) return c.json({ error: "`orgId` is required" }, 400);
    const session = await startImpersonation(orgId.trim(), c.get("adminActor") ?? "unknown");
    if (!session) return c.json({ error: "org not found" }, 404);
    return c.json({ impersonation: session }, 201);
  })

  .post("/impersonation/:id/stop", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const stopped = await stopImpersonation(id);
    return c.json({ stopped }, 200);
  })

  .get("/impersonation/audit", async (c) => {
    const orgId = c.req.query("orgId") || undefined;
    const limit = Number(c.req.query("limit")) || 100;
    const [audit, active] = await Promise.all([
      listImpersonationAudit({ orgId, limit }),
      listActiveImpersonations(orgId),
    ]);
    return c.json({ audit, active }, 200);
  });
