import type { Context, Next } from "hono";

/**
 * Auth for the outbound direction of the weebersh <-> Weeber contract
 * (weebersh -> Weeber, i.e. every route in ./routes.ts). Per contract.md:
 * "every request carries header X-Weeber-Secret: ${WEEBER_INTERNAL_SECRET}.
 * Backend rejects missing/wrong secret with 401." This is a *different*
 * secret from WEEBER_CALLBACK_SECRET (used in client.ts, the other
 * direction) so each side can be rotated independently.
 */
export async function requireWeeberSecret(c: Context, next: Next) {
  const expected = process.env.WEEBER_INTERNAL_SECRET;
  if (!expected) {
    console.error("[shopify] WEEBER_INTERNAL_SECRET not configured — rejecting all inbound webhook traffic");
    return c.json({ error: "not configured" }, 500);
  }
  const provided = c.req.header("X-Weeber-Secret");
  if (provided !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
