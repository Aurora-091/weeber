import z from "zod";
import { tool } from "ai";
import { annotateOrder, cancelOrder } from "../../integrations/shopify/client";

/**
 * Shopify COD-confirmation agent's tool — records whether the caller
 * confirmed their cash-on-delivery order. On confirmation, tags the order
 * via weebersh (contract endpoint 9) so user staff see it in Shopify
 * without needing a Weeber dashboard login.
 *
 * On an explicit decline, cancels the order immediately via weebersh
 * (contract endpoint 10) — audit fix. This used to only record the
 * disposition and wait for the workflow engine's `onExhausted` path (3
 * unanswered retry attempts) before cancelling, which meant a customer who
 * explicitly said "no, cancel it" on the very first call still had that
 * order sitting live and shippable until all 3 attempts were exhausted —
 * worse for both the customer (an order they explicitly declined might
 * still ship) and the user (real fulfillment cost on an order that was
 * never going to be accepted). An explicit verbal decline is qualitatively
 * different from a no-answer/busy/failed outcome — it's real information
 * from the customer, not an unknown to retry into — so it short-circuits
 * straight to cancellation instead of going through the retry-then-give-up
 * path meant for cases where we genuinely don't know the outcome yet.
 *
 * Declines are also tagged (2026-07-18) — the cancel already carries a
 * staff note, but a merchant scanning/filtering the order list has no way
 * to spot "this was a Weeber-driven decline" versus any other cancellation
 * reason without opening each order individually. Mirrors the confirmed
 * path's tag so both outcomes are equally visible from the order list, not
 * just the confirm path.
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
      const declineNote = notes ?? "Customer explicitly declined COD order during confirmation call";
      let tagged = false;
      try {
        await annotateOrder({ shop, orderId, tagsAdd: ["cod-declined"], note: declineNote });
        tagged = true;
      } catch (err) {
        console.error("[shopify] failed to tag declined COD order", err);
      }
      try {
        const result = await cancelOrder({
          shop,
          orderId,
          reason: "DECLINED",
          notifyCustomer: false,
          restock: true,
          staffNote: declineNote,
        });
        return {
          recorded: true,
          confirmed: false,
          notes: notes ?? null,
          canceled: result.status === 200 || result.status === 202,
          tagged,
        };
      } catch (err) {
        console.error("[shopify] failed to cancel declined COD order", err);
        return { recorded: true, confirmed: false, notes: notes ?? null, canceled: false, tagged };
      }
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
