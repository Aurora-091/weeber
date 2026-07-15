/**
 * User-facing API — everything under /api/app/*. Mounted once in
 * ../index.ts via `.route('/app', userApp)`.
 *
 * Auth: Supabase session via requireUserSession — see
 * middleware/supabase-auth.ts. The org is always resolved from the
 * session's membership row, never from a path param: a user can't
 * address another org by construction. Query/aggregation logic is shared
 * with the admin panel's /api/voice/orgs/:orgId/* routes
 * (voice/org-queries.ts) so both surfaces report identical data.
 *
 * /me is the only route that runs without an org: it's where the first-login
 * bootstrap happens (auto-create an org + owner membership, so signup is
 * fully self-serve — the Shopify install URL then carries this org's id into
 * weebersh's OAuth flow, which links the shop back via POST /connected).
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../database";
import { orgMembers, orgs, workflowTemplates, orgWorkflowConfigs, orgPhoneNumbers } from "../database/schema";
import { AgentFrameSchema } from "../voice/agent-frame";
import { generatePreviewAudio } from "../voice/tts-preview";
import { listVoicesForProvider, fetchCartesiaPreviewAudio } from "../voice/voices-catalog";
import { makeFixedWindowLimiter } from "../voice/fixed-window-limiter";
import { issueTestCallToken } from "../voice/test-call-tokens";
import {
  requireUserSession,
  requireUserOrg,
  type UserSessionVariables,
} from "./middleware/supabase-auth";
import { submitSupportTicket } from "./support";
import {
  getOrg,
  getAgentConfigsForOrg,
  upsertAgentConfig,
  assignPhoneNumberToAgent,
  computeOrgAnalytics,
  listOrgCalls,
  getOrgCall,
  getOrgCallTranscript,
  getOrgCallToolCalls,
  getShopifyStatus,
  buildInstallUrl,
  computeUsage,
  getEffectiveFlags,
  getOnboardingState,
  updateOnboardingState,
  listOrgOrderCalls,
} from "../voice/org-queries";
import { buildOrdersWorkbook, buildAnalyticsWorkbook, buildTranscriptsWorkbook } from "./export";
import { callScheduledRowNow } from "../voice/workflows/scheduler";
import {
  getTwilioStatus,
  createSubaccountForOrg,
  buyNumberForOrg,
  listAvailableNumbers,
  releaseNumberForOrg,
  setByoCredentials,
  resetToPlatformDefault,
} from "../voice/twilio-provisioning";
import { getPlivoStatus, setPlivoByoCredentials } from "../voice/plivo-provisioning";
import { getExotelStatus, setExotelByoCredentials } from "../voice/exotel-provisioning";
import { dispatchWebhook, resolveWebhookUrl } from "../voice/webhooks";
import { isValidE164 } from "../voice/validation";
import { placeOutboundCall } from "../voice/place-outbound-call";
import { sessionStore } from "../voice/session-store";
import { listKnowledgeDocuments } from "../voice/knowledge-base";

type UserEnv = { Variables: UserSessionVariables };

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

  await db.transaction(async (tx) => {
    await tx.insert(orgs).values({ id: orgId, name, contactEmail: email ?? undefined }).onConflictDoNothing();
    await tx.insert(orgMembers).values({ supabaseUserId: userId, orgId, role: "owner" }).onConflictDoNothing();
  });

  // Re-select rather than trusting our insert — if a concurrent request won
  // the race with a different org id, this returns the row that actually stuck.
  const [row] = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.supabaseUserId, userId))
    .limit(1);
  return row ?? { orgId, role: "owner" };
}

// makeFixedWindowLimiter now lives in voice/fixed-window-limiter.ts (shared
// with test-call-tokens.ts's issuance limiter) — see that file's doc
// comment. Kept the same per-org fixed-window shape, just extracted.

// Per-org fixed-window limiter for the TTS preview — users now reach a
// paid TTS API, so this can't be unmetered like the admin-key version.
const PREVIEW_WINDOW_MS = 60_000;
const PREVIEW_MAX_PER_WINDOW = Number(process.env.VOICE_PREVIEW_RATE_LIMIT ?? 20);
const previewRateLimited = makeFixedWindowLimiter(PREVIEW_WINDOW_MS, PREVIEW_MAX_PER_WINDOW);

// Webhook test-send: merchant-triggered, so cheap abuse gate rather than a
// COGS concern (no telephony/TTS spend) — same shape as previewRateLimited.
const WEBHOOK_TEST_WINDOW_MS = 60_000;
const WEBHOOK_TEST_MAX_PER_WINDOW = Number(process.env.WEBHOOK_TEST_RATE_LIMIT ?? 10);
const webhookTestRateLimited = makeFixedWindowLimiter(WEBHOOK_TEST_WINDOW_MS, WEBHOOK_TEST_MAX_PER_WINDOW);

// A3b — Knowledge Base ingestion: real embedding-API cost + can take a few
// seconds (PDF parse + embed), so a tighter limiter than most — uploads are
// an infrequent, human-paced action, not something that needs headroom.
const KB_INGEST_WINDOW_MS = 60_000;
const KB_INGEST_MAX_PER_WINDOW = Number(process.env.KB_INGEST_RATE_LIMIT ?? 5);
const knowledgeBaseIngestRateLimited = makeFixedWindowLimiter(KB_INGEST_WINDOW_MS, KB_INGEST_MAX_PER_WINDOW);
const KB_MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB

// Misc-1: real PSTN test call — separate, tighter limiter than the free web
// test call (testCallRateLimited) since this one has real per-call COGS,
// not just abuse-prevention concerns.
const TEST_CALL_PHONE_WINDOW_MS = 60_000;
const TEST_CALL_PHONE_MAX_PER_WINDOW = Number(process.env.AGENT_TEST_CALL_PHONE_RATE_LIMIT ?? 3);
const testCallPhoneRateLimited = makeFixedWindowLimiter(TEST_CALL_PHONE_WINDOW_MS, TEST_CALL_PHONE_MAX_PER_WINDOW);

// Per-org fixed-window limiter for the agent test-chat sandbox — every
// message is a real, billed LLM call (same model/provider a live call would
// use), so this needs the same "can't be unmetered" treatment as TTS
// preview, not a separate one-off. A tighter default than preview since a
// chat session is naturally multi-turn (one click can trigger many calls).
const TEST_CHAT_WINDOW_MS = 60_000;
const TEST_CHAT_MAX_PER_WINDOW = Number(process.env.AGENT_TEST_CHAT_RATE_LIMIT ?? 15);
const testChatRateLimited = makeFixedWindowLimiter(TEST_CHAT_WINDOW_MS, TEST_CHAT_MAX_PER_WINDOW);

// Per-org fixed-window limiter for issuing live voice test-call tokens —
// each token leads to a real STT+LLM+TTS session (metered upstreams), so
// this gates issuance the same way testChatRateLimited gates test-chat.
const TEST_CALL_WINDOW_MS = 60_000;
const TEST_CALL_MAX_PER_WINDOW = Number(process.env.AGENT_TEST_CALL_RATE_LIMIT ?? 5);
const testCallRateLimited = makeFixedWindowLimiter(TEST_CALL_WINDOW_MS, TEST_CALL_MAX_PER_WINDOW);

export const userApp = new Hono<UserEnv>()
  .use("*", requireUserSession)

  // Session/org resolution + first-login bootstrap. The one route without requireUserOrg.
  .get("/me", async (c) => {
    let orgId = c.get("userOrgId");
    let role = c.get("userRole");
    const userId = c.get("userUserId");
    const email = c.get("userEmail");

    if (!orgId && userId) {
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
        org: {
          id: org.id,
          name: org.name,
          vertical: org.vertical,
          planName: org.planName,
          currency: org.currency,
          countryCode: org.countryCode,
          timezone: org.timezone,
          contactEmail: org.contactEmail,
          webhookUrl: org.webhookUrl,
          callingWindowTestModeUntil: org.callingWindowTestModeUntil,
        },
      },
      200,
    );
  })

  // Everything below requires a resolved org.
  .use("*", requireUserOrg)

  .patch("/settings", async (c) => {
    const orgId = c.get("userOrgId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Expected a JSON object" }, 400);
    }
    const allowed = ["name", "timezone", "countryCode", "contactEmail", "webhookUrl", "vertical"] as const;
    const updates: Record<string, string | null> = {};
    for (const key of allowed) {
      if (key in body) {
        const val = body[key];
        if (val !== null && typeof val !== "string") {
          return c.json({ error: `${key} must be a string or null` }, 400);
        }
        if (key === "webhookUrl" && val) {
          if (!/^https?:\/\//i.test(val)) {
            return c.json({ error: "webhookUrl must start with http:// or https://" }, 400);
          }
        }
        // Keep in sync with lib/verticals.ts's VERTICALS registry on the
        // frontend (no shared package between packages/api and packages/web
        // today, so this is a small deliberate duplication rather than a
        // cross-package import) — see the 2026-07-16 onboarding rework.
        if (key === "vertical" && val !== null && !["shopify", "insurance"].includes(val)) {
          return c.json({ error: `vertical must be one of: shopify, insurance` }, 400);
        }
        updates[key] = val ?? null;
      }
    }
    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No valid fields to update" }, 400);
    }
    await db.update(orgs).set(updates).where(eq(orgs.id, orgId));
    const org = await getOrg(orgId);
    return c.json({
      org: {
        id: org!.id,
        name: org!.name,
        vertical: org!.vertical,
        planName: org!.planName,
        currency: org!.currency,
        countryCode: org!.countryCode,
        timezone: org!.timezone,
        contactEmail: org!.contactEmail,
        webhookUrl: org!.webhookUrl,
      },
    }, 200);
  })

  // Org-scoped mirror of voice/routes.ts's admin /webhooks/test — fires a
  // sample call.started event at the org's saved webhookUrl (or an
  // explicit override in the body), so merchants can verify their
  // n8n/Zapier/Make target before it matters on a real call.
  .post("/webhooks/test", async (c) => {
    const orgId = c.get("userOrgId")!;
    if (webhookTestRateLimited(orgId)) {
      return c.json({ error: "Too many test sends — try again in a minute." }, 429);
    }
    const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
    const org = await getOrg(orgId);
    const target = resolveWebhookUrl(body.url || org?.webhookUrl);
    if (!target) {
      return c.json({ error: "No webhook URL set. Save one in Settings first, or pass one in the request." }, 400);
    }
    await dispatchWebhook(target, "call.started", {
      callSid: "TEST_CALL_SID",
      direction: "outbound",
      from: "+15550000000",
      to: "+15550000001",
      note: "This is a test event from /api/app/webhooks/test",
    });
    return c.json({ sent: true, target }, 200);
  })

  .get("/agent-configs", async (c) => {
    const merged = await getAgentConfigsForOrg(c.get("userOrgId")!);
    if (!merged) return c.json({ error: "org not found" }, 404);
    return c.json({ agentConfigs: merged }, 200);
  })

  .put("/agent-configs/:templateKey", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AgentFrameSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid agent config", details: parsed.error.issues }, 400);
    }
    const row = await upsertAgentConfig(c.get("userOrgId")!, c.req.param("templateKey"), parsed.data);
    return c.json({ agentConfig: row }, 200);
  })

  // C2b — assign/unassign which org number this agent dials out from.
  // Separate from the PUT above since phoneNumberId is a plain FK column,
  // not part of AgentFrameSchema's jsonb config.
  .put("/agent-configs/:templateKey/number", async (c) => {
    const orgId = c.get("userOrgId")!;
    const body = await c.req.json().catch(() => null);
    const { phoneNumberId } = (body ?? {}) as { phoneNumberId?: number | null };
    if (phoneNumberId !== null && !Number.isInteger(phoneNumberId)) {
      return c.json({ error: "`phoneNumberId` must be an integer or null (to unassign)" }, 400);
    }
    const result = await assignPhoneNumberToAgent(orgId, c.req.param("templateKey"), phoneNumberId ?? null);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true }, 200);
  })

  .post("/agent-configs/:templateKey/test-chat", async (c) => {
    const orgId = c.get("userOrgId")!;
    const templateKey = c.req.param("templateKey");
    if (testChatRateLimited(orgId)) {
      return c.json(
        { error: `Rate limit exceeded — max ${TEST_CHAT_MAX_PER_WINDOW} test messages per minute. Try again shortly.` },
        429,
      );
    }
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages)) {
      return c.json({ error: "body must include `messages` (array)" }, 400);
    }

    const { resolveAgentConfig, buildPreviewAgentConfig, buildVoiceTools, buildKnownFactsBlock } = await import("../voice/agent");
    const { resolveVoiceModel, getActiveModelLabel, estimateLlmCost, resolveLlmProvider } = await import("../voice/llm");
    const { streamText, stepCountIs } = await import("ai");

    // configOverride (optional): the Preview drawer's whole point is testing
    // what's currently in the form, not what's already saved — see
    // buildPreviewAgentConfig's doc comment in voice/agent.ts.
    let agentConfig;
    if (body.configOverride && typeof body.configOverride === "object") {
      const parsedOverride = AgentFrameSchema.safeParse(body.configOverride);
      if (!parsedOverride.success) {
        return c.json({ error: "Invalid configOverride", details: parsedOverride.error.issues }, 400);
      }
      agentConfig = await buildPreviewAgentConfig(templateKey, parsedOverride.data);
    } else {
      agentConfig = await resolveAgentConfig({ orgId, templateKey });
    }
    const model = resolveVoiceModel(agentConfig.llmProvider, agentConfig.llmModel);
    const modelLabel = getActiveModelLabel(agentConfig.llmProvider, agentConfig.llmModel);

    // A3b: buildVoiceTools binds lookupInfo's knowledge-base search to this
    // org, same as a real call — the test-chat sandbox should search the
    // same KB a live call would, not a stubbed/no-org version of it.
    const tools = buildVoiceTools(orgId, agentConfig.enabledTools);

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
      const estimatedCost = estimateLlmCost(resolveLlmProvider(agentConfig.llmProvider), inputTokens, outputTokens);

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

  .post("/agent-configs/:templateKey/test-call-token", async (c) => {
    const orgId = c.get("userOrgId")!;
    const templateKey = c.req.param("templateKey");
    if (testCallRateLimited(orgId)) {
      return c.json(
        { error: `Rate limit exceeded — max ${TEST_CALL_MAX_PER_WINDOW} test calls per minute. Try again shortly.` },
        429,
      );
    }
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    let configOverride;
    if (body && typeof body === "object" && "configOverride" in body && body.configOverride && typeof body.configOverride === "object") {
      const parsedOverride = AgentFrameSchema.safeParse(body.configOverride);
      if (!parsedOverride.success) {
        return c.json({ error: "Invalid configOverride", details: parsedOverride.error.issues }, 400);
      }
      configOverride = parsedOverride.data;
    }
    const token = issueTestCallToken({ orgId, templateKey, configOverride, actor: orgId });
    return c.json({ token }, 201);
  })

  // Misc-1: real PSTN callback from the Agent Preview — "enter your number,
  // call me". Distinct from the web-based test call above (test-call-token,
  // no telephony cost): this actually dials out via the org's real
  // provider, so real STT/LLM/TTS/telephony COGS applies. Own rate limiter
  // since that's a cost concern, not just abuse prevention. Compliance
  // gates (DNC/calling-window) are deliberately skipped — this is the
  // merchant testing their own number, by their own immediate request, not
  // a cold outbound marketing call.
  .post("/agent-configs/:templateKey/test-call-phone", async (c) => {
    const orgId = c.get("userOrgId")!;
    const templateKey = c.req.param("templateKey");
    if (testCallPhoneRateLimited(orgId)) {
      return c.json(
        { error: `Rate limit exceeded — max ${TEST_CALL_PHONE_MAX_PER_WINDOW} test calls per minute. Try again shortly.` },
        429,
      );
    }
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const phone = typeof body?.phone === "string" ? body.phone : "";
    if (!isValidE164(phone)) {
      return c.json({ error: "`phone` must be a valid E.164 number, e.g. +15551234567" }, 400);
    }
    let configOverride = {};
    if (body && typeof body === "object" && "configOverride" in body && body.configOverride && typeof body.configOverride === "object") {
      const parsedOverride = AgentFrameSchema.safeParse(body.configOverride);
      if (!parsedOverride.success) {
        return c.json({ error: "Invalid configOverride", details: parsedOverride.error.issues }, 400);
      }
      configOverride = parsedOverride.data;
    }

    const { buildPreviewAgentConfig } = await import("../voice/agent");
    const resolvedConfigOverride = await buildPreviewAgentConfig(templateKey, configOverride);
    const placed = await placeOutboundCall({ orgId, to: phone, agentKey: templateKey });
    if (!placed.ok) return c.json({ error: placed.error }, placed.statusCode);

    await sessionStore.set(placed.sessionKey, {
      callSid: placed.sessionKey,
      direction: "outbound",
      orgId,
      resolvedConfigOverride,
    });

    return c.json({ callSid: placed.sessionKey, status: placed.status }, 201);
  })

  .get("/voices", async (c) => {
    const provider = c.req.query("provider") ?? "";
    if (!["elevenlabs", "cartesia", "sarvam"].includes(provider)) {
      return c.json({ error: "`provider` must be \"elevenlabs\", \"cartesia\", or \"sarvam\"" }, 400);
    }
    const voices = await listVoicesForProvider(provider, "user");
    return c.json({ voices }, 200);
  })

  .get("/voices/cartesia-preview/:id", async (c) => {
    const result = await fetchCartesiaPreviewAudio(c.req.param("id"));
    if (!result) return c.json({ error: "Preview not available for this voice" }, 502);
    return c.body(result.body, 200, { "Content-Type": result.contentType });
  })

  .post("/voice-preview", async (c) => {
    const orgId = c.get("userOrgId")!;
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
    const rows = await listOrgCalls(c.get("userOrgId")!, limit);
    return c.json({ calls: rows }, 200);
  })

  .get("/calls/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const row = await getOrgCall(c.get("userOrgId")!, id);
    if (!row) return c.json({ error: "call not found" }, 404);
    return c.json({ call: row }, 200);
  })

  .get("/calls/:id/transcript", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const rows = await getOrgCallTranscript(c.get("userOrgId")!, id);
    if (!rows) return c.json({ error: "call not found" }, 404);
    return c.json({ transcript: rows }, 200);
  })

  .get("/calls/:id/tool-calls", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const rows = await getOrgCallToolCalls(c.get("userOrgId")!, id);
    if (!rows) return c.json({ error: "call not found" }, 404);
    return c.json({ toolCalls: rows }, 200);
  })

  .get("/analytics", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
    const analytics = await computeOrgAnalytics(c.get("userOrgId")!, days);
    return c.json(analytics, 200);
  })

  .get("/billing/usage", async (c) => {
    const usage = await computeUsage(c.get("userOrgId")!);
    if (!usage) return c.json({ error: "org not found" }, 404);
    return c.json(usage, 200);
  })

  // Setup modal state — see components/app/setup-modal.tsx. Steps are a
  // free-form jsonb bag (ONBOARDING_STEP_KEYS in org-queries.ts) so the
  // modal can change its step set without a migration.
  .get("/onboarding", async (c) => {
    const state = await getOnboardingState(c.get("userOrgId")!);
    return c.json(
      { steps: state.steps, dismissed: state.dismissed, completedAt: state.completedAt },
      200,
    );
  })

  .patch("/onboarding", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { steps, dismissed } = (body ?? {}) as { steps?: Record<string, boolean>; dismissed?: boolean };
    if (steps !== undefined && (typeof steps !== "object" || steps === null)) {
      return c.json({ error: "`steps`, if present, must be an object" }, 400);
    }
    if (dismissed !== undefined && typeof dismissed !== "boolean") {
      return c.json({ error: "`dismissed`, if present, must be a boolean" }, 400);
    }
    const state = await updateOnboardingState(c.get("userOrgId")!, { steps, dismissed });
    return c.json(
      { steps: state.steps, dismissed: state.dismissed, completedAt: state.completedAt },
      200,
    );
  })

  // "Turn off compliance for testing" (2026-07-16) — self-expiring, org-
  // scoped, bypasses ONLY the calling-window/TCPA-TRAI check (never DNC,
  // no exceptions — see scheduler.ts's checkCallingWindowForRow). Always
  // sets to now()+24h on enable rather than accepting an arbitrary duration
  // from the client, specifically so it can't be left on indefinitely.
  .post("/compliance/test-mode", async (c) => {
    const orgId = c.get("userOrgId")!;
    const body = await c.req.json().catch(() => null);
    const { enabled } = (body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return c.json({ error: "`enabled` (boolean) is required" }, 400);
    }
    const callingWindowTestModeUntil = enabled ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;
    await db.update(orgs).set({ callingWindowTestModeUntil }).where(eq(orgs.id, orgId));
    return c.json({ callingWindowTestModeUntil }, 200);
  })

  // Orders page (2026-07-16) — every Shopify-vertical trigger our own
  // webhooks already captured (cart recovery / COD confirmation /
  // feedback), tagged by workflow, with a manual "call now" action per
  // row. Deliberately not a live Shopify Orders API pull — see
  // listOrgOrderCalls's doc comment.
  .get("/orders", async (c) => {
    const rows = await listOrgOrderCalls(c.get("userOrgId")!);
    return c.json({ orders: rows }, 200);
  })

  .post("/orders/:id/call-now", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const result = await callScheduledRowNow(c.get("userOrgId")!, id);
    if (!result.ok) return c.json({ error: result.error }, result.statusCode);
    return c.json({ ok: true }, 200);
  })

  .get("/shopify/status", async (c) => {
    const status = await getShopifyStatus(c.get("userOrgId")!);
    return c.json(status, 200);
  })

  .post("/shopify/install-url", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { shop } = body as { shop?: string };
    if (!shop?.trim()) return c.json({ error: "`shop` is required" }, 400);
    const domain = shop.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const normalized = domain.endsWith(".myshopify.com") ? domain : `${domain}.myshopify.com`;
    const url = buildInstallUrl(c.get("userOrgId")!, normalized);
    if (!url) return c.json({ error: "Shopify install is not configured yet" }, 503);
    return c.json({ installUrl: url }, 200);
  })

  // On-demand .xlsx exports for the Integrations page's "Download as Excel"
  // cards. No scheduling, no email, no external spreadsheet OAuth — see
  // export.ts.
  .get("/export/orders.xlsx", async (c) => {
    const buffer = await buildOrdersWorkbook(c.get("userOrgId")!);
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    c.header("Content-Disposition", `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return c.body(new Uint8Array(buffer));
  })

  .get("/export/analytics.xlsx", async (c) => {
    const buffer = await buildAnalyticsWorkbook(c.get("userOrgId")!);
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    c.header("Content-Disposition", `attachment; filename="call-analytics-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return c.body(new Uint8Array(buffer));
  })

  .get("/export/transcripts.xlsx", async (c) => {
    const buffer = await buildTranscriptsWorkbook(c.get("userOrgId")!);
    c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    c.header("Content-Disposition", `attachment; filename="transcripts-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return c.body(new Uint8Array(buffer));
  })

  // User-facing telephony/number self-serve (ADR-042's per-org Twilio
  // isolation, previously admin-only — see voice/twilio-provisioning.ts for
  // the actual logic, unchanged here, just newly reachable by the org that
  // owns it instead of only an operator). Deliberately no shared number
  // pool: every org either gets its own dedicated number, or brings its
  // own credentials — never a number shared across orgs. Twilio is the
  // only provider with a platform-owned (non-BYO) path — Plivo and Exotel
  // are BYO-only per docs/india-telephony.md: no platform Plivo/Exotel
  // sub-account provisioning exists yet, and Exotel's live-call path needs
  // a SIP bridge this codebase doesn't have — but a user who already
  // runs their own Plivo/Exotel account can connect it here today.
  .get("/telephony/status", async (c) => {
    const orgId = c.get("userOrgId")!;
    const [twilio, plivo, exotel] = await Promise.all([
      getTwilioStatus(orgId),
      getPlivoStatus(orgId),
      getExotelStatus(orgId),
    ]);
    if (!twilio || !plivo || !exotel) return c.json({ error: "org not found" }, 404);
    const [org] = await db.select({ provider: orgs.telephonyProvider }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    return c.json(
      {
        telephony: {
          provider: org?.provider ?? "twilio",
          outboundNumber: twilio.outboundNumber,
          twilio,
          plivo,
          exotel,
        },
      },
      200,
    );
  })

  .post("/telephony/subaccount", async (c) => {
    const orgId = c.get("userOrgId")!;
    const existing = await getTwilioStatus(orgId);
    if (existing?.accountSid) {
      return c.json({ error: "This org already has a Twilio sub-account provisioned — reset first to start over." }, 409);
    }
    const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (!org) return c.json({ error: "org not found" }, 404);

    const result = await createSubaccountForOrg(orgId, org.name ?? orgId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ accountSid: result.accountSid }, 201);
  })

  .post("/telephony/number", async (c) => {
    const orgId = c.get("userOrgId")!;
    const existing = await getTwilioStatus(orgId);
    // A dedicated number is a real recurring Twilio charge — guard against
    // a user accidentally buying a second one via a repeated click/call
    // before billing exists to catch it. Reset first to replace one.
    if (existing?.outboundNumber) {
      return c.json({ error: `This org already has a dedicated number (${existing.outboundNumber}) — reset first to buy a different one.` }, 409);
    }
    const body = await c.req.json().catch(() => null);
    const { countryCode, areaCode } = (body ?? {}) as { countryCode?: string; areaCode?: string };
    if (!countryCode?.trim()) return c.json({ error: "`countryCode` is required, e.g. \"US\" or \"IN\"" }, 400);

    // Legacy single-number flow: search then buy the first candidate. The
    // full picker UX (list candidates, let the user choose, buy/release
    // per-agent numbers) lives at /api/app/numbers below.
    const available = await listAvailableNumbers(orgId, countryCode.trim(), areaCode?.trim());
    if (!available.ok) return c.json({ error: available.error }, 400);
    const result = await buyNumberForOrg(orgId, available.numbers[0]!.phoneNumber);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ phoneNumber: result.phoneNumber }, 201);
  })

  .post("/telephony/byo", async (c) => {
    const orgId = c.get("userOrgId")!;
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
    return c.json({ ok: true }, 200);
  })

  .post("/telephony/plivo/byo", async (c) => {
    const orgId = c.get("userOrgId")!;
    const body = await c.req.json().catch(() => null);
    const { authId, authToken, phoneNumber } = (body ?? {}) as {
      authId?: string;
      authToken?: string;
      phoneNumber?: string;
    };
    if (!authId?.trim() || !authToken?.trim() || !phoneNumber?.trim()) {
      return c.json({ error: "`authId`, `authToken`, and `phoneNumber` are all required" }, 400);
    }
    const result = await setPlivoByoCredentials(orgId, {
      authId: authId.trim(),
      authToken: authToken.trim(),
      phoneNumber: phoneNumber.trim(),
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true }, 200);
  })

  .post("/telephony/exotel/byo", async (c) => {
    const orgId = c.get("userOrgId")!;
    const body = await c.req.json().catch(() => null);
    const { sid, apiKey, apiToken, subdomain, phoneNumber } = (body ?? {}) as {
      sid?: string;
      apiKey?: string;
      apiToken?: string;
      subdomain?: string;
      phoneNumber?: string;
    };
    if (!sid?.trim() || !apiKey?.trim() || !apiToken?.trim() || !phoneNumber?.trim()) {
      return c.json({ error: "`sid`, `apiKey`, `apiToken`, and `phoneNumber` are all required" }, 400);
    }
    const result = await setExotelByoCredentials(orgId, {
      sid: sid.trim(),
      apiKey: apiKey.trim(),
      apiToken: apiToken.trim(),
      subdomain: subdomain?.trim(),
      phoneNumber: phoneNumber.trim(),
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true }, 200);
  })

  // Shared by all three telephony cards — clears every provider's stored
  // credentials and reverts to the platform Twilio default, see
  // resetToPlatformDefault's docstring for why it's not Twilio-only.
  .post("/telephony/reset", async (c) => {
    await resetToPlatformDefault(c.get("userOrgId")!);
    return c.json({ ok: true }, 200);
  })

  // C2b — Number provisioning UX. An org can now hold several Twilio
  // numbers (one per agent) instead of a single shared outboundNumber.
  // Every route below is org-scoped via userOrgId from the session, never
  // a path param, so one org can never list/buy/release another org's
  // numbers.
  .get("/numbers", async (c) => {
    const orgId = c.get("userOrgId")!;
    const rows = await db.select().from(orgPhoneNumbers).where(eq(orgPhoneNumbers.orgId, orgId));
    return c.json({ numbers: rows }, 200);
  })

  .get("/numbers/available", async (c) => {
    const orgId = c.get("userOrgId")!;
    const countryCode = c.req.query("countryCode");
    const areaCode = c.req.query("areaCode");
    if (!countryCode?.trim()) return c.json({ error: "`countryCode` query param is required, e.g. \"US\" or \"IN\"" }, 400);

    const result = await listAvailableNumbers(orgId, countryCode.trim(), areaCode?.trim());
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ numbers: result.numbers }, 200);
  })

  .post("/numbers", async (c) => {
    const orgId = c.get("userOrgId")!;
    const body = await c.req.json().catch(() => null);
    const { phoneNumber } = (body ?? {}) as { phoneNumber?: string };
    if (!phoneNumber?.trim()) return c.json({ error: "`phoneNumber` is required — pick one from GET /numbers/available" }, 400);

    const result = await buyNumberForOrg(orgId, phoneNumber.trim());
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ phoneNumber: result.phoneNumber }, 201);
  })

  .post("/numbers/:id/release", async (c) => {
    const orgId = c.get("userOrgId")!;
    const phoneNumberId = Number(c.req.param("id"));
    if (!Number.isInteger(phoneNumberId)) return c.json({ error: "`id` must be an integer" }, 400);

    const result = await releaseNumberForOrg(orgId, phoneNumberId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true }, 200);
  })

  .get("/flags", async (c) => {
    const flags = await getEffectiveFlags(c.get("userOrgId")!);
    return c.json({ flags }, 200);
  })

  // A3b — Knowledge Base. Scope: pasted text/FAQ, a single URL fetch, or a
  // PDF (base64 in the JSON body — no multipart handling elsewhere in this
  // codebase, and this keeps the upload path simple). Not "upload anything":
  // no crawling, no scheduled re-sync, no OCR — see knowledge-base.ts's doc
  // comment for the full scope note.
  .get("/knowledge-base", async (c) => {
    const documents = await listKnowledgeDocuments(c.get("userOrgId")!);
    return c.json({ documents }, 200);
  })

  .post("/knowledge-base", async (c) => {
    const orgId = c.get("userOrgId")!;
    if (knowledgeBaseIngestRateLimited(orgId)) {
      return c.json(
        { error: `Rate limit exceeded — max ${KB_INGEST_MAX_PER_WINDOW} uploads per minute. Try again shortly.` },
        429,
      );
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Expected a JSON object" }, 400);
    }
    const { title, sourceType, rawText, sourceUrl, pdfBase64 } = body as {
      title?: string;
      sourceType?: string;
      rawText?: string;
      sourceUrl?: string;
      pdfBase64?: string;
    };
    if (!title?.trim()) return c.json({ error: "`title` is required" }, 400);
    if (sourceType !== "text" && sourceType !== "url" && sourceType !== "pdf") {
      return c.json({ error: '`sourceType` must be "text", "url", or "pdf"' }, 400);
    }
    if (sourceType === "text" && !rawText?.trim()) {
      return c.json({ error: "`rawText` is required for a text document" }, 400);
    }
    if (sourceType === "url" && !sourceUrl?.trim()) {
      return c.json({ error: "`sourceUrl` is required for a URL document" }, 400);
    }
    if (sourceType === "pdf" && !pdfBase64) {
      return c.json({ error: "`pdfBase64` is required for a PDF document" }, 400);
    }

    let pdfBuffer: Uint8Array | undefined;
    if (sourceType === "pdf" && pdfBase64) {
      const decoded = Buffer.from(pdfBase64, "base64");
      if (decoded.byteLength > KB_MAX_PDF_BYTES) {
        return c.json({ error: `PDF exceeds the ${KB_MAX_PDF_BYTES / (1024 * 1024)}MB limit` }, 400);
      }
      pdfBuffer = decoded;
    }

    const { ingestKnowledgeDocument } = await import("../voice/knowledge-base");
    const result = await ingestKnowledgeDocument({
      orgId,
      title: title.trim(),
      sourceType,
      sourceUrl: sourceUrl?.trim(),
      rawText,
      pdfBuffer,
    });
    if (!result.ok) return c.json({ error: result.error }, 422);
    return c.json(result, 201);
  })

  .delete("/knowledge-base/:id", async (c) => {
    const orgId = c.get("userOrgId")!;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const { deleteKnowledgeDocument } = await import("../voice/knowledge-base");
    const deleted = await deleteKnowledgeDocument(orgId, id);
    if (!deleted) return c.json({ error: "document not found" }, 404);
    return c.json({ ok: true }, 200);
  })

  .get("/workflow-configs", async (c) => {
    const orgId = c.get("userOrgId")!;
    const templates = await db
      .select()
      .from(workflowTemplates)
      .where(and(eq(workflowTemplates.active, true)));
    const configs = await db
      .select()
      .from(orgWorkflowConfigs)
      .where(eq(orgWorkflowConfigs.orgId, orgId));
    const configMap = new Map(configs.map((cfg) => [cfg.templateKey, cfg]));
    const merged = templates.map((t) => ({
      ...t,
      orgConfig: configMap.get(t.id) ?? { enabled: true, overrides: null },
    }));
    return c.json({ workflows: merged }, 200);
  })

  .put("/workflow-configs/:templateKey", async (c) => {
    const orgId = c.get("userOrgId")!;
    const templateKey = c.req.param("templateKey");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);
    const { enabled, overrides } = body as { enabled?: boolean; overrides?: Record<string, Record<string, unknown>> };
    const values = {
      orgId,
      templateKey,
      enabled: enabled ?? true,
      overrides: overrides ?? null,
    };
    const [config] = await db
      .insert(orgWorkflowConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [orgWorkflowConfigs.orgId, orgWorkflowConfigs.templateKey],
        set: { enabled: values.enabled, overrides: values.overrides },
      })
      .returning();
    return c.json({ config }, 200);
  })

  // User support submission — same underlying table as the public
  // landing-page form (public-routes.ts), just with orgId known.
  .post("/support", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { subject, message } = body as { subject?: string; message?: string };
    if (!subject?.trim() || !message?.trim()) return c.json({ error: "`subject` and `message` are required" }, 400);
    const ticket = await submitSupportTicket({
      orgId: c.get("userOrgId"),
      email: c.get("userEmail") ?? "unknown",
      subject,
      message,
    });
    if (!ticket) return c.json({ error: "Failed to submit ticket" }, 500);
    return c.json({ submitted: true }, 201);
  });
