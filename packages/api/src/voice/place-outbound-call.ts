import { eq, and, asc } from "drizzle-orm";
import { db } from "../database";
import { orgs, orgAgentConfigs, orgPhoneNumbers } from "../database/schema";
import { getTwilioClientForOrg, getPublicUrl, getWsUrl } from "./twilio-client";
import { createPlivoOutboundCall } from "./plivo-client";
import { createExotelOutboundCall } from "./exotel-client";
import { bumpOrgActivity } from "../app/org-activity";
import { assertOutboundCallAllowed } from "./compliance/outbound-gate";
import { shouldRequestTwilioAmd } from "./amd";

export type TelephonyProvider = "twilio" | "plivo" | "exotel";

/** Everything a caller needs to key a session and report status after a call
 * has been placed, provider-agnostic. `sessionKey` is the id the caller must
 * store the session under: Twilio's CallSid, Exotel's call sid, or — for
 * Plivo — the provisional request_uuid that /incoming/plivo later rebinds to
 * the real CallUUID (see plivo-client.ts on why request_uuid isn't trusted as
 * the final key on its own). */
export type PlaceOutboundResult =
  | { ok: true; provider: TelephonyProvider; sessionKey: string; status: string }
  | { ok: false; error: string; statusCode: 400 | 403 | 500 | 502 };

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
      // ADR-112: ordered, not arbitrary. This branch used a bare `.limit(1)`
      // with no `orderBy`, so an org holding more than one active number dialed
      // from whichever row Postgres happened to return — and that could differ
      // between two calls from the same agent, which makes caller ID
      // nondeterministic and any "why did it call from that number" question
      // unanswerable. Oldest-first (`id asc`) is the stable choice: an org's
      // first number is the one it has had longest and most likely published,
      // and unlike newest-first the answer does not change when a number is
      // added. Per-agent assignment above remains the way to say something
      // different on purpose.
      const [orgNumberRow] = await db
        .select({ phoneNumber: orgPhoneNumbers.phoneNumber })
        .from(orgPhoneNumbers)
        .where(and(eq(orgPhoneNumbers.orgId, orgId), eq(orgPhoneNumbers.status, "active")))
        .orderBy(asc(orgPhoneNumbers.id))
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
 * wrong account or failed.
 *
 * ADR-096 — INVARIANT: every outbound call this platform places goes through
 * `assertOutboundCallAllowed` below, and it fails closed. The previous version
 * of this comment asserted that compliance was the caller's responsibility because
 * "both call sites" already ran the gates before reaching here; that was wrong
 * on both counts. There were five callers, not two, and three of them ran no
 * gates at all — see compliance/outbound-gate.ts for the audit-16 evidence.
 * Callers may still pre-check (the scheduler needs per-gate reason codes to
 * decide defer-vs-cancel, and no caller should spend a provider leg to
 * discover a refusal it could have predicted), but a caller that pre-checks
 * nothing is now safe rather than silently unscreened.
 */
export async function placeOutboundCall(input: {
  orgId?: string | null;
  to: string;
  /** Which agent template is placing this call — used to prefer that
   * agent's own assigned number (C2b) over the org's shared default, if
   * one is set. Optional: callers that don't know/have an agent (e.g. the
   * scheduler sweep) just fall back to the org-level number. */
  agentKey?: string | null;
  /** Enable Twilio async answering-machine detection. Default: on for NANP
   * (`+1` + 10 digits) only — see `shouldRequestTwilioAmd`. Explicit `false`
   * is required for dashboard test calls (ADR-123). No-op for Plivo/Exotel. */
  amd?: boolean;
}): Promise<PlaceOutboundResult> {
  const { orgId, to, agentKey } = input;
  const amd = input.amd ?? shouldRequestTwilioAmd(to);

  // ADR-096: the chokepoint. Runs before routing resolution and before any
  // provider is touched, so a refused call costs nothing and cannot leak a
  // dial through a provider-specific branch below.
  const gate = await assertOutboundCallAllowed(orgId, to);
  if (!gate.allowed) {
    return { ok: false, error: gate.reason, statusCode: 403 };
  }

  const { provider, from } = await resolveOutboundRouting(orgId, agentKey);

  if (!from) {
    return { ok: false, error: "No outbound phone number configured", statusCode: 500 };
  }

  // Activity heartbeat for the inactivity lifecycle sweep — placing a call
  // counts as the org being alive, even with no dashboard logins.
  bumpOrgActivity(orgId);

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

  // The org rides along in the answer URL, exactly like the Plivo branch
  // above. Without it, /incoming can only learn the org from the session —
  // and the session is written by our *callers*, after this function returns
  // (voice/routes.ts, workflows/scheduler.ts). Ringing time normally means
  // that write wins the race, but an instantly-answered call or a slow
  // (Redis-backed) session store makes an outbound call arrive at /incoming
  // as a plain inbound one: no org, no persona, wrong direction. Twilio signs
  // the full URL it was given including this query string, so /incoming can
  // trust it (see middleware/twilio-signature.ts).
  const twilioIncomingUrl = orgId
    ? `${getPublicUrl()}/api/voice/incoming?orgId=${encodeURIComponent(orgId)}`
    : `${getPublicUrl()}/api/voice/incoming`;

  const call = await (await getTwilioClientForOrg(orgId)).calls.create({
    to,
    from,
    url: twilioIncomingUrl,
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
