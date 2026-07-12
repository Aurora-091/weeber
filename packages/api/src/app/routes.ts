/**
 * Merchant-facing API — everything under /api/app/*. Mounted once in
 * ../index.ts via `.route('/app', merchantApp)`.
 *
 * Auth: Supabase session (or an audited admin impersonation token) via
 * requireMerchantSession — see middleware/supabase-auth.ts. The org is
 * always resolved from the session's membership row, never from a path
 * param: a merchant can't address another org by construction. Query/
 * aggregation logic is shared with the admin panel's /api/voice/orgs/:orgId/*
 * routes (voice/org-queries.ts) so both surfaces report identical data.
 *
 * /me is the only route that runs without an org: it's where the first-login
 * bootstrap happens (auto-create an org + owner membership, so signup is
 * fully self-serve — the Shopify install URL then carries this org's id into
 * weebersh's OAuth flow, which links the shop back via POST /connected).
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../database";
import { orgMembers, orgs } from "../database/schema";
import { AgentFrameSchema } from "../voice/agent-frame";
import { generatePreviewAudio } from "../voice/tts-preview";
import { listVoicesForProvider, fetchCartesiaPreviewAudio } from "../voice/voices-catalog";
import {
  requireMerchantSession,
  requireMerchantOrg,
  type MerchantSessionVariables,
} from "./middleware/supabase-auth";
import { stopImpersonation } from "./impersonation";
import { submitSupportTicket } from "./support";
import {
  getOrg,
  getAgentConfigsForOrg,
  upsertAgentConfig,
  computeOrgAnalytics,
  listOrgCalls,
  getOrgCall,
  getOrgCallTranscript,
  getOrgCallToolCalls,
  getShopifyStatus,
  buildInstallUrl,
  computeUsage,
  getEffectiveFlags,
} from "../voice/org-queries";
import { buildOrdersWorkbook, buildAnalyticsWorkbook, buildTranscriptsWorkbook } from "./export";

type MerchantEnv = { Variables: MerchantSessionVariables };

/**
 * First-login bootstrap: one org + owner membership per new user.
 * Idempotent under races — the unique (user, org) index plus re-select means
 * two concurrent first requests still end up with exactly one membership.
 */
async function resolveOrCreateMembership(userId: string, email: string | null) {
  const [existing] = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.supabaseUserId, userId))
    .limit(1);
  if (existing) return existing;

  const orgId = `org_${randomUUID()}`;
  const name = email ? `${email.split("@")[0]}'s workspace` : "My workspace";
  await db.insert(orgs).values({ id: orgId, name, contactEmail: email ?? undefined }).onConflictDoNothing();
  await db.insert(orgMembers).values({ supabaseUserId: userId, orgId, role: "owner" }).onConflictDoNothing();

  // Re-select rather than trusting our insert — if a concurrent request won
  // the race with a different org id, this returns the row that actually stuck.
  const [row] = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.supabaseUserId, userId))
    .limit(1);
  return row ?? { orgId, role: "owner" };
}

// Per-org fixed-window limiter for the TTS preview — merchants now reach a
// paid TTS API, so this can't be unmetered like the admin-key version.
const PREVIEW_WINDOW_MS = 60_000;
const PREVIEW_MAX_PER_WINDOW = Number(process.env.VOICE_PREVIEW_RATE_LIMIT ?? 20);
const previewWindows = new Map<string, { start: number; count: number }>();

function previewRateLimited(orgId: string): boolean {
  const now = Date.now();
  const window = previewWindows.get(orgId);
  if (!window || now - window.start >= PREVIEW_WINDOW_MS) {
    previewWindows.set(orgId, { start: now, count: 1 });
    return false;
  }
  window.count += 1;
  return window.count > PREVIEW_MAX_PER_WINDOW;
}

