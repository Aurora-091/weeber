/**
 * Exotel outbound call placement + credential resolution — the Exotel
 * analog of twilio-client.ts. BYO-only today (see
 * voice/exotel-provisioning.ts): no platform-owned Exotel account.
 */
import { db } from "../database";
import { orgs } from "../database/schema";
import { eq } from "drizzle-orm";

type ExotelCreds = { sid: string; apiKey: string; apiToken: string; subdomain: string } | null;

export async function getExotelCredsForOrg(orgId?: string | null): Promise<ExotelCreds> {
  if (!orgId) return null;
  const [org] = await db
    .select({
      sid: orgs.exotelSid,
      apiKey: orgs.exotelApiKey,
      apiToken: orgs.exotelApiToken,
      subdomain: orgs.exotelSubdomain,
    })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org?.sid || !org?.apiKey || !org?.apiToken) return null;
  return { sid: org.sid, apiKey: org.apiKey, apiToken: org.apiToken, subdomain: org.subdomain ?? "api.exotel.com" };
}

export type ExotelCallResult = { ok: true; callSid: string } | { ok: false; error: string };

/**
 * Places an outbound call directly connected to our bot over WebSocket via
 * Exotel's `/calls/connect` API (`streamtype=bidirectional`) — no separate
 * answer webhook/XML round-trip needed, unlike Twilio/Plivo (see
 * docs/india-telephony.md's status note on why this is a genuinely
 * different call-placement shape, not just a different vendor).
 *
 * NOTE — unverified without a live prototype call: whether the `call.sid`
 * this API returns is guaranteed to equal the `call_sid` the WS `start`
 * event later carries hasn't been confirmed against a real account.
 * stream.ts's start handler has a lazy-insert fallback (using the start
 * event's own from/to) specifically so a mismatch here doesn't leave the
 * call without any DB row or agent config — it just won't have this
 * request's org/persona context in that case.
 */
export async function createExotelOutboundCall(input: {
  orgId: string;
  to: string;
  from: string;
  streamUrl: string;
}): Promise<ExotelCallResult> {
  const creds = await getExotelCredsForOrg(input.orgId);
  if (!creds) return { ok: false, error: "No Exotel credentials configured for this org" };

  try {
    // Exotel's own param names are inverted from our convention: its `from`
    // is "the number to dial" (our `to`, the customer) and `callerid` is
    // "your Exophone" (our `from`, the org's number) — mapped explicitly
    // here rather than renaming our function's params to match, since every
    // other provider in this codebase uses to/from the usual way.
    const body = new URLSearchParams({
      from: input.to,
      callerid: input.from,
      streamurl: input.streamUrl,
      streamtype: "bidirectional",
    });
    const res = await fetch(
      `https://${creds.subdomain}/v1/accounts/${encodeURIComponent(creds.sid)}/calls/connect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${creds.apiKey}:${creds.apiToken}`).toString("base64")}`,
        },
        body,
      },
    );
    const data = (await res.json().catch(() => ({}))) as { call?: { sid?: string }; message?: string };
    if (!res.ok) return { ok: false, error: data.message ?? `Exotel call connect failed (status ${res.status})` };
    if (!data.call?.sid) return { ok: false, error: "Exotel did not return a call sid" };
    return { ok: true, callSid: data.call.sid };
  } catch (err) {
    return { ok: false, error: `Failed to reach Exotel: ${(err as Error).message}` };
  }
}

export type ExotelSmsResult = { ok: true; smsSid: string } | { ok: false; error: string };

/** Sends an SMS via Exotel's Campaigns/Sms API — the SMS analog of
 * createExotelOutboundCall. Added for Misc-4: Plivo/Exotel orgs previously
 * had no SMS path at all (workflows/engine.ts's sendSms action was
 * hardcoded to Twilio). */
export async function sendExotelSms(input: {
  orgId: string;
  to: string;
  from: string;
  body: string;
}): Promise<ExotelSmsResult> {
  const creds = await getExotelCredsForOrg(input.orgId);
  if (!creds) return { ok: false, error: "No Exotel credentials configured for this org" };

  try {
    const body = new URLSearchParams({ From: input.from, To: input.to, Body: input.body });
    const res = await fetch(
      `https://${creds.subdomain}/v1/accounts/${encodeURIComponent(creds.sid)}/sms/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${creds.apiKey}:${creds.apiToken}`).toString("base64")}`,
        },
        body,
      },
    );
    const data = (await res.json().catch(() => ({}))) as { SMSMessage?: { Sid?: string }; message?: string };
    if (!res.ok) return { ok: false, error: data.message ?? `Exotel SMS send failed (status ${res.status})` };
    return { ok: true, smsSid: data.SMSMessage?.Sid ?? "" };
  } catch (err) {
    return { ok: false, error: `Failed to reach Exotel: ${(err as Error).message}` };
  }
}
