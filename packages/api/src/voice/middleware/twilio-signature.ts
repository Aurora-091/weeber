import { createMiddleware } from "hono/factory";
import twilioPkg from "twilio";
import { eq, or } from "drizzle-orm";
import { getPublicUrl, getAuthTokenForOrg } from "../twilio-client";
import { db } from "../../database";
import { calls, orgs, orgPhoneNumbers } from "../../database/schema";

/**
 * Validates that incoming webhook requests actually came from Twilio, using
 * Twilio's request-signing scheme (X-Twilio-Signature header + HMAC-SHA1
 * over the full URL + sorted POST params, keyed by the account auth token).
 *
 * Without this, anyone who discovers the webhook URLs (/incoming,
 * /status-callback, /recording-status) can POST forged CallSid/CallStatus
 * data — corrupting call records, forging "completed" statuses, or
 * triggering workflow actions (e.g. fake "not-interested" -> DNC-add) for
 * numbers that were never actually called.
 *
 * Org-aware (ADR-042): Twilio signs every webhook with the auth token of
 * whichever ACCOUNT actually placed/owns the call — the platform default
 * for most calls, but a sub-account's or BYO user's own token for calls
 * on their dedicated Twilio account (see twilio-provisioning.ts). Validating
 * everything against only the global TWILIO_AUTH_TOKEN would silently
 * reject every one of those orgs' webhooks. Resolution order:
 *   1. CallSid -> calls.orgId (covers status-callback/recording-status/
 *      amd-status-callback, and the outbound leg of /incoming — the call
 *      row already exists by the time any of these fire).
 *   2. Either party's number -> an org's number, checked against BOTH
 *      `To` (a genuinely fresh *inbound* call: To is the org's own
 *      number the caller dialed) AND `From` (the very first webhook of an
 *      *outbound* call we placed: From is the org's number, To is the
 *      customer's — the calls row from rule 1 doesn't exist yet since
 *      placeOutboundCall() never inserts one before dialing, it's only
 *      created inside the /incoming handler once that request clears this
 *      middleware). Checks both the legacy `orgs.outboundNumber` column
 *      and the newer per-number `org_phone_numbers` table (C2b), since a
 *      number bought through the picker only ever lands in the latter.
 *      Fixed 2026-07-15: previously only checked `To` against
 *      `orgs.outboundNumber`, which can never match on an outbound call's
 *      first webhook — every BYO/sub-account org's outbound calls fell
 *      through to the global token below and got rejected outright.
 *   3. Falls back to the global TWILIO_AUTH_TOKEN when neither resolves —
 *      unchanged behavior for platform-only deployments.
 *
 * Skips validation with a loud warning if no token can be resolved at all
 * (shouldn't happen given config-check.ts, but fail open with visibility
 * rather than crash every webhook call).
 *
 * Parses the form body once here and stores it on context as "twilioBody" —
 * route handlers must read `c.get("twilioBody")` instead of calling
 * `c.req.parseBody()` again, since a request body can only be consumed once.
 */
let warnedMissingToken = false;

async function resolveAuthTokenForRequest(params: Record<string, string>): Promise<string | undefined> {
  const callSid = params.CallSid;
  if (callSid) {
    const [row] = await db.select({ orgId: calls.orgId }).from(calls).where(eq(calls.twilioCallSid, callSid)).limit(1);
    if (row?.orgId) return getAuthTokenForOrg(row.orgId);
  }

  // Either party's number can be the org's own: `To` on a fresh inbound
  // call, `From` on the first webhook of an outbound call we placed (its
  // calls row doesn't exist yet — see rule 1's doc comment above).
  const candidateNumbers = [params.To, params.From].filter((n): n is string => Boolean(n));
  if (candidateNumbers.length > 0) {
    const [legacyOrg] = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(or(...candidateNumbers.map((n) => eq(orgs.outboundNumber, n))))
      .limit(1);
    if (legacyOrg) return getAuthTokenForOrg(legacyOrg.id);

    const [provisionedNumber] = await db
      .select({ orgId: orgPhoneNumbers.orgId })
      .from(orgPhoneNumbers)
      .where(or(...candidateNumbers.map((n) => eq(orgPhoneNumbers.phoneNumber, n))))
      .limit(1);
    if (provisionedNumber) return getAuthTokenForOrg(provisionedNumber.orgId);
  }

  return process.env.TWILIO_AUTH_TOKEN;
}

export const requireTwilioSignature = createMiddleware<{
  Variables: { twilioBody: Record<string, string> };
}>(async (c, next) => {
  const rawBody = await c.req.parseBody();
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawBody)) {
    params[key] = String(value);
  }
  c.set("twilioBody", params);

  const authToken = await resolveAuthTokenForRequest(params).catch((err) => {
    console.error("[twilio-signature] failed to resolve org-specific auth token, falling back to global", err);
    return process.env.TWILIO_AUTH_TOKEN;
  });

  if (!authToken) {
    if (!warnedMissingToken) {
      console.warn("[twilio-signature] No auth token could be resolved (global or org-specific) — skipping webhook signature validation");
      warnedMissingToken = true;
    }
    return next();
  }

  const signature = c.req.header("X-Twilio-Signature");
  if (!signature) {
    return c.json({ error: "Missing X-Twilio-Signature header" }, 403);
  }

  // Twilio signs the exact public URL it called plus the parsed form body.
  // Reconstruct the URL from PUBLIC_APP_URL (not the request itself) since
  // requests may arrive via a proxy/tunnel with a different Host header.
  let url: string;
  try {
    const path = new URL(c.req.url).pathname;
    url = `${getPublicUrl()}${path}`;
  } catch {
    return c.json({ error: "Unable to resolve public URL for signature validation" }, 500);
  }

  const valid = twilioPkg.validateRequest(authToken, signature, url, params);
  if (!valid) {
    console.warn(`[twilio-signature] rejected request with invalid signature for ${url}`);
    return c.json({ error: "Invalid Twilio signature" }, 403);
  }

  return next();
});
