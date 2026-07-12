/**
 * Org-scoped query/aggregation helpers shared by two surfaces with different
 * auth: the admin panel's /api/voice/orgs/:orgId/* routes (admin key, any
 * org) and the merchant app's /api/app/* routes (Supabase session, own org
 * only — see app/routes.ts). One implementation, two thin route wrappers, so
 * the numbers a merchant sees are by construction the same ones the admin
 * panel shows.
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../database";
import {
  agentTemplates,
  calls,
  callLatency,
  featureFlags,
  orgAgentConfigs,
  orgs,
  scheduledCalls,
  shopLinks,
  toolCalls,
  transcripts,
} from "../database/schema";
import type { AgentFrame } from "./agent-frame";

export async function getOrg(orgId: string) {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return org ?? null;
}

/** Every active template for the org's vertical, merged with the org's saved config row (or null). */
export async function getAgentConfigsForOrg(orgId: string) {
  const org = await getOrg(orgId);
  if (!org) return null;

  const templates = await db
    .select()
    .from(agentTemplates)
    .where(and(eq(agentTemplates.vertical, org.vertical), eq(agentTemplates.active, true)));
  const configs = await db.select().from(orgAgentConfigs).where(eq(orgAgentConfigs.orgId, orgId));
  const configByKey = new Map(configs.map((cfg) => [cfg.templateKey, cfg]));

  return templates.map((tmpl) => ({
    templateKey: tmpl.key,
    templateName: tmpl.name,
    templateDescription: tmpl.description,
    defaultPersonaPrompt: tmpl.defaultPersonaPrompt,
    config: configByKey.get(tmpl.key) ?? null,
  }));
}

