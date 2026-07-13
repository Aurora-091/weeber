/**
 * Plivo BYO telephony — validate + store a merchant's own Plivo credentials.
 * See docs/india-telephony.md: Plivo is the recommended default for
 * merchants with no existing telephony (WebSocket media streaming, same
 * architecture family as Twilio's Media Streams, prototype pending) — but
 * there is no platform-owned sub-account/number-purchase path yet, only
 * BYO, unlike Twilio's createSubaccountForOrg/buyNumberForOrg. A merchant
 * already on Plivo plugs in their own Auth ID/Token here.
 */
import { eq } from "drizzle-orm";
import { db } from "../database";
import { orgs } from "../database/schema";

export type PlivoStatus = {
  connected: boolean;
  authId: string | null;
};

export async function getPlivoStatus(orgId: string): Promise<PlivoStatus | null> {
  const [org] = await db
    .select({ telephonyProvider: orgs.telephonyProvider, plivoAuthId: orgs.plivoAuthId })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org) return null;
  return {
    connected: org.telephonyProvider === "plivo" && Boolean(org.plivoAuthId),
    authId: org.plivoAuthId,
  };
}

export type PlivoByoResult = { ok: true } | { ok: false; error: string };

/**
 * Validates credentials against Plivo's own Account API
 * (GET /v1/Account/{authId}/, HTTP Basic authId:authToken) before
 * persisting anything or making this org's active provider — same
 * fail-fast principle as Twilio's setByoCredentials.
 */
export async function setPlivoByoCredentials(
  orgId: string,
  input: { authId: string; authToken: string; phoneNumber: string },
): Promise<PlivoByoResult> {
  const { authId, authToken, phoneNumber } = input;
  if (!authId.trim() || !authToken.trim() || !phoneNumber.trim()) {
    return { ok: false, error: "`authId`, `authToken`, and `phoneNumber` are all required" };
  }

  try {
    const res = await fetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/`, {
      headers: { Authorization: `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}` },
    });
    if (!res.ok) {
      if (res.status === 401) return { ok: false, error: "Invalid Plivo Auth ID or Auth Token" };
      return { ok: false, error: `Plivo rejected these credentials (status ${res.status})` };
    }
    const account = (await res.json().catch(() => null)) as { state?: string } | null;
    if (account?.state && account.state !== "ACTIVE") {
      return { ok: false, error: `Plivo account state is "${account.state}", not ACTIVE` };
    }
  } catch (err) {
    return { ok: false, error: `Could not verify these Plivo credentials: ${(err as Error).message}` };
  }

  await db
    .update(orgs)
    .set({
      telephonyProvider: "plivo",
      plivoAuthId: authId,
      plivoAuthToken: authToken,
      outboundNumber: phoneNumber,
    })
    .where(eq(orgs.id, orgId));

  return { ok: true };
}
