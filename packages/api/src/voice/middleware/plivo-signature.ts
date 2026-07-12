import { createMiddleware } from "hono/factory";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../database";
import { orgs } from "../../database/schema";

/**
 * Validates that a request to /api/voice/incoming/plivo actually came from
 * Plivo, using Plivo's own signature scheme (X-Plivo-Signature-V3 +
 * X-Plivo-Signature-V3-Nonce headers, HMAC-SHA256 over `${method} ${uri}${nonce}`
 * keyed by the org's Plivo auth token) — algorithm taken directly from
 * Plivo's own docs (plivo.com/docs, "Manual Signature Validation"), adapted
 * to use the request's actual HTTP method rather than assuming GET, since
 * this route is fetched via POST (see plivo-client.ts's `answer_method`).
 *
 * Org resolution: unlike Twilio (where a CallSid already links back to an
 * org via an existing DB row), Plivo's answer webhook is often the FIRST
 * request for a fresh outbound call — there's no row yet to look up an org
 * from. Resolved instead from an `orgId` query param on the answer_url
 * itself (plivo-client.ts's `createPlivoOutboundCall` appends it) — a
 * merchant wiring up a Plivo number for pure inbound use needs to include
 * the same `?orgId=` on the Answer URL configured in their Plivo
 * Application. Falls back to skipping validation (loud warning) if no
 * org/token can be resolved, matching requireTwilioSignature's fail-open
 * shape — this is unverified against a live Plivo account (see
 * docs/india-telephony.md's status note), flagged rather than assumed
 * correct.
 */
let warnedMissingToken = false;

export const requirePlivoSignature = createMiddleware(async (c, next) => {
  const orgId = c.req.query("orgId");
  let authToken: string | undefined;

  if (orgId) {
    const [org] = await db.select({ token: orgs.plivoAuthToken }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    authToken = org?.token ?? undefined;
  }

  if (!authToken) {
    if (!warnedMissingToken) {
      console.warn("[plivo-signature] No org-specific Plivo auth token could be resolved (missing/unknown ?orgId=) — skipping signature validation");
      warnedMissingToken = true;
    }
    return next();
  }

  const signature = c.req.header("x-plivo-signature-v3");
  const nonce = c.req.header("x-plivo-signature-v3-nonce");
  if (!signature || !nonce) {
    return c.json({ error: "Missing Plivo signature headers" }, 401);
  }

  const uri = c.req.url;
  const baseString = `${c.req.method} ${uri}${nonce}`;
  const expected = crypto.createHmac("sha256", authToken).update(baseString).digest("base64");

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  const valid = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  if (!valid) {
    return c.json({ error: "Invalid Plivo signature" }, 401);
  }

  return next();
});
