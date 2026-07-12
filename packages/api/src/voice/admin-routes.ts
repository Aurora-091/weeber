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
  platformSettings,
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
import { listUsers } from "../app/users";
import { listWaitlist, waitlistMarketingSummary } from "../app/waitlist";
import { createBroadcast, listBroadcasts, sendBroadcast } from "../app/broadcasts";
import { listSupportTickets, updateSupportTicketStatus } from "../app/support";
import { logAdminAction, listAdminAuditLog } from "../app/audit-log";
import {
  getTwilioStatus,
  createSubaccountForOrg,
  buyNumberForOrg,
  setByoCredentials,
  resetToPlatformDefault,
} from "./twilio-provisioning";

async function validateGtmId(id: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.googletagmanager.com/gtm.js?id=${id}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function validateGa4Id(id: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.googletagmanager.com/gtag/js?id=${id}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

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
        orgs: orgRows.map((org) => {
          const { twilioAuthToken: _twilioAuthToken, ...safeOrg } = org;
          return {
            ...safeOrg,
            connectedShops: shopCounts.get(org.id) ?? 0,
            members: memberCounts.get(org.id) ?? 0,
            enabledAgents: enabledAgentCounts.get(org.id) ?? 0,
          };
        }),
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
    // Never return the raw Twilio auth token in a generic org-detail blob —
    // even admin-key-gated, it's an unnecessary exposure surface (browser
    // dev tools, logs, copy-paste). Use GET /orgs/:orgId/twilio for the
    // masked telephony status instead.
    const { twilioAuthToken: _twilioAuthToken, ...safeOrg } = org;
    return c.json({ org: safeOrg, shops, members, agentConfigs: configs, activeImpersonations }, 200);
  })

  // Per-org Twilio isolation (ADR-042) — status, sub-account provisioning,
  // number purchase, BYO credentials, reset. Never returns the auth token.
  .get("/orgs/:orgId/twilio", async (c) => {
    const status = await getTwilioStatus(c.req.param("orgId"));
    if (!status) return c.json({ error: "org not found" }, 404);
    return c.json({ twilio: status }, 200);
  })

  .post("/orgs/:orgId/twilio/subaccount", async (c) => {
    const orgId = c.req.param("orgId");
    const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (!org) return c.json({ error: "org not found" }, 404);

    const result = await createSubaccountForOrg(orgId, org.name ?? orgId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    await logAdminAction(c.get("adminActor"), "twilio.subaccount.created", { orgId, accountSid: result.accountSid });
    return c.json({ accountSid: result.accountSid }, 201);
  })

  .post("/orgs/:orgId/twilio/number", async (c) => {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => null);
    const { countryCode, areaCode } = (body ?? {}) as { countryCode?: string; areaCode?: string };
    if (!countryCode?.trim()) return c.json({ error: "`countryCode` is required, e.g. \"US\" or \"IN\"" }, 400);

    const result = await buyNumberForOrg(orgId, countryCode.trim(), areaCode?.trim());
    if (!result.ok) return c.json({ error: result.error }, 400);
    await logAdminAction(c.get("adminActor"), "twilio.number.purchased", { orgId, phoneNumber: result.phoneNumber });
    return c.json({ phoneNumber: result.phoneNumber }, 201);
  })

  .post("/orgs/:orgId/twilio/byo", async (c) => {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => null);
    const { accountSid, authToken, phoneNumber } = (body ?? {}) as {
      accountSid?: string;
      authToken?: string;
      phoneNumber?: string;
    };
    if (!accountSid?.trim() || !authToken?.trim() || !phoneNumber?.trim()) {
      return c.json({ error: "`accountSid`, `authToken`, and `phoneNumber` are all required" }, 400);
    }

    const result = await setByoCredentials(orgId, {
      accountSid: accountSid.trim(),
      authToken: authToken.trim(),
      phoneNumber: phoneNumber.trim(),
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    // Deliberately never logs the auth token, only that a BYO credential
    // change happened and which SID/number it now points at.
    await logAdminAction(c.get("adminActor"), "twilio.byo.set", { orgId, accountSid: accountSid.trim(), phoneNumber: phoneNumber.trim() });
    return c.json({ ok: true }, 200);
  })

  .post("/orgs/:orgId/twilio/reset", async (c) => {
    const orgId = c.req.param("orgId");
    await resetToPlatformDefault(orgId);
    await logAdminAction(c.get("adminActor"), "twilio.reset", { orgId });
    return c.json({ ok: true }, 200);
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
        .select({ id: calls.id, fromNumber: calls.fromNumber, toNumber: calls.toNumber, startedAt: calls.startedAt })
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
        undispositionedCalls: undispositioned.slice(0, 100),
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
    void logAdminAction(c.get("adminActor"), "flag.upserted", { key: row?.key, orgId: row?.orgId, enabled: row?.enabled });
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
    void logAdminAction(c.get("adminActor"), "flag.updated", { id, enabled, description });
    return c.json({ flag: row }, 200);
  })

  .delete("/flags/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    await db.delete(featureFlags).where(eq(featureFlags.id, id));
    void logAdminAction(c.get("adminActor"), "flag.deleted", { id });
    return c.json({ deleted: true }, 200);
  })

  // Merchant impersonation (§4.6). The plaintext token is returned exactly
  // once; the frontend presents it via the X-Weeber-Impersonation header on
  // /api/app/* routes. Sessions auto-expire; Stop closes them early. Both
  // paths leave the audit row behind. Surfaced from the Users page (per-row
  // "Log in as" action), not a standalone admin nav item — the capability
  // and its audit trail are unchanged, only the UI entry point moved.
  .post("/impersonation/start", async (c) => {
    const body = await c.req.json().catch(() => null);
    const orgId = body && typeof body === "object" ? (body as { orgId?: string }).orgId : undefined;
    if (!orgId?.trim()) return c.json({ error: "`orgId` is required" }, 400);
    const session = await startImpersonation(orgId.trim(), c.get("adminActor") ?? "unknown");
    if (!session) return c.json({ error: "org not found" }, 404);
    void logAdminAction(c.get("adminActor"), "impersonation.started", { orgId: orgId.trim(), sessionId: session.id });
    return c.json({ impersonation: session }, 201);
  })

  .post("/impersonation/:id/stop", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const stopped = await stopImpersonation(id);
    void logAdminAction(c.get("adminActor"), "impersonation.stopped", { id });
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
  })

  // Users — individual accounts (org_members), person-centric view distinct
  // from the org-centric Orgs page. Matches Vocalist's real admin nav split.
  .get("/users", async (c) => {
    const users = await listUsers(Number(c.req.query("limit")) || undefined);
    return c.json({ users }, 200);
  })

  // Waitlist — read-only admin view over the landing page's signups (the
  // actual join endpoint is public, see routes.ts's POST /waitlist).
  .get("/waitlist", async (c) => {
    const signups = await listWaitlist(Number(c.req.query("limit")) || undefined);
    return c.json({ signups }, 200);
  })

  // Broadcasts — create, list, and send. `status` only becomes "sent" if an
  // email provider is actually configured (see broadcasts.ts) — never a
  // fabricated success.
  .get("/broadcasts", async (c) => {
    const rows = await listBroadcasts(Number(c.req.query("limit")) || undefined);
    return c.json({ broadcasts: rows }, 200);
  })

  .post("/broadcasts", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { title, body: message, audience } = body as { title?: string; body?: string; audience?: string };
    if (!title?.trim() || !message?.trim()) return c.json({ error: "`title` and `body` are required" }, 400);
    const row = await createBroadcast({ title, body: message, audience: audience ?? "all", createdBy: c.get("adminActor") });
    void logAdminAction(c.get("adminActor"), "broadcast.created", { id: row?.id, title, audience: audience ?? "all" });
    return c.json({ broadcast: row }, 201);
  })

  .post("/broadcasts/:id/send", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const row = await sendBroadcast(id);
    if (!row) return c.json({ error: "broadcast not found" }, 404);
    void logAdminAction(c.get("adminActor"), "broadcast.send_attempted", { id, status: row.status });
    return c.json({ broadcast: row }, 200);
  })

  // Support tickets — list/update. Submission itself happens via
  // routes.ts's public/merchant endpoints, not here.
  .get("/support", async (c) => {
    const status = c.req.query("status") || undefined;
    const rows = await listSupportTickets(status, Number(c.req.query("limit")) || undefined);
    return c.json({ tickets: rows }, 200);
  })

  .put("/support/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    const status = body && typeof body === "object" ? (body as { status?: string }).status : undefined;
    if (!status?.trim()) return c.json({ error: "`status` is required" }, 400);
    const row = await updateSupportTicketStatus(id, status.trim());
    if (!row) return c.json({ error: "ticket not found" }, 404);
    void logAdminAction(c.get("adminActor"), "support.status_updated", { id, status: status.trim() });
    return c.json({ ticket: row }, 200);
  })

  // Admin action log — reads adminAuditLog (see app/audit-log.ts), not raw
  // process logs. No log-shipping infra exists; this is "who changed what,"
  // which is the more useful surface for an ops team anyway.
  .get("/logs", async (c) => {
    const rows = await listAdminAuditLog(Number(c.req.query("limit")) || undefined);
    return c.json({ logs: rows }, 200);
  })

  // Revenue Analytics — real data only. No Stripe/Razorpay integration
  // exists yet (ADR-034 deferred it), so this is a usage-minutes proxy and
  // plan-count breakdown, explicitly NOT a fabricated $ revenue number.
  .get("/revenue-analytics", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [orgRows, callRows] = await Promise.all([
      db.select({ id: orgs.id, planName: orgs.planName, currency: orgs.currency }).from(orgs),
      db
        .select({ orgId: calls.orgId, startedAt: calls.startedAt, endedAt: calls.endedAt })
        .from(calls)
        .where(gte(calls.startedAt, since)),
    ]);

    const orgsByPlan: Record<string, number> = {};
    for (const org of orgRows) {
      const plan = org.planName ?? "(no plan set)";
      orgsByPlan[plan] = (orgsByPlan[plan] ?? 0) + 1;
    }

    let totalMinutes = 0;
    const minutesByDay: Record<string, number> = {};
    for (const call of callRows) {
      if (!call.endedAt) continue;
      const minutes = (call.endedAt.getTime() - call.startedAt.getTime()) / 60000;
      totalMinutes += minutes;
      const day = call.startedAt.toISOString().slice(0, 10);
      minutesByDay[day] = (minutesByDay[day] ?? 0) + minutes;
    }
    for (const day of Object.keys(minutesByDay)) minutesByDay[day] = Math.round(minutesByDay[day]! * 10) / 10;

    return c.json(
      {
        rangeDays: days,
        note: "Usage-minutes proxy, not billed revenue — no payment processor is integrated yet.",
        totalOrgs: orgRows.length,
        orgsByPlan,
        totalMinutesInRange: Math.round(totalMinutes * 10) / 10,
        minutesByDay,
      },
      200,
    );
  })

  // Marketing Analytics — real data only. Only the waitlist table records
  // any acquisition signal today (no traffic/funnel tracking beyond a GTM
  // container id) — signups over time + referral/source breakdown, nothing
  // fabricated.
  .get("/marketing-analytics", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
    const summary = await waitlistMarketingSummary(days);
    return c.json(summary, 200);
  })

  // --- Platform Settings (key-value, admin-managed) ---

  .get("/platform-settings", async (c) => {
    const rows = await db.select().from(platformSettings);
    return c.json({ settings: rows }, 200);
  })

  .put("/platform-settings/:key", async (c) => {
    const key = c.req.param("key");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid JSON body" }, 400);
    const { value } = body as { value?: string };
    const normalizedValue = typeof value === "string" ? value.trim() : "";

    // Validate known keys
    if (key === "gtm_container_id") {
      if (normalizedValue && !/^GTM-[A-Z0-9]{4,10}$/.test(normalizedValue)) {
        return c.json({ error: "Invalid GTM format — expected GTM-XXXXXXX" }, 422);
      }
      if (normalizedValue) {
        const valid = await validateGtmId(normalizedValue);
        if (!valid) return c.json({ error: "GTM container not found — check the ID" }, 422);
      }
    } else if (key === "ga4_measurement_id") {
      if (normalizedValue && !/^G-[A-Z0-9]{6,14}$/.test(normalizedValue)) {
        return c.json({ error: "Invalid GA4 format — expected G-XXXXXXXXXX" }, 422);
      }
      if (normalizedValue) {
        const valid = await validateGa4Id(normalizedValue);
        if (!valid) return c.json({ error: "GA4 measurement ID not found — check the ID" }, 422);
      }
    }

    const finalValue = normalizedValue || null;
    await db
      .insert(platformSettings)
      .values({ key, value: finalValue, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: finalValue, updatedAt: new Date() },
      });

    await logAdminAction(c.get("adminActor"), "platform_settings.updated", { key, value: finalValue });
    return c.json({ ok: true, key, value: finalValue }, 200);
  });
