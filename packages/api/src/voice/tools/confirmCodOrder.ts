import z from "zod";
import { tool } from "ai";
import { annotateOrder } from "../../integrations/shopify/client";

/**
 * Shopify COD-confirmation agent's tool — records whether the caller
 * confirmed their cash-on-delivery order. On confirmation, tags the order
 * via weebersh (contract endpoint 9) so user staff see it in Shopify
 * without needing a Weeber dashboard login. Declines are NOT cancelled
 * here directly — that's handled by the workflow engine's `onExhausted`
 * path (see workflows/types.ts) so a single call's tool output can't
 * itself trigger an order cancellation without going through the same
 * retry-then-give-up logic every other outcome does.
 */
export const confirmCodOrder = tool({
  description:
    "Record whether the caller confirmed their cash-on-delivery order. Call this once you have a clear yes/no.",
  inputSchema: z.object({
    shop: z.string(),
    orderId: z.number(),
    confirmed: z.boolean(),
    notes: z.string().optional(),
  }),
  async execute({ shop, orderId, confirmed, notes }) {
    if (!confirmed) {
      return { recorded: true, confirmed: false, notes: notes ?? null };
    }
    try {
      await annotateOrder({ shop, orderId, tagsAdd: ["cod-confirmed"], note: notes ?? "Confirmed via Weeber call" });
      return { recorded: true, confirmed: true, tagged: true };
    } catch (err) {
      console.error("[shopify] failed to annotate confirmed COD order", err);
      return { recorded: true, confirmed: true, tagged: false };
    }
  },
});
