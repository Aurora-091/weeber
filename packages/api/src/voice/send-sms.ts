/**
 * Provider-agnostic SMS dispatch — the SMS analog of place-outbound-call.ts.
 * Routes through the org's real telephony provider (Twilio/Plivo/Exotel)
 * instead of assuming Twilio.
 *
 * Fixes Misc-4's bonus finding: workflows/engine.ts's post-call sendSms
 * action was hardcoded to getTwilioClientForOrg, so a BYO-Plivo/Exotel org's
 * post-call SMS silently failed (no error surfaced — it just called the
 * platform's Twilio account with the wrong `from`, or threw and got
 * swallowed by the try/catch there). Also the backing function for the new
 * mid-call `sendSms` tool (see tools/sendSms.ts) — same dispatcher, two
 * call sites (async workflow action, live LLM tool call).
 */
import { isValidE164 } from "./validation";
import { resolveOutboundRouting } from "./place-outbound-call";
import { getTwilioClientForOrg } from "./twilio-client";
import { sendPlivoSms } from "./plivo-client";
import { sendExotelSms } from "./exotel-client";

export type SendSmsResult = { ok: true } | { ok: false; error: string };

export async function sendSmsForOrg(input: {
  orgId?: string | null;
  to: string;
  body: string;
}): Promise<SendSmsResult> {
  const { orgId, to, body } = input;

  if (!isValidE164(to)) {
    return { ok: false, error: `Invalid destination number ${to}` };
  }

  const { provider, from } = await resolveOutboundRouting(orgId);
  if (!from) {
    return { ok: false, error: "No outbound number configured (platform or org)" };
  }

  try {
    if (provider === "plivo") {
      if (!orgId) return { ok: false, error: "Plivo SMS requires an org" };
      const result = await sendPlivoSms({ orgId, to, from, body });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
    if (provider === "exotel") {
      if (!orgId) return { ok: false, error: "Exotel SMS requires an org" };
      const result = await sendExotelSms({ orgId, to, from, body });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
    await (await getTwilioClientForOrg(orgId)).messages.create({ to, from, body });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
