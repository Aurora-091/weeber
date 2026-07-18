import { eq, and } from "drizzle-orm";
import { db } from "../database";
import { orgs, orgAgentConfigs, orgPhoneNumbers } from "../database/schema";
import { getTwilioClientForOrg, getPublicUrl, getWsUrl } from "./twilio-client";
import { createPlivoOutboundCall } from "./plivo-client";
import { createExotelOutboundCall } from "./exotel-client";

export type TelephonyProvider = "twilio" | "plivo" | "exotel";

/** Everything a caller needs to key a session and report status after a call
 * has been placed, provider-agnostic. `sessionKey` is the id the caller must
 * store the session under: Twilio's CallSid, Exotel's call sid, or — for
 * Plivo — the provisional request_uuid that /incoming/plivo later rebinds to
 * the real CallUUID (see plivo-client.ts on why request_uuid isn't trusted as
 * the final key on its own). */
export type PlaceOutboundResult =
  | { ok: true; provider: TelephonyProvider; sessionKey: string; status: string }
  | { ok: false; error: string; statusCode: 400 | 500 | 502 };

/**
 * Resolves which telephony provider an org dials through and the number it
 * dials from. Fallback chain, most to least specific:
 *   1. the calling agent's own assigned number (org_agent_configs.phone_number_id),
 *      if `agentKey` is passed and that agent has one — lets different agents
 *      in the same org caller-ID as different numbers.
 *   2. the org's own first still-active org_phone_numbers row (C2b) — covers
 *      orgs that bought numbers through the new picker but haven't assigned
 *      one to this particular agent yet.
 *   3. legacy orgs.outboundNumber — untouched, still written by
 *      buyNumberForOrg/setByoCredentials for orgs that never touch the new
 *      per-number picker.
 *   4. the platform default env var, so a totally unconfigured org (or a
 *      call site that doesn't have an orgId at all) still dials through
 *      something.
 */
export async function resolveOutboundRouting(
  orgId?: string | null,
  agentKey?: string | null,
): Promise<{ provider: TelephonyProvider; from: string | undefined }> {
  let from = process.env.TWILIO_PHONE_NUMBER;
  let provider: TelephonyProvider = "twilio";
  if (orgId) {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (org?.outboundNumber) from = org.outboundNumber;
    if (org?.telephonyProvider === "plivo" || org?.telephonyProvider === "exotel") {
      provider = org.telephonyProvider;
    }

    let assignedNumber: string | undefined;
    if (agentKey) {
      const [agentConfig] = await db
        .select({ phoneNumberId: orgAgentConfigs.phoneNumberId })
        .from(orgAgentConfigs)
        .where(and(eq(orgAgentConfigs.orgId, orgId), eq(orgAgentConfigs.templateKey, agentKey)))
        .limit(1);
      if (agentConfig?.phoneNumberId != null) {
        const [numberRow] = await db
          .select({ phoneNumber: orgPhoneNumbers.phoneNumber })
          .from(orgPhoneNumbers)
          .where(and(eq(orgPhoneNumbers.id, agentConfig.phoneNumberId), eq(orgPhoneNumbers.status, "active")))
          .limit(1);
        assignedNumber = numberRow?.phoneNumber;
      }
    }
    if (!assignedNumber) {
      const [orgNumberRow] = await db
        .select({ phoneNumber: orgPhoneNumbers.phoneNumber })
        .from(orgPhoneNumbers)
        .where(and(eq(orgPhoneNumbers.orgId, orgId), eq(orgPhoneNumbers.status, "active")))
        .limit(1);
      assignedNumber = orgNumberRow?.phoneNumber;
    }
    if (assignedNumber) from = assignedNumber;
  }
  return { provider, from };
}

/**
 * Single call-placement entry point shared by the outbound API route and the
 * scheduled-call sweep. Dispatches to the org's real telephony provider
 * (Twilio / Plivo / Exotel) instead of assuming Twilio — the bug this
 * replaces was the scheduler dialing every retry through Twilio, so a
 * Plivo/Exotel (India BYO) org's automated retries silently went out on the
 * wrong account or failed. Compliance gates are the caller's responsibility
 * (both call sites already run them before reaching here); this only places
 * the call and returns the session key to store state under.
 */
export async function placeOutboundCall(input: {
  orgId?: string | null;
  to: string;
  /** Which agent template is placing this call — used to prefer that
   * agent's own assigned number (C2b) over the org's shared default, if
   * one is set. Optional: callers that don't know/have an agent (e.g. the
   * scheduler sweep) just fall back to the org-level number. */
  agentKey?: string | null;
  /** Enable Twilio async answering-machine detection. No-op for Plivo/Exotel,
   * which don't expose AMD on our current integration. */
  amd?: boolean;
}): Promise<PlaceOutboundResult> {
  const { orgId, to, agentKey, amd = true } = input;
  const { provider, from } = await resolveOutboundRouting(orgId, agentKey);

  if (!from) {
    return { ok: false, error: "No outbound phone number configured", statusCode: 500 };
  }

  if (provider === "plivo") {
    if (!orgId) {
      return { ok: false, error: "`orgId` is required for Plivo calls (credentials are per-org)", statusCode: 400 };
    }
    const result = await createPlivoOutboundCall({
      orgId,
      to,
      from,
      answerUrl: `${getPublicUrl()}/api/voice/incoming/plivo?orgId=${encodeURIComponent(orgId)}`,
    });
    if (!result.ok) return { ok: false, error: result.error, statusCode: 502 };
    return { ok: true, provider, sessionKey: result.requestUuid, status: "queued" };
  }

  if (provider === "exotel") {
    if (!orgId) {
      return { ok: false, error: "`orgId` is required for Exotel calls (credentials are per-org)", statusCode: 400 };
    }
    // Exotel stream auth (2026-07-17, middleware/exotel-auth.ts): the WSS
    // URL itself carries this org's credentials (Basic Auth, per Exotel's
    // own documented model for this integration) — createExotelOutboundCall
    // embeds them since it's the one that already fetches this org's real
    // Exotel creds; a bare, unauthenticated URL would be rejected by
    // ws-route.ts's verifyExotelStreamAuth on connect.
    const result = await createExotelOutboundCall({
      orgId,
      to,
      from,
      streamUrl: `${getWsUrl()}/api/voice/stream/exotel`,
    });
    if (!result.ok) return { ok: false, error: result.error, statusCode: 502 };
    return { ok: true, provider, sessionKey: result.callSid, status: "in-progress" };
  }

  const call = await (await getTwilioClientForOrg(orgId)).calls.create({
    to,
    from,
    url: `${getPublicUrl()}/api/voice/incoming`,
    statusCallback: `${getPublicUrl()}/api/voice/status-callback`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    record: true,
    recordingStatusCallback: `${getPublicUrl()}/api/voice/recording-status`,
    ...(amd
      ? {
          // Async AMD — doesn't delay call connection (matters since we go
          // straight into a live Media Stream). Twilio posts AnsweredBy to
          // /amd-status-callback once determined; see that route for how a
          // machine-answered call is redirected out of the live stream.
          machineDetection: "DetectMessageEnd" as const,
          asyncAmd: "true" as const,
          asyncAmdStatusCallback: `${getPublicUrl()}/api/voice/amd-status-callback`,
        }
      : {}),
  });

  return { ok: true, provider, sessionKey: call.sid, status: call.status };
}