export const merchantApp = new Hono<MerchantEnv>()
  .use("*", requireMerchantSession)

  // Session/org resolution + first-login bootstrap. The one route without requireMerchantOrg.
  .get("/me", async (c) => {
    const impersonated = c.get("impersonated");
    let orgId = c.get("merchantOrgId");
    let role = c.get("merchantRole");
    const userId = c.get("merchantUserId");
    const email = c.get("merchantEmail");

    if (!orgId && !impersonated && userId) {
      const membership = await resolveOrCreateMembership(userId, email);
      orgId = membership.orgId;
      role = membership.role;
    }
    if (!orgId) {
      return c.json({ error: "No organization for this session", code: "no_org" }, 403);
    }

    const org = await getOrg(orgId);
    if (!org) return c.json({ error: "Organization not found", code: "no_org" }, 403);

    return c.json(
      {
        user: userId ? { id: userId, email } : null,
        role,
        impersonated,
        org: {
          id: org.id,
          name: org.name,
          vertical: org.vertical,
          planName: org.planName,
          currency: org.currency,
          countryCode: org.countryCode,
          timezone: org.timezone,
          contactEmail: org.contactEmail,
        },
      },
      200,
    );
  })

  // Everything below requires a resolved org.
  .use("*", requireMerchantOrg)

  .get("/agent-configs", async (c) => {
    const merged = await getAgentConfigsForOrg(c.get("merchantOrgId")!);
    if (!merged) return c.json({ error: "org not found" }, 404);
    return c.json({ agentConfigs: merged }, 200);
  })

  .put("/agent-configs/:templateKey", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AgentFrameSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid agent config", details: parsed.error.issues }, 400);
    }
    const row = await upsertAgentConfig(c.get("merchantOrgId")!, c.req.param("templateKey"), parsed.data);
    return c.json({ agentConfig: row }, 200);
  })

  .post("/agent-configs/:templateKey/test-chat", async (c) => {
    const orgId = c.get("merchantOrgId")!;
    const templateKey = c.req.param("templateKey");
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages)) {
      return c.json({ error: "body must include `messages` (array)" }, 400);
    }

    const { resolveAgentConfig, voiceTools, buildKnownFactsBlock } = await import("../voice/agent");
    const { resolveVoiceModel, getActiveModelLabel } = await import("../voice/llm");
    const { streamText, stepCountIs } = await import("ai");

    const agentConfig = await resolveAgentConfig({ orgId, templateKey });
    const model = resolveVoiceModel(agentConfig.llmProvider, agentConfig.llmModel);
    const modelLabel = getActiveModelLabel(agentConfig.llmProvider, agentConfig.llmModel);

    const enabledToolNames = agentConfig.enabledTools;
    let tools = voiceTools;
    if (enabledToolNames) {
      const allowed = new Set([...enabledToolNames, "hangUp"]);
      tools = Object.fromEntries(
        Object.entries(voiceTools).filter(([name]) => allowed.has(name as never)),
      ) as typeof voiceTools;
    }

    const messages = body.messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    let fullText = "";
    const toolCallsList: { name: string; input: unknown }[] = [];

    try {
      const result = streamText({
        model,
        system: agentConfig.systemPrompt + buildKnownFactsBlock({}),
        messages,
        tools,
        stopWhen: stepCountIs(4),
        onStepFinish: (step) => {
          for (const call of step.toolCalls ?? []) {
            toolCallsList.push({ name: call.toolName, input: call.input });
          }
        },
      });

      for await (const delta of result.textStream) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        fullText += delta;
      }

      const usage = await result.usage;
      const latencyMs = firstTokenAt ? firstTokenAt - startedAt : Date.now() - startedAt;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      const estimatedCost = (inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000;

      return c.json({
        response: fullText || "(No text output — agent may have only called tools.)",
        latencyMs,
        model: modelLabel,
        inputTokens,
        outputTokens,
        estimatedCost: Math.round(estimatedCost * 10000) / 10000,
        toolCalls: toolCallsList,
      }, 200);
    } catch (err) {
      return c.json({ error: "LLM call failed", detail: String(err) }, 502);
    }
  })

  .get("/voices", async (c) => {
    const provider = c.req.query("provider") ?? "";
    if (!["elevenlabs", "cartesia", "sarvam"].includes(provider)) {
      return c.json({ error: "`provider` must be \"elevenlabs\", \"cartesia\", or \"sarvam\"" }, 400);
    }
    const voices = await listVoicesForProvider(provider);
    return c.json({ voices }, 200);
  })

  .get("/voices/cartesia-preview/:id", async (c) => {
    const result = await fetchCartesiaPreviewAudio(c.req.param("id"));
    if (!result) return c.json({ error: "Preview not available for this voice" }, 502);
    return c.body(result.body, 200, { "Content-Type": result.contentType });
  })

  .post("/voice-preview", async (c) => {
    const orgId = c.get("merchantOrgId")!;
    if (previewRateLimited(orgId)) {
      return c.json({ error: "Too many voice previews — try again in a minute" }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { text, voiceProvider, voiceId, language } = body as { text?: string; voiceProvider?: string; voiceId?: string; language?: string };
    if (!text || !text.trim()) return c.json({ error: "`text` is required" }, 400);
    if (voiceProvider !== "elevenlabs" && voiceProvider !== "cartesia" && voiceProvider !== "sarvam") {
      return c.json({ error: '`voiceProvider` must be "elevenlabs", "cartesia", or "sarvam"' }, 400);
    }
    try {
      const wav = await generatePreviewAudio(text.slice(0, 300), voiceProvider, voiceId, language);
      return c.body(new Uint8Array(wav), 200, { "Content-Type": "audio/wav" });
    } catch (err) {
      console.error("[app] voice preview generation failed", err);
      return c.json({ error: "Failed to generate voice preview — check the voice ID" }, 502);
    }
  })

  .get("/calls", async (c) => {
    const limit = Number(c.req.query("limit")) || 200;
    const rows = await listOrgCalls(c.get("merchantOrgId")!, limit);
    return c.json({ calls: rows }, 200);
  })

  .get("/calls/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const row = await getOrgCall(c.get("merchantOrgId")!, id);
    if (!row) return c.json({ error: "call not found" }, 404);
    return c.json({ call: row }, 200);
  })

  .get("/calls/:id/transcript", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const rows = await getOrgCallTranscript(c.get("merchantOrgId")!, id);
    if (!rows) return c.json({ error: "call not found" }, 404);
    return c.json({ transcript: rows }, 200);
  })

  .get("/calls/:id/tool-calls", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const rows = await getOrgCallToolCalls(c.get("merchantOrgId")!, id);
    if (!rows) return c.json({ error: "call not found" }, 404);
    return c.json({ toolCalls: rows }, 200);
  })

  .get("/analytics", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
    const analytics = await computeOrgAnalytics(c.get("merchantOrgId")!, days);
    return c.json(analytics, 200);
  })

  .get("/billing/usage", async (c) => {
    const usage = await computeUsage(c.get("merchantOrgId")!);
    if (!usage) return c.json({ error: "org not found" }, 404);
    return c.json(usage, 200);
  })

  .get("/shopify/status", async (c) => {
    const status = await getShopifyStatus(c.get("merchantOrgId")!);
    return c.json(status, 200);
  })

  .post("/shopify/install-url", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { shop } = body as { shop?: string };
    if (!shop?.trim()) return c.json({ error: "`shop` is required" }, 400);
    const domain = shop.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const normalized = domain.endsWith(".myshopify.com") ? domain : `${domain}.myshopify.com`;
    const url = buildInstallUrl(c.get("merchantOrgId")!, normalized);
    if (!url) return c.json({ error: "Shopify install is not configured yet" }, 503);
    return c.json({ installUrl: url }, 200);
  })

  // On-demand .xlsx exports for the Integrations page's "Download as Excel"
  // cards. No scheduling, no email, no external spreadsheet OAuth — see
  // export.ts.
  .get("/export/orders.xlsx", async (c) => {
    const buffer = await buildOrdersWorkbook(c.get("merchantOrgId")!);
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    c.header("Content-Disposition", `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return c.body(new Uint8Array(buffer));
  })

  .get("/export/analytics.xlsx", async (c) => {
    const buffer = await buildAnalyticsWorkbook(c.get("merchantOrgId")!);
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    c.header("Content-Disposition", `attachment; filename="call-analytics-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return c.body(new Uint8Array(buffer));
  })

  .get("/export/transcripts.xlsx", async (c) => {
    const buffer = await buildTranscriptsWorkbook(c.get("merchantOrgId")!);
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    c.header("Content-Disposition", `attachment; filename="transcripts-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return c.body(new Uint8Array(buffer));
  })

  .get("/flags", async (c) => {
    const flags = await getEffectiveFlags(c.get("merchantOrgId")!);
    return c.json({ flags }, 200);
  })

  // Merchant support submission — same underlying table as the public
  // landing-page form (public-routes.ts), just with orgId known.
  .post("/support", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { subject, message } = body as { subject?: string; message?: string };
    if (!subject?.trim() || !message?.trim()) return c.json({ error: "`subject` and `message` are required" }, 400);
    const ticket = await submitSupportTicket({
      orgId: c.get("merchantOrgId"),
      email: c.get("merchantEmail") ?? "unknown",
      subject,
      message,
    });
    if (!ticket) return c.json({ error: "Failed to submit ticket" }, 500);
    return c.json({ submitted: true }, 201);
  })

  // Self-stop for the "Viewing as <org>" banner: the /app tab only holds the
  // impersonation token (the admin key lives in the dashboard tab's session
  // storage), so ending the session must be possible with the token itself.
  // The audit row gets its endedAt/endedReason either way.
  .post("/impersonation/stop", async (c) => {
    const sessionId = c.get("impersonationSessionId");
    if (!sessionId) return c.json({ error: "not an impersonated session" }, 400);
    const stopped = await stopImpersonation(sessionId);
    return c.json({ stopped }, 200);
  });
