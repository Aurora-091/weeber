/**
 * Exotel WebSocket stream authentication (2026-07-17) — the Exotel analog
 * of requireTwilioSignature/requirePlivoSignature, structurally different
 * from both because it has to be: Exotel has no answer-webhook HTTP route
 * to attach Hono middleware to. Outbound calls connect straight to our
 * WebSocket via Exotel's `/calls/connect` API (`streamtype=bidirectional`)
 * with no XML/webhook round-trip at all (see exotel-client.ts's doc
 * comment) — the entry point that needs guarding is the WS *upgrade*
 * request itself (ws-route.ts), not a Hono POST route, so this is a plain
 * verification function called from there, not `createMiddleware(...)`.
 *
 * Exotel's own documented auth model for this exact integration point
 * (support.exotel.com/support/solutions/articles/3000108630, "Working with
 * the Stream and Voicebot Applet") is HTTP Basic Auth embedded directly in
 * the WSS URL — "specify credentials in the WSS URL, but Exotel transmits
 * them securely in headers during the connection." Not an HMAC-signed
 * payload like Twilio/Plivo (Exotel's product genuinely doesn't offer that
 * for this endpoint) — this verifies exactly what Exotel actually sends:
 * the WSS URL's username is the orgId, the password is that org's own
 * Exotel API token (already stored via the BYO flow, exotel-provisioning.ts)
 * reused as the shared secret rather than minting a new one, since it's
 * already a real per-org credential only that org (and Exotel, and us)
 * know — no new provisioning UI needed for this to work.
 */
import crypto from "node:crypto";
import { getExotelCredsForOrg } from "../exotel-client";

export type ExotelAuthResult = { ok: true; orgId: string } | { ok: false; error: string };

/**
 * Verifies the `Authorization: Basic ...` header Exotel sends on the WS
 * upgrade request against the claimed org's real, stored Exotel API token.
 * Fails closed on anything malformed/missing/mismatched — unlike
 * requirePlivoSignature's "skip validation, warn loudly" fallback (which
 * exists for backward compatibility with connections that predate that
 * check), nothing predates this one, so there's no legacy traffic a lenient
 * fallback would need to protect.
 */
export async function verifyExotelStreamAuth(request: Request): Promise<ExotelAuthResult> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) {
    return { ok: false, error: "Missing or malformed Authorization header on Exotel stream upgrade" };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return { ok: false, error: "Malformed Basic auth payload" };
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return { ok: false, error: "Malformed Basic auth payload" };
  const orgId = decodeURIComponent(decoded.slice(0, separatorIndex));
  const providedToken = decodeURIComponent(decoded.slice(separatorIndex + 1));
  if (!orgId || !providedToken) return { ok: false, error: "Missing orgId or token in Basic auth payload" };

  const creds = await getExotelCredsForOrg(orgId);
  if (!creds) return { ok: false, error: `No Exotel credentials configured for org ${orgId}` };

  const expectedBuf = Buffer.from(creds.apiToken);
  const providedBuf = Buffer.from(providedToken);
  const valid = expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
  if (!valid) return { ok: false, error: "Exotel stream auth token mismatch" };

  return { ok: true, orgId };
}
