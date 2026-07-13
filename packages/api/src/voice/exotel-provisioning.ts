/**
 * Exotel BYO telephony — validate + store a user's own Exotel
 * credentials. See docs/india-telephony.md: Exotel's AI-agent path is
 * SIP-trunk-based (bridged into LiveKit), not a drop-in replacement for
 * the WebSocket Media-Streams-style transport this codebase is built
 * against today — so wiring credentials here does NOT mean live calls can
 * route through Exotel yet, that needs the SIP bridge work described in
 * the doc. This covers the "user already has an Exotel account and
 * wants Weeber to recognize it" half: BYO-only, no platform sub-account
 * path, same shape as Plivo's.
 */
import { eq } from "drizzle-orm";
import { db } from "../database";
import { orgs } from "../database/schema";

export type ExotelStatus = {
  connected: boolean;
  sid: string | null;
  subdomain: string | null;
};

export async function getExotelStatus(orgId: string): Promise<ExotelStatus | null> {
  const [org] = await db
    .select({
      telephonyProvider: orgs.telephonyProvider,
      exotelSid: orgs.exotelSid,
      exotelSubdomain: orgs.exotelSubdomain,
    })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org) return null;
  return {
    connected: org.telephonyProvider === "exotel" && Boolean(org.exotelSid),
    sid: org.exotelSid,
    subdomain: org.exotelSubdomain,
  };
}

export type ExotelByoResult = { ok: true } | { ok: false; error: string };

const DEFAULT_SUBDOMAIN = "api.exotel.com";

/**
 * Validates credentials against Exotel's own Accounts API
 * (GET /v1/Accounts/{sid}/, HTTP Basic apiKey:apiToken) before persisting
 * anything. `subdomain` defaults to the global host since Exotel's API
 * host is region-specific per account (e.g. api.in1.exotel.com) and not
 * guessable from the SID alone.
 */
export async function setExotelByoCredentials(
  orgId: string,
  input: { sid: string; apiKey: string; apiToken: string; subdomain?: string; phoneNumber: string },
): Promise<ExotelByoResult> {
  const { sid, apiKey, apiToken, phoneNumber } = input;
  const subdomain = input.subdomain?.trim() || DEFAULT_SUBDOMAIN;
  if (!sid.trim() || !apiKey.trim() || !apiToken.trim() || !phoneNumber.trim()) {
    return { ok: false, error: "`sid`, `apiKey`, `apiToken`, and `phoneNumber` are all required" };
  }

  try {
    const res = await fetch(`https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/`, {
      headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString("base64")}` },
    });
    if (!res.ok) {
      if (res.status === 401) return { ok: false, error: "Invalid Exotel API Key or API Token" };
      if (res.status === 404) return { ok: false, error: `Account SID not found at ${subdomain} — check the subdomain for your account's region` };
      return { ok: false, error: `Exotel rejected these credentials (status ${res.status})` };
    }
  } catch (err) {
    return { ok: false, error: `Could not verify these Exotel credentials: ${(err as Error).message}` };
  }

  await db
    .update(orgs)
    .set({
      telephonyProvider: "exotel",
      exotelSid: sid,
      exotelApiKey: apiKey,
      exotelApiToken: apiToken,
      exotelSubdomain: subdomain,
      outboundNumber: phoneNumber,
    })
    .where(eq(orgs.id, orgId));

  return { ok: true };
}
