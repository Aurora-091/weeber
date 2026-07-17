/**
 * Plivo outbound call placement + credential resolution — the Plivo analog
 * of twilio-client.ts. BYO-only today (see voice/plivo-provisioning.ts): no
 * platform-owned Plivo account, so this always resolves the org's own
 * stored credentials, never a global default.
 */
import { db } from "../database";
import { orgs } from "../database/schema";
import { eq } from "drizzle-orm";
import { readCredential, PLIVO_FIELDS } from "../database/credential-vault";

type PlivoCreds = { authId: string; authToken: string } | null;

export async function getPlivoCredsForOrg(orgId?: string | null): Promise<PlivoCreds> {
  if (!orgId) return null;

  const vaultId = await readCredential(orgId, PLIVO_FIELDS.authId);
  const vaultToken = await readCredential(orgId, PLIVO_FIELDS.authToken);
  if (vaultId && vaultToken) return { authId: vaultId, authToken: vaultToken };

  const [org] = await db
    .select({ authId: orgs.plivoAuthId, authToken: orgs.plivoAuthToken })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org?.authId || !org?.authToken) return null;
  return { authId: org.authId, authToken: org.authToken };
}

export type PlivoCallResult =
  | { ok: true; requestUuid: string }
  | { ok: false; error: string };

/**
 * Places an outbound call via Plivo's Call Create API. `answerUrl` is
 * fetched by Plivo once the call is answered and must return Plivo XML
 * (see buildPlivoStreamXml) — same call-then-webhook-returns-XML shape as
 * Twilio's outbound flow, reusing the same `/api/voice/incoming/plivo`
 * route for both inbound and outbound (mirrors how Twilio's `/incoming`
 * already doubles as both).
 *
 * NOTE — unverified without a live prototype call (see
 * docs/india-telephony.md): Plivo's own docs describe `request_uuid` as
 * identifying "the request", and in practice it equals the call's real
 * `CallUUID` for a simple single-leg outbound call — but the answer
 * webhook (not this response) is treated as the authoritative point where
 * we bind session/org context to the real CallUUID, specifically so this
 * assumption isn't load-bearing if it turns out to be wrong.
 */
export async function createPlivoOutboundCall(input: {
  orgId: string;
  to: string;
  from: string;
  answerUrl: string;
}): Promise<PlivoCallResult> {
  const creds = await getPlivoCredsForOrg(input.orgId);
  if (!creds) return { ok: false, error: "No Plivo credentials configured for this org" };

  try {
    const res = await fetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(creds.authId)}/Call/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${creds.authId}:${creds.authToken}`).toString("base64")}`,
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        answer_url: input.answerUrl,
        answer_method: "POST",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { request_uuid?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `Plivo call create failed (status ${res.status})` };
    if (!data.request_uuid) return { ok: false, error: "Plivo did not return a request_uuid" };
    return { ok: true, requestUuid: data.request_uuid };
  } catch (err) {
    return { ok: false, error: `Failed to reach Plivo: ${(err as Error).message}` };
  }
}

/** Plivo Answer XML — a bidirectional audio stream to our WS endpoint, same
 * purpose as Twilio's `<Connect><Stream>` TwiML. */
export function buildPlivoStreamXml(wsUrl: string): string {
  return `<Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream></Response>`;
}

export type PlivoSmsResult = { ok: true; messageUuid: string } | { ok: false; error: string };

export type PlivoActionResult = { ok: true } | { ok: false; error: string };

/**
 * Hangs up an in-progress Plivo call — the Plivo analog of Twilio's
 * `.calls(sid).update({status: "completed"})`, closing the gap flagged in
 * docs/india-telephony.md ("Mid-call hang-up ... remain Twilio-only").
 * Plivo's own docs: `DELETE /v1/Account/{auth_id}/Call/{call_uuid}/` ends
 * an ongoing call or cancels a queued outbound one — same endpoint either
 * way, no separate "cancel vs hangup" distinction to make here.
 */
export async function hangupPlivoCall(orgId: string, callUuid: string): Promise<PlivoActionResult> {
  const creds = await getPlivoCredsForOrg(orgId);
  if (!creds) return { ok: false, error: "No Plivo credentials configured for this org" };

  try {
    const res = await fetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(creds.authId)}/Call/${encodeURIComponent(callUuid)}/`, {
      method: "DELETE",
      headers: { Authorization: `Basic ${Buffer.from(`${creds.authId}:${creds.authToken}`).toString("base64")}` },
    });
    // Plivo returns 204 No Content on success; a non-2xx body (when present) carries an error field.
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? `Plivo hangup failed (status ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to reach Plivo: ${(err as Error).message}` };
  }
}

/**
 * Transfers an in-progress Plivo call by redirecting its A-leg to fetch new
 * XML from `alegUrl` — the Plivo analog of Twilio's mid-call `.update({twiml})`
 * redirect (see stream.ts's performTransfer). Plivo's own docs: `POST
 * /v1/Account/{auth_id}/Call/{call_uuid}/` with `legs=aleg` and `aleg_url`
 * pointing to a URL that returns Plivo XML (same `<Dial>` shape
 * buildPlivoTransferXml below returns) redirects that leg's call flow —
 * "Transfer a call", not a queued action, takes effect immediately.
 */
export async function transferPlivoCall(orgId: string, callUuid: string, alegUrl: string): Promise<PlivoActionResult> {
  const creds = await getPlivoCredsForOrg(orgId);
  if (!creds) return { ok: false, error: "No Plivo credentials configured for this org" };

  try {
    const res = await fetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(creds.authId)}/Call/${encodeURIComponent(callUuid)}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${creds.authId}:${creds.authToken}`).toString("base64")}`,
      },
      body: JSON.stringify({ legs: "aleg", aleg_url: alegUrl, aleg_method: "GET" }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? `Plivo transfer failed (status ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to reach Plivo: ${(err as Error).message}` };
  }
}

/** Plivo XML for a transfer target — dials `transferNumber` and hangs up
 * once that leg ends, same shape/intent as stream.ts's Twilio VoiceResponse
 * `<Dial>` in performTransfer. Served by whatever route `alegUrl` points
 * to (see voice/routes.ts's transfer-xml endpoint). */
export function buildPlivoTransferXml(transferNumber: string): string {
  return `<Response><Dial>${transferNumber}</Dial></Response>`;
}


/** Sends an SMS via Plivo's Message Create API — the SMS analog of
 * createPlivoOutboundCall. Added for Misc-4: Plivo/Exotel orgs previously
 * had no SMS path at all (workflows/engine.ts's sendSms action was
 * hardcoded to Twilio). */
export async function sendPlivoSms(input: {
  orgId: string;
  to: string;
  from: string;
  body: string;
}): Promise<PlivoSmsResult> {
  const creds = await getPlivoCredsForOrg(input.orgId);
  if (!creds) return { ok: false, error: "No Plivo credentials configured for this org" };

  try {
    const res = await fetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(creds.authId)}/Message/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${creds.authId}:${creds.authToken}`).toString("base64")}`,
      },
      body: JSON.stringify({ src: input.from, dst: input.to, text: input.body }),
    });
    const data = (await res.json().catch(() => ({}))) as { message_uuid?: string[]; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `Plivo message create failed (status ${res.status})` };
    return { ok: true, messageUuid: data.message_uuid?.[0] ?? "" };
  } catch (err) {
    return { ok: false, error: `Failed to reach Plivo: ${(err as Error).message}` };
  }
}
