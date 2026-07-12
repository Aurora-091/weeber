/**
 * Main voice API surface — everything under /api/voice/*. Mounted once in
 * ../index.ts via `.route('/voice', voice)`.
 *
 * Grouped by purpose (in file order):
 *   1. Twilio webhooks (/incoming, /status-callback, /recording-status) —
 *      signature-validated, called by Twilio itself, not by your app code.
 *   2. Outbound call trigger (/calls/outbound) — compliance-gated, rate-limited.
 *   3. Ops endpoints (/calls, /calls/:id/*, /dnc, /callers) — admin-key gated,
 *      used by the dashboard (packages/web/src/web/pages/dashboard/) and
 *      anything you build on top (curl, your own internal tools, etc).
 *
 * New to this file? Start with docs/architecture.md for how a call flows
 * through these routes end to end, then docs/api-reference.md for the full
 * endpoint list with request/response shapes.
 */
import { Hono } from "hono";
import twilioPkg from "twilio";
const { VoiceResponse } = twilioPkg.twiml;
import { getTwilioClientForOrg, getPublicUrl, getWsUrl } from "./twilio-client";
import { sessionStore } from "./session-store";
import { dispatchWebhook, resolveWebhookUrl } from "./webhooks";
import { db } from "../database";
import { calls, callLatency, orgs } from "../database/schema";
import { eq } from "drizzle-orm";
import { AgentFrameSchema } from "./agent-frame";
import { getOrg, getAgentConfigsForOrg, upsertAgentConfig, computeOrgAnalytics } from "./org-queries";
import { generatePreviewAudio } from "./tts-preview";
import { listVoicesForProvider, fetchCartesiaPreviewAudio } from "./voices-catalog";
import {
  checkOutboundCallCompliance,
  addToDoNotCallList,
  removeFromDoNotCallList,
  listDoNotCall,
  eraseCallerData,
  getDisclosureLine,
  buildCallAuditRecord,
  buildPhoneNumberAuditTrail,
  renderAuditTrailText,
} from "@openvent/compliance";
import { dncAdapter, callLogAdapter, callAuditAdapter } from "./compliance/adapters";
import { runWorkflowForOutcome } from "./workflows/engine";
import type { WorkflowOutcome } from "./workflows/types";
import { requireAdminKey } from "./middleware/admin-auth";
import { requireTwilioSignature } from "./middleware/twilio-signature";
import { rateLimitOutboundCalls } from "./middleware/rate-limit";
import { isValidE164 } from "./validation";
import { createAdminKey, listAdminKeys, revokeAdminKey } from "./admin-keys";

