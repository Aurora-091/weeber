import { createMiddleware } from "hono/factory";
import twilioPkg from "twilio";
import { getPublicUrl } from "../twilio-client";

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
 * Skips validation with a loud warning if TWILIO_AUTH_TOKEN is missing
 * (shouldn't happen given config-check.ts, but fail open with visibility
 * rather than crash every webhook call).
 *
 * Parses the form body once here and stores it on context as "twilioBody" —
 * route handlers must read `c.get("twilioBody")` instead of calling
 * `c.req.parseBody()` again, since a request body can only be consumed once.
 */
let warnedMissingToken = false;

export const requireTwilioSignature = createMiddleware<{
  Variables: { twilioBody: Record<string, string> };
}>(async (c, next) => {
  const rawBody = await c.req.parseBody();
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawBody)) {
    params[key] = String(value);
  }
  c.set("twilioBody", params);

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    if (!warnedMissingToken) {
      console.warn("[twilio-signature] TWILIO_AUTH_TOKEN not set — skipping webhook signature validation");
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
