/**
 * Admin-panel endpoints added in the frontend round (CLAUDE-BUILD-BRIEF §4)
 * — org oversight, agent-template catalog, billing/compliance overviews,
 * and feature flags. Split from routes.ts to keep that file's Twilio/
 * call-pipeline surface readable; both are mounted under /api/voice in
 * ../index.ts, so paths here behave exactly as if they lived in routes.ts.
 *
 * All routes are admin-key gated.
 */
import { Hono } from "hono";
import { desc, eq, gte, inArray, isNull, isNotNull, and } from "drizzle-orm";
// ADR-116 addendum: admin dashboard, never on a live call's turn path — uses
// the background connection pool so it can't compete with call-latency writes.
import { dbBackground as db } from "../database";
import {
  agentTemplates,
  calls,
  consentRecords,
  doNotCall,
  guardrailEvents,
  featureFlags,
  orgMembers,
  orgs,
  platformAdmins,
  platformSettings,
  scheduledCalls,
  shopLinks,
  toolCalls,
  orgAgentConfigs,
  orgPhoneNumbers,
} from "../database/schema";
import { requireAdminKey, type AdminAuthVariables } from "./middleware/admin-auth";
import { adminSessionAuth } from "./middleware/admin-session";
import { listUsers } from "../app/users";
import { listWaitlist, waitlistMarketingSummary } from "../app/waitlist";
import { createBroadcast, listBroadcasts, sendBroadcast } from "../app/broadcasts";
import { listSupportTickets, updateSupportTicketStatus, listSupportReplies, replySupportTicket } from "../app/support";
import { logAdminAction, listAdminAuditLog } from "../app/audit-log";
import { isTemplateVisibility } from "./template-visibility";
import {
  getTwilioStatus,
  ensureSubaccountForOrg,
  buyNumberForOrg,
  listAvailableNumbers,
  releaseNumberForOrg,
  setByoCredentials,
  resetToPlatformDefault,
  syncNumberWebhooksForOrg,
} from "./twilio-provisioning";
import { assignPhoneNumberToAgent } from "./org-queries";

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
  .use("*", adminSessionAuth)
  .use("*", requireAdminKey)

  .get("/admin-me", async (c) => {
    const actor = c.get("adminActor");
    const [admin] = await db
      .select({ email: platformAdmins.email, role: platformAdmins.role })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, actor))
      .limit(1);
    return c.json({ email: actor, role: admin?.role ?? "api-key", authenticated: true }, 200);
  })

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
    const [shops, members, configs] = await Promise.all([
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
    ]);
    // Never return the raw Twilio auth token in a generic org-detail blob —
    // even admin-key-gated, it's an unnecessary exposure surface (browser
    // dev tools, logs, copy-paste). Use GET /orgs/:orgId/twilio for the
    // masked telephony status instead.
    const { twilioAuthToken: _twilioAuthToken, ...safeOrg } = org;
    return c.json({ org: safeOrg, shops, members, agentConfigs: configs }, 200);
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

    // ensureSubaccountForOrg, not createSubaccountForOrg: a second POST here
    // used to mint a second Twilio sub-account and overwrite
    // orgs.twilioAccountSid, orphaning the first one — which still exists on
    // Twilio, may still hold a paid number, and is no longer reachable by this
    // system. Reusing the existing SID is the only safe response.
    const result = await ensureSubaccountForOrg(orgId, org.name ?? orgId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    // Only audit-log an actual creation. Logging a reuse as "created" would
    // make the admin audit trail claim sub-accounts that were never minted.
    if (!result.reused) {
      await logAdminAction(c.get("adminActor"), "twilio.subaccount.created", { orgId, accountSid: result.accountSid });
    }
    return c.json({ accountSid: result.accountSid, reused: result.reused }, result.reused ? 200 : 201);
  })

  .post("/orgs/:orgId/twilio/number", async (c) => {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => null);
    const { countryCode, areaCode } = (body ?? {}) as { countryCode?: string; areaCode?: string };
    if (!countryCode?.trim()) return c.json({ error: "`countryCode` is required, e.g. \"US\" or \"IN\"" }, 400);

    const available = await listAvailableNumbers(orgId, countryCode.trim(), areaCode?.trim());
    if (!available.ok) return c.json({ error: available.error }, 400);
    const result = await buyNumberForOrg(orgId, available.numbers[0]!.phoneNumber);
    if (!result.ok) return c.json({ error: result.error }, 400);
    await logAdminAction(c.get("adminActor"), "twilio.number.purchased", { orgId, phoneNumber: result.phoneNumber });
    return c.json({ phoneNumber: result.phoneNumber }, 201);
  })

  /**
   * Repairs the inbound webhooks on every active number an org holds.
   *
   * syncNumberWebhooksForOrg shipped without a caller, which made it dead
   * code: the two situations it exists for — numbers bought before the
   * purchase path set a voiceUrl, and every number after a PUBLIC_APP_URL
   * change — were both unreachable in a running system. An inert number
   * rings and drops with no webhook, so the failure is invisible from our
   * side: no call row, no error, just a caller who thinks we hung up.
   *
   * Admin-only and manual rather than automatic on boot. A deploy that
   * comes up with a wrong PUBLIC_APP_URL would otherwise happily re-point
   * every number in the fleet at it; making a human ask keeps that blast
   * radius behind an intentional request.
   */
  .post("/orgs/:orgId/twilio/sync-webhooks", async (c) => {
    const orgId = c.req.param("orgId");
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (!org) return c.json({ error: "org not found" }, 404);

    const result = await syncNumberWebhooksForOrg(orgId);
    if (!result.ok) return c.json({ error: result.error }, 400);

    // Only audit-log a sync that actually changed something, matching the
    // subaccount route's reuse handling: a clean run over correctly
    // configured numbers is a no-op, and recording it as a repair would
    // make the audit trail claim fixes that never happened.
    if (result.repaired.length > 0) {
      await logAdminAction(c.get("adminActor"), "twilio.webhooks.synced", {
        orgId,
        checked: result.checked,
        repaired: result.repaired,
      });
    }
    return c.json({ checked: result.checked, repaired: result.repaired }, 200);
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
    const result = await resetToPlatformDefault(orgId);
    // 409, not 400: the request is well-formed, the workspace is just in a
    // state where resetting would strand billable numbers.
    if (!result.ok) return c.json({ error: result.error }, 409);
    await logAdminAction(c.get("adminActor"), "twilio.reset", { orgId });
    return c.json({ ok: true }, 200);
  })

  /**
   * Releases one of an org's numbers — the missing inverse of
   * POST /orgs/:orgId/twilio/number above (bug, 2026-08-08).
   *
   * That route lets an admin commit the org to a recurring monthly rental.
   * Release existed only on the merchant-session route
   * (POST /api/app/numbers/:id/release), so the admin surface could spend
   * money it could not take back: an operator who provisions a number for an
   * org — during setup, support or a test — has no way to undo it without a
   * merchant session for that workspace, which an operator legitimately does
   * not have. Undoing exactly that on 2026-08-08 took hand-written SQL
   * against production.
   *
   * The comment this replaces claimed buying and releasing were both
   * "merchant-side actions" that admins don't manage here. That was already
   * untrue for the spend half, and an asymmetry that only permits spending is
   * the wrong way round.
   *
   * Org-scoping is enforced inside releaseNumberForOrg (the row lookup
   * requires id AND orgId to match), so a mistyped :orgId cannot release a
   * different workspace's number — it 400s as "not found" instead.
   */
  .post("/orgs/:orgId/twilio/numbers/:id/release", async (c) => {
    const orgId = c.req.param("orgId");
    const phoneNumberId = Number(c.req.param("id"));
    if (!Number.isInteger(phoneNumberId)) return c.json({ error: "`id` must be an integer" }, 400);

    const result = await releaseNumberForOrg(orgId, phoneNumberId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    // Logs the number, not the row id: a release is a destructive, billable
    // and irreversible action, and "which number did we give up" is the only
    // useful form of that record later.
    await logAdminAction(c.get("adminActor"), "twilio.number.released", { orgId, phoneNumber: result.phoneNumber });
    return c.json({ ok: true, phoneNumber: result.phoneNumber }, 200);
  })

  // C2b — read-only mirror of GET /api/app/numbers for admin oversight.
  // Write actions on numbers are the two routes above (purchase + release).
  .get("/orgs/:orgId/numbers", async (c) => {
    const orgId = c.req.param("orgId");
    const rows = await db.select().from(orgPhoneNumbers).where(eq(orgPhoneNumbers.orgId, orgId));
    return c.json({ numbers: rows }, 200);
  })

  // Admin mirror of GET /api/app/numbers/available — lets an operator see
  // real candidate numbers and pick one, instead of POST /orgs/:orgId/twilio/number
  // above (which blind-buys the first search result). Added for the real
  // demo-call widget (2026-08-27): an operator provisioning the demo org's
  // three dedicated numbers needs to choose which number goes to which
  // agent, not accept whatever Twilio returns first.
  .get("/orgs/:orgId/numbers/available", async (c) => {
    const orgId = c.req.param("orgId");
    const countryCode = c.req.query("countryCode");
    const areaCode = c.req.query("areaCode");
    if (!countryCode?.trim()) return c.json({ error: "`countryCode` query param is required, e.g. \"US\" or \"IN\"" }, 400);

    const result = await listAvailableNumbers(orgId, countryCode.trim(), areaCode?.trim());
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ numbers: result.numbers }, 200);
  })

  // Admin mirror of POST /api/app/numbers — buys a SPECIFIC number (picked
  // from the /available list above), unlike the existing blind-buy-first-result
  // /orgs/:orgId/twilio/number route, which is left untouched for whatever
  // already calls it.
  .post("/orgs/:orgId/numbers", async (c) => {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => null);
    const { phoneNumber } = (body ?? {}) as { phoneNumber?: string };
    if (!phoneNumber?.trim()) return c.json({ error: "`phoneNumber` is required — pick one from GET /orgs/:orgId/numbers/available" }, 400);

    const result = await buyNumberForOrg(orgId, phoneNumber.trim());
    if (!result.ok) return c.json({ error: result.error }, 400);
    await logAdminAction(c.get("adminActor"), "twilio.number.purchased", { orgId, phoneNumber: result.phoneNumber });
    return c.json({ phoneNumber: result.phoneNumber }, 201);
  })

  // C2b — admin mirror of PUT /api/app/agent-configs/:templateKey/number.
  // The only writer of orgAgentConfigs.phoneNumberId was previously reachable
  // only via a merchant session, which the demo org (no real logged-in user)
  // can never have — an operator needs an admin-key path to assign/swap which
  // number each of the demo widget's three agents dials out from.
  .put("/orgs/:orgId/agent-configs/:templateKey/number", async (c) => {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => null);
    const { phoneNumberId } = (body ?? {}) as { phoneNumberId?: number | null };
    if (phoneNumberId !== null && !Number.isInteger(phoneNumberId)) {
      return c.json({ error: "`phoneNumberId` must be an integer or null (to unassign)" }, 400);
    }
    const result = await assignPhoneNumberToAgent(orgId, c.req.param("templateKey"), phoneNumberId ?? null);
    if (!result.ok) return c.json({ error: result.error }, 400);
    await logAdminAction(c.get("adminActor"), "agent-config.number.assigned", {
      orgId,
      templateKey: c.req.param("templateKey"),
      phoneNumberId: phoneNumberId ?? null,
    });
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
    const { vertical, key, name, description, defaultPersonaPrompt, defaultTools, active, visibility, ownerOrgId } = body as {
      vertical?: string;
      key?: string;
      name?: string;
      description?: string;
      defaultPersonaPrompt?: string;
      defaultTools?: string[];
      active?: boolean;
      visibility?: string;
      ownerOrgId?: string;
    };
    if (!vertical?.trim() || !key?.trim() || !name?.trim()) {
      return c.json({ error: "`vertical`, `key`, and `name` are required" }, 400);
    }
    if (visibility !== undefined && !isTemplateVisibility(visibility)) {
      return c.json({ error: "`visibility` must be \"public\" or \"private\"" }, 400);
    }
    // A private template with no owner is visible to nobody — that's a silently
    // dead row, so reject it at creation rather than let it look allocated.
    if (visibility === "private" && !ownerOrgId?.trim()) {
      return c.json({ error: "`ownerOrgId` is required when visibility is \"private\"" }, 400);
    }
    if (ownerOrgId?.trim()) {
      const [owner] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, ownerOrgId.trim())).limit(1);
      if (!owner) return c.json({ error: `org "${ownerOrgId.trim()}" not found` }, 404);
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
        visibility: visibility ?? "public",
        ownerOrgId: ownerOrgId?.trim() || null,
      })
      .returning();
    return c.json({ agentTemplate: row }, 201);
  })

  .put("/agent-templates/:key", async (c) => {
    const key = c.req.param("key");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { name, description, defaultPersonaPrompt, defaultTools, active, visibility, ownerOrgId } = body as {
      name?: string;
      description?: string | null;
      defaultPersonaPrompt?: string | null;
      defaultTools?: string[];
      active?: boolean;
      visibility?: string;
      ownerOrgId?: string | null;
    };
    if (visibility !== undefined && !isTemplateVisibility(visibility)) {
      return c.json({ error: "`visibility` must be \"public\" or \"private\"" }, 400);
    }
    if (ownerOrgId !== undefined && ownerOrgId !== null && ownerOrgId.trim()) {
      const [owner] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, ownerOrgId.trim())).limit(1);
      if (!owner) return c.json({ error: `org "${ownerOrgId.trim()}" not found` }, 404);
    }
    const set: Partial<typeof agentTemplates.$inferInsert> = {};
    if (name !== undefined) set.name = name;
    if (description !== undefined) set.description = description;
    if (defaultPersonaPrompt !== undefined) set.defaultPersonaPrompt = defaultPersonaPrompt;
    if (defaultTools !== undefined) set.defaultTools = defaultTools;
    if (active !== undefined) set.active = active;
    if (visibility !== undefined) set.visibility = visibility;
    if (ownerOrgId !== undefined) set.ownerOrgId = ownerOrgId?.trim() || null;
    if (Object.keys(set).length === 0) return c.json({ error: "nothing to update" }, 400);
    // Same fail-closed rule as create, evaluated against the post-update row:
    // never leave a private template without an owner.
    const [current] = await db.select().from(agentTemplates).where(eq(agentTemplates.key, key)).limit(1);
    if (!current) return c.json({ error: "template not found" }, 404);
    const nextVisibility = set.visibility ?? current.visibility;
    const nextOwner = set.ownerOrgId !== undefined ? set.ownerOrgId : current.ownerOrgId;
    if (nextVisibility === "private" && !nextOwner) {
      return c.json({ error: "a private template must have an `ownerOrgId`" }, 400);
    }
    const [row] = await db.update(agentTemplates).set(set).where(eq(agentTemplates.key, key)).returning();
    if (!row) return c.json({ error: "template not found" }, 404);
    return c.json({ agentTemplate: row }, 200);
  })

  // Allocate one agent template to one org — the bespoke-agent path.
  //
  // A per-account agent is an `org_agent_configs` row against a template, not
  // a forked codebase or a copied prompt: everything an account can customize
  // (persona, name, greeting/closing, voice + failover chain, language, tools,
  // guardrails) already lives on that row. What was missing was a way to hand
  // an account a template the rest of the catalog can't see, and to switch it
  // on for them without waiting for them to find it in their agent list.
  //
  // Idempotent: re-granting an already-granted template is a 200 with
  // created=false, and it never overwrites a config the account has since
  // edited (onConflictDoNothing, same rule as provisionVerticalDefaults).
  .post("/orgs/:orgId/agents/grant", async (c) => {
    const orgId = c.req.param("orgId");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { templateKey, makePrivate } = body as { templateKey?: string; makePrivate?: boolean };
    if (!templateKey?.trim()) return c.json({ error: "`templateKey` is required" }, 400);
    const key = templateKey.trim();

    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (!org) return c.json({ error: `org "${orgId}" not found` }, 404);

    const [tmpl] = await db.select().from(agentTemplates).where(eq(agentTemplates.key, key)).limit(1);
    if (!tmpl) return c.json({ error: `template "${key}" not found` }, 404);
    // Granting someone else's bespoke template would make it visible to two
    // accounts at once — refuse instead of silently reassigning it.
    if (tmpl.visibility === "private" && tmpl.ownerOrgId && tmpl.ownerOrgId !== orgId) {
      return c.json({ error: `template "${key}" is privately owned by another org` }, 409);
    }
    if (!tmpl.active) return c.json({ error: `template "${key}" is not active` }, 400);

    // `makePrivate` claims the template for this org in the same call, so the
    // common case (write a bespoke template, hand it to its one account) is one
    // request. Omitted/false leaves a public catalog template public.
    if (makePrivate && tmpl.visibility !== "private") {
      await db.update(agentTemplates).set({ visibility: "private", ownerOrgId: orgId }).where(eq(agentTemplates.key, key));
    }

    const inserted = await db
      .insert(orgAgentConfigs)
      .values({ orgId, templateKey: key, enabled: true })
      .onConflictDoNothing({ target: [orgAgentConfigs.orgId, orgAgentConfigs.templateKey] })
      .returning({ id: orgAgentConfigs.id });

    await logAdminAction(c.get("adminActor"), "agent.template.granted", {
      orgId,
      templateKey: key,
      madePrivate: Boolean(makePrivate),
      created: inserted.length > 0,
    });
    return c.json({ ok: true, orgId, templateKey: key, created: inserted.length > 0 }, 200);
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

  // Phase I (five-bets plan, 2026-07-31) — per-event guardrail data from the
  // dedicated guardrail_events table (not the inferred tool_calls scan that
  // /compliance/overview uses). This is the exportable compliance artifact:
  // one row per boundary held, with category, source (agent self-report vs
  // heuristic detector), the triggering detail, and the call it belongs to.
  // The overview's guardrailEventsByOrg (tool_calls-derived) is intentionally
  // left in place — it still counts pre-migration calls that predate this table.
  .get("/compliance/guardrail-events", async (c) => {
    const orgId = c.req.query("orgId");
    const conditions = orgId?.trim() ? [eq(guardrailEvents.orgId, orgId.trim())] : [];
    const rows = await db
      .select()
      .from(guardrailEvents)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(guardrailEvents.firedAt))
      .limit(500);

    const byOrgCategory: Record<string, Record<string, number>> = {};
    const bySource: Record<string, number> = {};
    for (const row of rows) {
      const orgKey = row.orgId ?? "(no org)";
      byOrgCategory[orgKey] ??= {};
      byOrgCategory[orgKey][row.category] = (byOrgCategory[orgKey][row.category] ?? 0) + 1;
      bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    }

    return c.json({ events: rows.slice(0, 200), byOrgCategory, bySource, total: rows.length }, 200);
  })

  // Call-health / silent-failure view (Five Bets Phase II, 2026-07-31, see
  // voice/call-health.ts). `status` counts every connected call as "completed"
  // even when the caller heard dead air; this surfaces the calls whose
  // *pipeline* health verdict is degraded or silent-failure — the failures
  // that are otherwise invisible. Reads the health columns written at
  // finalizeCall. Only rows with a computed verdict are returned (a call
  // finalized before Phase II, or one whose health-write raced, has null and
  // is excluded rather than shown as a misleading "healthy"). Optional
  // ?status= filter (degraded|silent-failure|healthy) and ?orgId= filter;
  // newest-ended first. This is the evidence Phase V is gated on.
  .get("/compliance/call-health", async (c) => {
    const statusFilter = c.req.query("status")?.trim();
    const orgId = c.req.query("orgId")?.trim();
    const conditions = [isNotNull(calls.healthStatus)];
    if (statusFilter) conditions.push(eq(calls.healthStatus, statusFilter as never));
    if (orgId) conditions.push(eq(calls.orgId, orgId));

    const rows = await db
      .select({
        id: calls.id,
        orgId: calls.orgId,
        direction: calls.direction,
        fromNumber: calls.fromNumber,
        toNumber: calls.toNumber,
        status: calls.status,
        disposition: calls.disposition,
        healthStatus: calls.healthStatus,
        healthReasons: calls.healthReasons,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
      })
      .from(calls)
      .where(and(...conditions))
      .orderBy(desc(calls.endedAt))
      .limit(500);

    const byStatus: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    for (const row of rows) {
      const key = row.healthStatus ?? "unknown";
      byStatus[key] = (byStatus[key] ?? 0) + 1;
      for (const reason of row.healthReasons ?? []) {
        byReason[reason] = (byReason[reason] ?? 0) + 1;
      }
    }

    return c.json({ calls: rows.slice(0, 200), byStatus, byReason, total: rows.length }, 200);
  })

  // Cross-org view of scheduled calls a compliance gate blocked (2026-07-19).
  // The merchant Orders page shows each org its own blocked rows; this is the
  // platform-wide oversight version — "which calls got stopped, for which
  // org, and why" — so support/compliance can spot a misconfigured window,
  // an unexpected DNC hit, or a repeatedly-failing number series across all
  // tenants at once. Queried directly against scheduled_calls (same pattern
  // as /compliance/overview reading doNotCall directly), filtered to rows
  // that actually carry a persisted block reason, newest block first.
  .get("/compliance/blocked-calls", async (c) => {
    const rows = await db
      .select({
        id: scheduledCalls.id,
        orgId: scheduledCalls.orgId,
        toNumber: scheduledCalls.toNumber,
        workflowName: scheduledCalls.workflowName,
        status: scheduledCalls.status,
        attempt: scheduledCalls.attempt,
        maxAttempts: scheduledCalls.maxAttempts,
        runAt: scheduledCalls.runAt,
        lastBlockReason: scheduledCalls.lastBlockReason,
        lastBlockDetail: scheduledCalls.lastBlockDetail,
        blockedAt: scheduledCalls.blockedAt,
      })
      .from(scheduledCalls)
      .where(isNotNull(scheduledCalls.lastBlockReason))
      .orderBy(desc(scheduledCalls.blockedAt))
      .limit(200);

    const byReason: Record<string, number> = {};
    for (const row of rows) {
      const key = row.lastBlockReason ?? "unknown";
      byReason[key] = (byReason[key] ?? 0) + 1;
    }

    return c.json({ blockedCalls: rows, byReason, total: rows.length }, 200);
  })

  // Consent ledger read endpoints (Marketing + Consent UI plan, 2026-07-16,
  // docs/marketing-and-consent-ui-plan.md Part B) — Global Compliance Engine Tier 0
  // (docs/global-compliance-engine-plan.md) shipped the write/check path
  // (grant/withdraw/hasConsent via ConsentStorageAdapter) but no read API for a UI to call.
  // These two close that gap. Admin surface, so queried directly against `consentRecords`
  // (same pattern as `/compliance/overview` querying `doNotCall` directly) rather than through
  // `createConsentAdapterForOrg`, which is intentionally single-org-scoped and not meant for
  // cross-org admin oversight.
  .get("/compliance/consent", async (c) => {
    const principal = c.req.query("principal");
    const orgId = c.req.query("orgId");
    if (!principal?.trim()) {
      return c.json({ error: "`principal` query param is required (e.g. an e.164 phone number)" }, 400);
    }
    const conditions = [eq(consentRecords.dataPrincipal, principal.trim())];
    if (orgId?.trim()) conditions.push(eq(consentRecords.orgId, orgId.trim()));

    const rows = await db
      .select()
      .from(consentRecords)
      .where(and(...conditions))
      .orderBy(desc(consentRecords.grantedAt));

    return c.json({ principal: principal.trim(), records: rows }, 200);
  })

  // Aggregate consent counts per org per purpose — a "how much consent do we actually have on
  // file" overview, same shape as /compliance/overview's guardrailEventsByOrg. A record counts as
  // "active" only if granted, not withdrawn, and not expired — same semantics as
  // ConsentStorageAdapter.hasConsent, kept in sync deliberately (don't let this drift into a
  // simpler-but-wrong "just count granted rows" query).
  .get("/compliance/consent/summary", async (c) => {
    const orgId = c.req.query("orgId");
    const conditions = orgId?.trim() ? [eq(consentRecords.orgId, orgId.trim())] : [];
    const rows = await db
      .select()
      .from(consentRecords)
      .where(conditions.length ? and(...conditions) : undefined);

    const now = Date.now();
    const activeByOrgPurpose: Record<string, Record<string, number>> = {};
    const withdrawnByOrgPurpose: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      const isActive = row.granted && !row.withdrawnAt && (!row.expiresAt || row.expiresAt.getTime() > now);
      const target = isActive ? activeByOrgPurpose : row.withdrawnAt ? withdrawnByOrgPurpose : null;
      if (!target) continue;
      target[row.orgId] ??= {};
      target[row.orgId]![row.purpose] = (target[row.orgId]![row.purpose] ?? 0) + 1;
    }

    return c.json({ activeByOrgPurpose, withdrawnByOrgPurpose, totalRecords: rows.length }, 200);
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
  // routes.ts's public/user endpoints, not here.
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

  .get("/support/:id/replies", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const rows = await listSupportReplies(id);
    return c.json({ replies: rows }, 200);
  })

  // Actually sends the reply as an email via Resend (see app/support.ts) —
  // not a decorative UI action. `emailSent` on the returned row reflects
  // whether the send really succeeded.
  .post("/support/:id/reply", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    const message = body && typeof body === "object" ? (body as { message?: string }).message : undefined;
    if (!message?.trim()) return c.json({ error: "`message` is required" }, 400);
    const reply = await replySupportTicket({ ticketId: id, message: message.trim(), sentBy: c.get("adminActor") });
    if (!reply) return c.json({ error: "ticket not found" }, 404);
    void logAdminAction(c.get("adminActor"), "support.reply_sent", { id, emailSent: reply.emailSent });
    return c.json({ reply }, 200);
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
