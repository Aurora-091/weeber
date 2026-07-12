/**
 * Plivo outbound call placement + credential resolution — the Plivo analog
 * of twilio-client.ts. BYO-only today (see voice/plivo-provisioning.ts): no
 * platform-owned Plivo account, so this always resolves the org's own
 * stored credentials, never a global default.
 */
import { db } from "../database";
import { orgs } from "../database/schema";
import { eq } from "drizzle-orm";

type PlivoCreds = { authId: string; authToken: string } | null;

export async function getPlivoCredsForOrg(orgId?: string | null): Promise<PlivoCreds> {
  if (!orgId) return null;
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
 * Session correlation: confirmed against Plivo's own Calls API docs
 * (plivo.com/docs/voice/api/calls, "answer_url / fallback_url parameters")
 * — request_uuid and CallUUID are explicitly DIFFERENT identifiers, but
 * Plivo posts BOTH RequestUUID and CallUUID to the answer_url webhook, so
 * `/incoming/plivo` looks the prior session up by RequestUUID and rebinds
 * it to the real CallUUID there — a documented correlator, not a guess.
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
