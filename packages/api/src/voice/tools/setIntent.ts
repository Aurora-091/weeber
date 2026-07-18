import z from "zod";
import { tool } from "ai";

/**
 * Intent detection — lets the agent record WHY the caller called / what they actually want,
 * distinct from `setDisposition` (which records how the call ENDED). Call this as soon as the
 * caller's purpose becomes clear, typically early-to-mid conversation — not at the end like
 * setDisposition. A call can have both: e.g. intent=escalation_request (they wanted a human)
 * and disposition=callback-requested (that's how it ended).
 *
 * Flat, vertical-agnostic taxonomy on purpose (same simplicity as setDisposition's enum) —
 * works across Shopify (cart recovery, COD, feedback) and Insurance (renewal, lead follow-up,
 * appointment setting) without a per-vertical config. Analytics: computeOrgAnalytics's
 * `intentBreakdown` (org-queries.ts), surfaced on the admin dashboard's Analytics page.
 *
 * The actual DB write happens in stream.ts's onToolCall handler (same pattern as
 * setDisposition/every other tool here) — this tool's job is just to let the model express the
 * intent in a structured way.
 */
export const setIntent = tool({
  description:
    "Record why the caller actually called / what they want, as soon as it's clear — usually early " +
    "in the conversation, not at the end. Distinct from the call's eventual outcome.",
  inputSchema: z.object({
    intent: z
      .enum([
        "purchase_or_booking",
        "order_or_policy_inquiry",
        "complaint_or_dissatisfaction",
        "cancellation_or_opt_out",
        "escalation_request",
        "pricing_or_discount",
        "wrong_person_or_spam",
        "other",
      ])
      .describe(
        "purchase_or_booking: wants to buy/complete an order/confirm a renewal/book an appointment. " +
          "order_or_policy_inquiry: asking about status, details, or documents. " +
          "complaint_or_dissatisfaction: unhappy about something and wants it addressed. " +
          "cancellation_or_opt_out: wants to cancel, decline, or unsubscribe. " +
          "escalation_request: wants a human/licensed advisor, not the agent. " +
          "pricing_or_discount: objecting to or asking about price/discount. " +
          "wrong_person_or_spam: not the right contact, or clearly not a real conversation. " +
          "other: doesn't fit any of the above.",
      ),
    notes: z.string().optional().describe("Brief context for why this intent was chosen"),
  }),
  async execute({ intent, notes }) {
    return { recorded: true, intent, notes: notes ?? null };
  },
});