export const voice = new Hono()
  // Twilio webhook — set this as the phone number's "A call comes in" Voice URL.
  // Also reused as the TwiML endpoint for outbound calls we place ourselves.
  // Signature-validated: only genuine Twilio requests are accepted.
  .post("/incoming", requireTwilioSignature, async (c) => {
    const body = c.get("twilioBody");
    const callSid = String(body.CallSid ?? "");
    const from = String(body.From ?? "");
    const to = String(body.To ?? "");

    if (callSid && !(await sessionStore.get(callSid))) {
      await sessionStore.set(callSid, { callSid, direction: "inbound" });
    }
    const session = callSid ? await sessionStore.get(callSid) : undefined;
    const webhookUrl = resolveWebhookUrl(session?.webhookUrl);

    if (callSid) {
      await db
        .insert(calls)
        .values({
          twilioCallSid: callSid,
          direction: session?.direction ?? "inbound",
          fromNumber: from,
          toNumber: to,
          status: "in-progress",
          agentPersona: session?.persona ?? null,
          webhookUrl: session?.webhookUrl ?? null,
          // Weeber org-lite scoping (additive, ADR-030) — populated when
          // this call originated from a scheduled call the scheduler
          // stamped with orgId (e.g. a Shopify vertical workflow); null
          // for plain inbound calls or self-hosted OpenVent usage.
          orgId: session?.orgId ?? null,
        })
        .onConflictDoNothing()
        .catch(() => undefined as unknown);

      void dispatchWebhook(webhookUrl, "call.started", {
        callSid,
        direction: session?.direction ?? "inbound",
        from,
        to,
      });
    }

    const twiml = new VoiceResponse();
    const connect = twiml.connect();
    connect.stream({ url: `${getWsUrl()}/api/voice/stream` });

    return c.text(twiml.toString(), 200, { "Content-Type": "text/xml" });
  })

  // Trigger an outbound call. Body: { to, persona?, webhookUrl? }
  // `webhookUrl` overrides the WEBHOOK_URL env default for this call only —
  // handy for routing different call flows to different n8n/Zapier hooks.
  .post("/calls/outbound", requireAdminKey, rateLimitOutboundCalls, async (c) => {
    const parsed = await c.req.json().catch(() => null);
    if (!parsed || typeof parsed !== "object") {
      return c.json({ error: "Invalid or missing JSON request body" }, 400);
    }
    const { to, persona, webhookUrl, orgId, ttsProvider, sttProvider, language } = parsed as {
      to?: string;
      persona?: string;
      webhookUrl?: string;
      orgId?: string;
      /** Per-call overrides for this one test/outbound call — same fields as the
       * agent frame (agent-frame.ts), but scoped to just this call instead of
       * saved to an org's agent config. Handy for one-off language/provider tests. */
      ttsProvider?: "elevenlabs" | "cartesia" | "sarvam";
      sttProvider?: "deepgram" | "sarvam";
      language?: string;
    };
    if (!to) return c.json({ error: "`to` is required" }, 400);
    if (!isValidE164(to)) {
      return c.json({ error: "`to` must be a valid E.164 phone number, e.g. +15551234567" }, 400);
    }

    let from = process.env.TWILIO_PHONE_NUMBER;
    if (orgId) {
      const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
      if (org?.outboundNumber) {
        from = org.outboundNumber;
      }
    }

    if (!from) return c.json({ error: "No outbound phone number configured" }, 500);

    // Compliance gates — enforced automatically via @openvent/compliance, no
    // manual step required. A call that fails either check is rejected and
    // never dials.
    const bypassCompliance = process.env.BYPASS_COMPLIANCE === "true" || (parsed as { bypassCompliance?: boolean }).bypassCompliance;
    if (!bypassCompliance) {
      const compliance = await checkOutboundCallCompliance(to, dncAdapter);
      if (!compliance.allowed) {
        return c.json({ error: compliance.reason }, 403);
      }
    }

    const call = await (await getTwilioClientForOrg(orgId)).calls.create({
      to,
      from,
      url: `${getPublicUrl()}/api/voice/incoming`,
      statusCallback: `${getPublicUrl()}/api/voice/status-callback`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      record: true,
      recordingStatusCallback: `${getPublicUrl()}/api/voice/recording-status`,
      // Answering-machine detection (async — doesn't delay call connection,
      // unlike sync AMD, which matters since we go straight into a live
      // Media Stream). Twilio posts AnsweredBy to /amd-status-callback once
      // it's determined, whether or not the agent has already started
      // talking — see that route for how we redirect a machine-answered
      // call out of the live stream to leave a short voicemail instead.
      machineDetection: "DetectMessageEnd",
      asyncAmd: "true",
      asyncAmdStatusCallback: `${getPublicUrl()}/api/voice/amd-status-callback`,
    });

    await sessionStore.set(call.sid, {
      callSid: call.sid,
      direction: "outbound",
      persona,
      webhookUrl,
      orgId,
      ttsProvider,
      sttProvider,
      language,
    });

    return c.json({ callSid: call.sid, status: call.status }, 201);
  })

  // Twilio call status webhook — updates our call record's lifecycle status.
  // Handles every terminal Twilio status (not just "completed") so calls that
  // never connect — failed, busy, no-answer, canceled — don't stay stuck as
  // "in-progress" forever, and their session state gets cleaned up too.
  .post("/status-callback", requireTwilioSignature, async (c) => {
    const body = c.get("twilioBody");
    const callSid = String(body.CallSid ?? "");
    const status = String(body.CallStatus ?? "");
    const terminalStatuses = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);
    const isTerminal = terminalStatuses.has(status);

    if (callSid) {
      await db
        .update(calls)
        .set({
          status,
          endedAt: isTerminal ? new Date() : undefined,
        })
        .where(eq(calls.twilioCallSid, callSid))
        .catch(() => undefined as unknown);

      if (isTerminal) {
        const session = await sessionStore.get(callSid);
        void dispatchWebhook(resolveWebhookUrl(session?.webhookUrl), "call.completed", {
          callSid,
          status,
        });

        // Calls that never actually connected (no-answer/busy/failed) don't
        // go through stream.ts's disposition capture — run the workflow
        // directly off the Twilio status so a "no-answer -> retry" workflow
        // still fires automatically even when the media stream never opened.
        const workflowOutcome: Record<string, string> = {
          "no-answer": "no-answer",
          busy: "busy",
          failed: "failed",
        };
        const outcome = workflowOutcome[status];
        if (outcome) {
          const [row] = await db.select().from(calls).where(eq(calls.twilioCallSid, callSid)).limit(1);
          if (row) {
            void runWorkflowForOutcome({
              toNumber: row.toNumber,
              outcome: outcome as WorkflowOutcome,
              persona: session?.persona,
              webhookUrl: session?.webhookUrl,
              previousAttempt: session?.workflowAttempt,
              orgId: session?.orgId,
              checkoutToken: session?.checkoutToken,
              metadata: session?.workflowMetadata,
            }).catch((err) => console.error("[routes] workflow execution failed", err));
          }
        }

        await sessionStore.delete(callSid);
      }
    }
    return c.text("", 200);
  })

  // Twilio async answering-machine-detection webhook — fires once Twilio has
  // determined AnsweredBy, independently of (and not blocking) the live
  // Media Stream the agent is already talking over. If a machine answered,
  // we redirect the live call out of the stream to leave a short, honest
  // voicemail and hang up, rather than letting the agent run a live
  // conversation into an answering machine's beep and silence.
  .post("/amd-status-callback", requireTwilioSignature, async (c) => {
    const body = c.get("twilioBody");
    const callSid = String(body.CallSid ?? "");
    const answeredBy = String(body.AnsweredBy ?? "");

    const machineAnswers = new Set(["machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other"]);
    if (callSid && machineAnswers.has(answeredBy)) {
      const twiml = new VoiceResponse();
      twiml.say(
        "Hi, this is an automated call — sorry to have missed you. We'll try again, or feel free to call us back. Have a good day.",
      );
      twiml.hangup();
      const [callRow] = await db.select({ orgId: calls.orgId }).from(calls).where(eq(calls.twilioCallSid, callSid)).limit(1);
      await (await getTwilioClientForOrg(callRow?.orgId))
        .calls(callSid)
        .update({ twiml: twiml.toString() })
        .catch((err) => console.error("[routes] failed to redirect machine-answered call", err));

      const session = await sessionStore.get(callSid);
      void dispatchWebhook(resolveWebhookUrl(session?.webhookUrl), "call.voicemail_detected", { callSid, answeredBy });
    }

    return c.text("", 200);
  })

  // Twilio recording webhook — stores the recording URL once available.
  .post("/recording-status", requireTwilioSignature, async (c) => {
    const body = c.get("twilioBody");
    const callSid = String(body.CallSid ?? "");
    const recordingUrl = String(body.RecordingUrl ?? "");
    if (callSid && recordingUrl) {
      const fullUrl = `${recordingUrl}.mp3`;
      await db
        .update(calls)
        .set({ recordingUrl: fullUrl })
        .where(eq(calls.twilioCallSid, callSid))
        .catch(() => undefined as unknown);

      const session = await sessionStore.get(callSid);
      void dispatchWebhook(resolveWebhookUrl(session?.webhookUrl), "call.recording_ready", {
        callSid,
        recordingUrl: fullUrl,
      });
    }
    return c.text("", 200);
  })

  // Ops endpoints — no dashboard, just JSON for curl/Postman.
  .get("/calls", requireAdminKey, async (c) => {
    const rows = await db.select().from(calls).orderBy(calls.startedAt);
    return c.json({ calls: rows }, 200);
  })

  .get("/calls/:id/transcript", requireAdminKey, async (c) => {
    const id = Number(c.req.param("id"));
    const { transcripts } = await import("../database/schema");
    const rows = await db.select().from(transcripts).where(eq(transcripts.callId, id));
    return c.json({ transcript: rows }, 200);
  })

  // Tool-call log for one call — includes captureField calls, so the
  // dashboard can show exactly when/how each piece of structured state was
  // learned, not just the final captured-state snapshot on the call row.
  .get("/calls/:id/tool-calls", requireAdminKey, async (c) => {
    const id = Number(c.req.param("id"));
    const { toolCalls } = await import("../database/schema");
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.callId, id));
    return c.json({ toolCalls: rows }, 200);
  })

  // Per-call latency breakdown (ADR-022) — STT connect time, LLM
  // time-to-first-token, TTS first-audio-byte time. Null fields mean that
  // stage's timing wasn't captured for this call (e.g. it ended before
  // reaching that stage, or the call predates this feature) — not an error.
  .get("/calls/:id/latency", requireAdminKey, async (c) => {
    const id = Number(c.req.param("id"));
    const [row] = await db.select().from(callLatency).where(eq(callLatency.callId, id)).limit(1);
    return c.json({ latency: row ?? null }, 200);
  })

  // Compliance audit trail for one call — who was called, when, under what
  // consent (was the recording/AI disclosure actually spoken, not just
  // configured), what disposition, current DNC status, and the full
  // transcript, assembled into a single record. Direct answer to real user
  // feedback: "the thing that kills the compliance fear is being able to
  // produce this on demand" (see DECISIONS.md / ROADMAP.md). ?format=text
  // returns a plain-text version suitable for handing to a lawyer/compliance
  // officer as-is; default is JSON for programmatic use.
  .get("/calls/:id/audit", requireAdminKey, async (c) => {
    const id = c.req.param("id");
    const record = await buildCallAuditRecord(id, callAuditAdapter, dncAdapter, getDisclosureLine());
    if (!record) return c.json({ error: "call not found" }, 404);
    if (c.req.query("format") === "text") {
      return c.text(renderAuditTrailText([record]), 200);
    }
    return c.json({ audit: record }, 200);
  })

  // Same audit trail, but for every call involving a phone number — the more
  // common real request ("show me everything about how this number was
  // contacted"), not just one call id.
  .get("/callers/:phoneNumber/audit", requireAdminKey, async (c) => {
    const phoneNumber = decodeURIComponent(c.req.param("phoneNumber"));
    const trail = await buildPhoneNumberAuditTrail(phoneNumber, callAuditAdapter, dncAdapter, getDisclosureLine());
    if (c.req.query("format") === "text") {
      return c.text(renderAuditTrailText(trail), 200);
    }
    return c.json({ audit: trail }, 200);
  })

  // Live call-control: current status/metadata for one call, and a force-end
  // action for operational control mid-call.
  .get("/calls/:id/status", requireAdminKey, async (c) => {
    const id = Number(c.req.param("id"));
    const [row] = await db.select().from(calls).where(eq(calls.id, id)).limit(1);
    if (!row) return c.json({ error: "call not found" }, 404);
    return c.json({ call: row }, 200);
  })
  .post("/calls/:id/end", requireAdminKey, async (c) => {
    const id = Number(c.req.param("id"));
    const [row] = await db.select().from(calls).where(eq(calls.id, id)).limit(1);
    if (!row) return c.json({ error: "call not found" }, 404);
    try {
      await (await getTwilioClientForOrg(row.orgId)).calls(row.twilioCallSid).update({ status: "completed" });
    } catch (err) {
      return c.json({ error: `Failed to end call: ${(err as Error).message}` }, 500);
    }
    return c.json({ ended: true, callSid: row.twilioCallSid }, 200);
  })

  // Fire a sample event at a webhook URL — use this to test your n8n/Zapier
  // trigger before making a real call. Body: { url?: string } — falls back
  // to WEBHOOK_URL env var if omitted.
  .post("/webhooks/test", requireAdminKey, async (c) => {
    const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
    const target = resolveWebhookUrl(body.url);
    if (!target) return c.json({ error: "No webhook URL provided and WEBHOOK_URL is not set" }, 400);

    await dispatchWebhook(target, "call.started", {
      callSid: "TEST_CALL_SID",
      direction: "outbound",
      from: "+15550000000",
      to: "+15550000001",
      note: "This is a test event from /api/voice/webhooks/test",
    });

    return c.json({ sent: true, target }, 200);
  })

  // Compliance: Do-Not-Call list management — enforced automatically on
  // every outbound call (POST /calls/outbound) via @openvent/compliance.
  .get("/dnc", requireAdminKey, async (c) => {
    const rows = await listDoNotCall(dncAdapter);
    return c.json({ doNotCall: rows }, 200);
  })
  .post("/dnc", requireAdminKey, async (c) => {
    const parsed = await c.req.json().catch(() => null);
    if (!parsed || typeof parsed !== "object") {
      return c.json({ error: "Invalid or missing JSON request body" }, 400);
    }
    const { phoneNumber, reason } = parsed as { phoneNumber?: string; reason?: string };
    if (!phoneNumber) return c.json({ error: "`phoneNumber` is required" }, 400);
    if (!isValidE164(phoneNumber)) {
      return c.json({ error: "`phoneNumber` must be a valid E.164 phone number, e.g. +15551234567" }, 400);
    }
    await addToDoNotCallList(dncAdapter, phoneNumber, reason, "manual");
    return c.json({ added: true, phoneNumber }, 201);
  })
  .delete("/dnc/:phoneNumber", requireAdminKey, async (c) => {
    const phoneNumber = decodeURIComponent(c.req.param("phoneNumber"));
    await removeFromDoNotCallList(dncAdapter, phoneNumber);
    return c.json({ removed: true, phoneNumber }, 200);
  })

  // Compliance: GDPR right-to-erasure — deletes all call data tied to a
  // phone number on request, via @openvent/compliance.
  .delete("/callers/:phoneNumber", requireAdminKey, async (c) => {
    const phoneNumber = decodeURIComponent(c.req.param("phoneNumber"));
    const result = await eraseCallerData(callLogAdapter, phoneNumber);
    return c.json({ erased: true, ...result }, 200);
  })

  // Multi-user dashboard auth (ADR-025) — labeled API keys. Gated by
  // requireAdminKey itself: you need an existing valid key (the bootstrap
  // ADMIN_API_KEY, or another labeled key) to create more. The plaintext key
  // is returned exactly once, on creation — never again after this response.
  .post("/admin-keys", requireAdminKey, async (c) => {
    const parsed = await c.req.json().catch(() => null);
    const label = parsed && typeof parsed === "object" ? (parsed as { label?: string }).label : undefined;
    if (!label || !label.trim()) return c.json({ error: "`label` is required" }, 400);
    const created = await createAdminKey(label.trim());
    return c.json({ adminKey: created }, 201);
  })

  .get("/admin-keys", requireAdminKey, async (c) => {
    const keys = await listAdminKeys();
    return c.json({ adminKeys: keys }, 200);
  })

  .delete("/admin-keys/:id", requireAdminKey, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    await revokeAdminKey(id);
    return c.json({ revoked: true }, 200);
  })

  // Minimal org list for the dashboard's org picker — no org-switcher/auth
  // infrastructure exists yet (single shared admin key sees every org), so
  // this is just enough for a dropdown, not a scoped-access endpoint.
  .get("/orgs", requireAdminKey, async (c) => {
    const rows = await db
      .select({ id: orgs.id, name: orgs.name, vertical: orgs.vertical })
      .from(orgs)
      .orderBy(orgs.createdAt);
    return c.json({ orgs: rows }, 200);
  })

  // Agent "frame" config (see agent-frame.ts) — every agent template
  // available for this org's vertical, each merged with that org's saved
  // config row if one exists (so the dashboard can show "not yet
  // configured" templates alongside already-configured ones in one list).
  .get("/orgs/:orgId/agent-configs", requireAdminKey, async (c) => {
    const orgId = c.req.param("orgId");
    const merged = await getAgentConfigsForOrg(orgId);
    if (!merged) return c.json({ error: "org not found" }, 404);
    return c.json({ agentConfigs: merged }, 200);
  })

  // Upsert one agent's frame config — validated against AgentFrameSchema so
  // the dashboard form, this endpoint, and any future AI-builder flow all
  // agree on the exact same shape (see agent-frame.ts).
  .put("/orgs/:orgId/agent-configs/:templateKey", requireAdminKey, async (c) => {
    const orgId = c.req.param("orgId");
    const templateKey = c.req.param("templateKey");
    const org = await getOrg(orgId);
    if (!org) return c.json({ error: "org not found" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = AgentFrameSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid agent config", details: parsed.error.issues }, 400);
    }

    const row = await upsertAgentConfig(orgId, templateKey, parsed.data);
    return c.json({ agentConfig: row }, 200);
  })

  // Agent test chat — exercises the real agent config (persona, tools, guardrails,
  // LLM) as a text-only sandbox. Does NOT create a call row, does NOT touch
  // Twilio/STT/TTS, does NOT count against usage. Returns the assistant response
  // with latency + cost metadata so the operator can validate prompt behavior.
  .post("/orgs/:orgId/agent-configs/:templateKey/test-chat", requireAdminKey, async (c) => {
    const orgId = c.req.param("orgId");
    const templateKey = c.req.param("templateKey");
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages)) {
      return c.json({ error: "body must include `messages` (array)" }, 400);
    }

    const { resolveAgentConfig } = await import("./agent");
    const { resolveVoiceModel, getActiveModelLabel, estimateLlmCost, resolveLlmProvider } = await import("./llm");
    const { voiceTools, buildKnownFactsBlock } = await import("./agent");
    const { streamText, stepCountIs } = await import("ai");

    const agentConfig = await resolveAgentConfig({
      orgId,
      templateKey,
    });

    const model = resolveVoiceModel(
      agentConfig.llmProvider,
      agentConfig.llmModel,
    );
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

  // Dynamic per-provider voice list for the dashboard's voice picker — see
  // voices-catalog.ts for why each provider's preview capability differs.
  .get("/voices", requireAdminKey, async (c) => {
    const provider = c.req.query("provider") ?? "";
    if (!["elevenlabs", "cartesia", "sarvam"].includes(provider)) {
      return c.json({ error: "`provider` must be \"elevenlabs\", \"cartesia\", or \"sarvam\"" }, 400);
    }
    const voices = await listVoicesForProvider(provider);
    return c.json({ voices }, 200);
  })

  // Cartesia's preview_file_url requires the same Authorization our own
  // server has, so the browser can't play it directly — proxied here.
  .get("/voices/cartesia-preview/:id", requireAdminKey, async (c) => {
    const result = await fetchCartesiaPreviewAudio(c.req.param("id"));
    if (!result) return c.json({ error: "Preview not available for this voice" }, 502);
    return c.body(result.body, 200, { "Content-Type": result.contentType });
  })

  // One-shot TTS preview for the dashboard's voice picker — not part of a
  // live call, see tts-preview.ts. Returns a playable WAV directly (mu-law
  // wrapped in a WAV header), no separate storage/upload step.
  .post("/voice-preview", requireAdminKey, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "Invalid or missing JSON request body" }, 400);
    const { text, voiceProvider, voiceId, language } = body as {
      text?: string;
      voiceProvider?: string;
      voiceId?: string;
      language?: string;
    };
    if (!text || !text.trim()) return c.json({ error: "`text` is required" }, 400);
    if (voiceProvider !== "elevenlabs" && voiceProvider !== "cartesia" && voiceProvider !== "sarvam") {
      return c.json({ error: "`voiceProvider` must be \"elevenlabs\", \"cartesia\", or \"sarvam\"" }, 400);
    }

    try {
      const wav = await generatePreviewAudio(text.slice(0, 300), voiceProvider, voiceId, language);
      return c.body(new Uint8Array(wav), 200, { "Content-Type": "audio/wav" });
    } catch (err) {
      console.error("[routes] voice preview generation failed", err);
      return c.json({ error: "Failed to generate voice preview — check the voice ID and provider API key" }, 502);
    }
  })

  // Merchant-dashboard analytics — simple v1, aggregated directly off
  // existing tables (calls/callLatency/toolCalls), no separate rollup
  // tables yet. `days` bounds how far back to look (default 30).
  .get("/orgs/:orgId/analytics", requireAdminKey, async (c) => {
    const orgId = c.req.param("orgId");
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
    const analytics = await computeOrgAnalytics(orgId, days);
    return c.json(analytics, 200);
  });