/** Upsert one agent's frame config (AgentFrameSchema-validated by the caller). */
export async function upsertAgentConfig(orgId: string, templateKey: string, frame: AgentFrame) {
  const values = {
    personaPrompt: frame.personaPrompt,
    enabled: frame.enabled ?? true,
    name: frame.name,
    greetingLine: frame.greetingLine,
    closingLine: frame.closingLine,
    toneStyle: frame.toneStyle,
    voiceProvider: frame.voiceProvider,
    voiceId: frame.voiceId,
    language: frame.language,
    sttProvider: frame.sttProvider,
    llmProvider: frame.llmProvider,
    llmModel: frame.llmModel,
    toolsEnabled: frame.toolsEnabled,
    guardrails: frame.guardrails,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(orgAgentConfigs)
    .values({ orgId, templateKey, ...values })
    .onConflictDoUpdate({
      target: [orgAgentConfigs.orgId, orgAgentConfigs.templateKey],
      set: values,
    })
    .returning();
  return row!;
}

export async function listOrgCalls(orgId: string, limit = 200) {
  return db
    .select()
    .from(calls)
    .where(eq(calls.orgId, orgId))
    .orderBy(desc(calls.startedAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

/** One call, only if it belongs to this org — the merchant-side 404 guard. */
export async function getOrgCall(orgId: string, callId: number) {
  const [row] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

export async function getOrgCallTranscript(orgId: string, callId: number) {
  const call = await getOrgCall(orgId, callId);
  if (!call) return null;
  return db.select().from(transcripts).where(eq(transcripts.callId, callId));
}

export async function getOrgCallToolCalls(orgId: string, callId: number) {
  const call = await getOrgCall(orgId, callId);
  if (!call) return null;
  return db.select().from(toolCalls).where(eq(toolCalls.callId, callId));
}

/**
 * Shopify connection status + derived onboarding progress. Wizard state is
 * computed from what actually exists (a linked shop, enabled agents), never
 * stored — so it survives refresh/re-login and can't drift from reality.
 */
export async function getShopifyStatus(orgId: string) {
  const shops = await db
    .select({
      shop: shopLinks.shop,
      connectedAt: shopLinks.connectedAt,
      disconnectedAt: shopLinks.disconnectedAt,
      scopes: shopLinks.scopes,
    })
    .from(shopLinks)
    .where(eq(shopLinks.orgId, orgId));
  const enabled = await db
    .select({ enabled: orgAgentConfigs.enabled })
    .from(orgAgentConfigs)
    .where(and(eq(orgAgentConfigs.orgId, orgId), eq(orgAgentConfigs.enabled, true)));

  return {
    shops,
    hasShop: shops.some((s) => !s.disconnectedAt),
    enabledAgentCount: enabled.length,
    installUrl: buildInstallUrl(orgId),
  };
}

/**
 * The weebersh OAuth install URL for this org. The install flow is always
 * initiated from Weeber's side carrying org_id (see integrations/shopify/
 * routes.ts /connected) — WEEBERSH_INSTALL_URL is the weebersh app's install
 * entry point; org_id is appended as a query param. Null when unconfigured
 * (the UI shows a "not configured yet" state instead of a dead link).
 *
 * Also stamps `return_url` — where weebersh should send the merchant's
 * browser once its OAuth flow + /connected callback both succeed. This is
 * the explicit contract for "redirect back to Weeber" (full lifecycle:
 * enter domain on Weeber -> redirect to Shopify install (via weebersh) ->
 * install on Shopify -> weebersh calls back /connected -> weebersh redirects
 * browser to return_url). weebersh must carry BOTH org_id and return_url
 * through its OAuth `state`/session across the Shopify redirect — neither
 * survives on its own past the Shopify consent screen.
 */
export function buildInstallUrl(orgId: string, shop?: string): string | null {
  const base = process.env.WEEBERSH_INSTALL_URL;
  if (!base) return null;
  const sep = base.includes("?") ? "&" : "?";
  let url = `${base}${sep}org_id=${encodeURIComponent(orgId)}`;
  if (shop) {
    url += `&shop=${encodeURIComponent(shop)}`;
  }
  const publicAppUrl = process.env.PUBLIC_APP_URL;
  if (publicAppUrl) {
    const returnUrl = `${publicAppUrl.replace(/\/$/, "")}/app/shopify?shopify_connected=1`;
    url += `&return_url=${encodeURIComponent(returnUrl)}`;
  }
  return url;
}

/** Plan + computed usage for the billing page — read-only until the Razorpay workstream lands. */
export async function computeUsage(orgId: string, days = 30) {
  const org = await getOrg(orgId);
  if (!org) return null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ startedAt: calls.startedAt, endedAt: calls.endedAt })
    .from(calls)
    .where(and(eq(calls.orgId, orgId), gte(calls.startedAt, since)));
  const minutes = rows.reduce((sum, r) => {
    if (!r.endedAt) return sum;
    return sum + (r.endedAt.getTime() - r.startedAt.getTime()) / 60000;
  }, 0);
  return {
    rangeDays: days,
    planName: org.planName,
    currency: org.currency,
    calls: rows.length,
    minutes: Math.round(minutes * 10) / 10,
    /** Placeholder seam for the Razorpay integration (ADR-034: thin gateway abstraction). */
    gateway: null as null,
  };
}

/** Effective feature flags for an org: org-scoped rows overlay global (`orgId: ""`) rows. */
export async function getEffectiveFlags(orgId: string): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ key: featureFlags.key, orgId: featureFlags.orgId, enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(inArray(featureFlags.orgId, ["", orgId]));
  const flags: Record<string, boolean> = {};
  for (const row of rows.filter((r) => r.orgId === "")) flags[row.key] = row.enabled;
  for (const row of rows.filter((r) => r.orgId === orgId)) flags[row.key] = row.enabled;
  return flags;
}

/**
 * Org analytics: operational stats (calls/minutes/latency/dispositions/
 * tools/guardrails — the original shape) plus merchant KPIs. KPI rules
 * (CLAUDE-BUILD-BRIEF §5.4, "no fabricated metrics"):
 *   - a rate is null, not 0, when its denominator is 0 — the UI renders an
 *     empty state instead of a made-up 0%;
 *   - recovery revenue comes only from real attribution writes
 *     (scheduledCalls.recoveredOrderId/recoveredAmount, written by the
 *     orders/create webhook), parsed defensively since the amount column is
 *     text from Shopify's payload;
 *   - COD confirm rate counts confirmCodOrder tool calls with
 *     confirmed=true against executed COD scheduled calls — the two tables
 *     have no FK, so this is "confirmed / attempted", labeled as such;
 *   - feedback score averages the 1-5 `delivery_rating` capturedState field
 *     (docs/agent-prompts/03-feedback-agent.md's capture key).
 */
export async function computeOrgAnalytics(orgId: string, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const orgCalls = await db
    .select()
    .from(calls)
    .where(and(eq(calls.orgId, orgId), gte(calls.startedAt, since)));

  const totalCalls = orgCalls.length;
  const totalMinutes =
    orgCalls.reduce((sum, call) => {
      if (!call.endedAt) return sum;
      return sum + (call.endedAt.getTime() - call.startedAt.getTime()) / 60000;
    }, 0) || 0;

  const dispositionBreakdown: Record<string, number> = {};
  for (const call of orgCalls) {
    const key = call.disposition ?? "no-disposition";
    dispositionBreakdown[key] = (dispositionBreakdown[key] ?? 0) + 1;
  }

  const callIds = orgCalls.map((call) => call.id);

  const latencyRows =
    callIds.length > 0 ? await db.select().from(callLatency).where(inArray(callLatency.callId, callIds)) : [];
  const avg = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
  const avgLatency = {
    sttConnectMs: avg(latencyRows.map((r) => r.sttConnectMs).filter((v): v is number => v != null)),
    llmTtftMs: avg(latencyRows.map((r) => r.llmTtftMs).filter((v): v is number => v != null)),
    ttsFirstByteMs: avg(latencyRows.map((r) => r.ttsFirstByteMs).filter((v): v is number => v != null)),
  };

  const toolRows =
    callIds.length > 0 ? await db.select().from(toolCalls).where(inArray(toolCalls.callId, callIds)) : [];
  const toolUsageCounts: Record<string, number> = {};
  const guardrailEventCounts: Record<string, number> = {};
  for (const row of toolRows) {
    toolUsageCounts[row.toolName] = (toolUsageCounts[row.toolName] ?? 0) + 1;
    if (row.toolName === "flagGuardrailEvent" || row.toolName === "guardrail-heuristic-detector") {
      const category =
        row.input && typeof row.input === "object" && "category" in row.input
          ? String((row.input as { category: unknown }).category)
          : "unknown";
      guardrailEventCounts[category] = (guardrailEventCounts[category] ?? 0) + 1;
    }
  }

  const org = await getOrg(orgId);
  const kpis = await computeKpis(orgId, since, orgCalls, toolRows);

  const dailyVolume: { date: string; count: number }[] = [];
  const dayCounts: Record<string, number> = {};
  for (const call of orgCalls) {
    const day = call.startedAt.toISOString().slice(0, 10);
    dayCounts[day] = (dayCounts[day] ?? 0) + 1;
  }
  for (let d = new Date(since); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    dailyVolume.push({ date: key, count: dayCounts[key] ?? 0 });
  }

  return {
    rangeDays: days,
    totalCalls,
    totalMinutes: Math.round(totalMinutes * 10) / 10,
    dispositionBreakdown,
    avgLatency,
    toolUsageCounts,
    guardrailEventCounts,
    dailyVolume,
    currency: org?.currency ?? null,
    kpis,
  };
}

type OrgCallRow = typeof calls.$inferSelect;
type ToolCallRow = typeof toolCalls.$inferSelect;

async function computeKpis(orgId: string, since: Date, orgCalls: OrgCallRow[], toolRows: ToolCallRow[]) {
  const scheduled = await db
    .select({
      workflowName: scheduledCalls.workflowName,
      status: scheduledCalls.status,
      recoveredOrderId: scheduledCalls.recoveredOrderId,
      recoveredAmount: scheduledCalls.recoveredAmount,
    })
    .from(scheduledCalls)
    .where(and(eq(scheduledCalls.orgId, orgId), gte(scheduledCalls.createdAt, since)));

  // Cart recovery — attribution written by the orders/create webhook.
  const recoveryRows = scheduled.filter((s) => s.workflowName === "shopify-cart-recovery");
  const recoveryExecuted = recoveryRows.filter((s) => s.status === "executed").length;
  const recoveredRows = recoveryRows.filter((s) => s.recoveredOrderId != null);
  let recoveredRevenue = 0;
  for (const row of recoveredRows) {
    const amount = Number.parseFloat(row.recoveredAmount ?? "");
    if (Number.isFinite(amount)) recoveredRevenue += amount;
  }
  const recovery =
    recoveryExecuted === 0 && recoveredRows.length === 0
      ? null
      : {
          attemptedCalls: recoveryExecuted,
          recoveredOrders: recoveredRows.length,
          recoveredRevenue: Math.round(recoveredRevenue * 100) / 100,
          recoveryRate: recoveryExecuted > 0 ? recoveredRows.length / recoveryExecuted : null,
        };

  // COD confirmation — "confirmed / attempted" (no FK between the tables).
  const codAttempted = scheduled.filter(
    (s) => s.workflowName === "shopify-cod-confirmation" && s.status === "executed",
  ).length;
  const codConfirmed = toolRows.filter((t) => {
    if (t.toolName !== "confirmCodOrder") return false;
    const source = (t.output ?? t.input) as { confirmed?: unknown } | null;
    return Boolean(source && typeof source === "object" && source.confirmed === true);
  }).length;
  const codConfirmation =
    codAttempted === 0
      ? null
      : {
          attemptedCalls: codAttempted,
          confirmedOrders: codConfirmed,
          confirmRate: codConfirmed / codAttempted > 1 ? 1 : codConfirmed / codAttempted,
        };

  // Feedback — average of the 1-5 delivery_rating capturedState values.
  const ratings: number[] = [];
  for (const call of orgCalls) {
    const raw = (call.capturedState as Record<string, unknown> | null)?.["delivery_rating"];
    const rating = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
    if (Number.isFinite(rating) && rating >= 1 && rating <= 5) ratings.push(rating);
  }
  const feedback =
    ratings.length === 0
      ? null
      : {
          responses: ratings.length,
          averageRating: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10,
        };

  return { recovery, codConfirmation, feedback };
}
