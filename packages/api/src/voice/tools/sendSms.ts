import z from "zod";
import { tool } from "ai";

/**
 * Lets the agent actually send an SMS mid-call, instead of only promising to
 * (Misc-4: the cart-recovery persona says "I can send the checkout link
 * again by SMS — should I?" as if this is live, but until now the only SMS
 * code was a post-call workflow action — a different, async capability the
 * LLM had no way to invoke itself).
 *
 * Signal-only, same pattern as every other tool here — the actual send
 * (via send-sms.ts's provider-agnostic dispatcher) happens in stream.ts's
 * onToolCall handler, which has the call's real orgId/toNumber in scope.
 */
export const sendSms = tool({
  description:
    "Send a text message to the caller right now, mid-call — e.g. a checkout link, confirmation, or " +
    "callback number. Call this only after you've told the caller you're sending it (in the same turn), " +
    "and only when the caller has actually asked for or agreed to receive a text.",
  inputSchema: z.object({
    body: z.string().max(300).describe("The exact text message content to send"),
  }),
  async execute({ body }) {
    return { smsRequested: true, body };
  },
});
