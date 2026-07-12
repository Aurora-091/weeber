import { eq } from "drizzle-orm";
import { db } from "../database";
import { orgs } from "../database/schema";
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
 * dials from. Falls back to the platform Twilio number for orgs with no
 * configured `outboundNumber`/provider — today's single-tenant default.
 */
export async function resolveOutboundRouting(
  orgId?: string | null,
): Promise<{ provider: TelephonyProvider; from: string | undefined }> {
  let from = process.env.TWILIO_PHONE_NUMBER;
  let provider: TelephonyProvider = "twilio";
  if (orgId) {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (org?.outboundNumber) from = org.outboundNumber;
    if (org?.telephonyProvider === "plivo" || org?.telephonyProvider === "exotel") {
      provider = org.telephonyProvider;
    }
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
  /** Enable Twilio async answering-machine detection. No-op for Plivo/Exotel,
   * which don't expose AMD on our current integration. */
  amd?: boolean;
}): Promise<PlaceOutboundResult> {
  const { orgId, to, amd = true } = input;
  const { provider, from } = await resolveOutboundRouting(orgId);

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
