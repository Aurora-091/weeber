import z from "zod";
import { tool } from "ai";
import { annotateOrder, cancelOrder } from "../../integrations/shopify/client";

/**
 * Which order this call is about, and which store it belongs to — bound
 * server-side at session construction, never supplied by the model.
 *
 * G1.3 (2026-08-01), applying ADR-064's rule to the destructive tool. See
 * `createConfirmCodOrderTool` for why this had to change.
 */
export type CodOrderContext = {
  /** Shopify shop domain, from the call's own `scheduledCalls.metadata`. */
  shop: string;
  /** The Shopify order this call was scheduled about. */
  orderId: number;
};

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
 *
 * ---
 *
 * **Why this is a factory (G1.3, 2026-08-01).** The tool used to take
 * `shop: z.string()` and `orderId: z.number()` as *model-authored inputs*,
 * while the `confirmed: false` branch cancels and restocks a live Shopify
 * order. Two things made that indefensible:
 *
 *  1. **The model had no legitimate source for the order ID.** The persona
 *     carried `{{order_id}}` as a merge tag and nothing ever rendered the
 *     persona body, and no facts block emitted an order reference either. So
 *     the number could not arrive by any correct path — the only way for the
 *     model to fill that field was to invent one. A hallucinated ID plus a
 *     customer saying "no" cancels and restocks *a different customer's
 *     order*, silently, with a staff note claiming they declined it.
 *  2. **`shop` was a cross-tenant write surface.** Same hole ADR-064 closed
 *     on `offerCartRecoveryDiscount`: a model-supplied shop domain means one
 *     org's call can address another org's store.
 *
 * Both values are already known server-side before the call is dialled —
 * they're what the workflow used to schedule it. So they are closed over
 * here, and the model's input narrows to the only two fields it is actually
 * the right author of: the yes/no it heard, and a free-text note.
 *
 * The gate is **non-registration**, not validation: `resolveCodOrderContext`
 * returns `undefined` when the metadata is missing, and `buildVoiceTools`
 * then omits the tool entirely for that call. A tool that isn't in the
 * request cannot be called with a guessed argument.
 */
export function createConfirmCodOrderTool(ctx: CodOrderContext) {
  const { shop, orderId } = ctx;
  return tool({
    description:
      "Record whether the caller confirmed their cash-on-delivery order. Call this once you have a clear " +
      "yes/no. You do not identify the order — this call is already tied to the correct one. Passing " +
      "confirmed: false cancels that order immediately and cannot be undone, so only use it when the " +
      "customer has clearly and deliberately declined.",
    inputSchema: z.object({
      confirmed: z
        .boolean()
        .describe("True if the caller confirmed the order should ship, false if they declined it."),
      notes: z
        .string()
        .optional()
        .describe("Anything the caller said that the merchant's staff should see on the order, in their own words."),
    }),
    async execute({ confirmed, notes }) {
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
}

/**
 * Derives the bound order context from a scheduled call's stored metadata, or
 * `undefined` when this call has no order attached to it — in which case
 * `buildVoiceTools` does not register the tool at all.
 *
 * Reads the order reference from `orderId` **and** `order_id`. The COD and
 * feedback producers in `integrations/shopify/routes.ts` write the camelCase
 * `orderId`, which is also what `voice/workflows/engine.ts` reads for the
 * post-call annotate, so it cannot be renamed without breaking that path;
 * `order_id` is accepted alongside it because the rest of the workflow context
 * is snake_case and a future producer will reasonably reach for it.
 *
 * The order reference must be a positive integer. Shopify order IDs are
 * numeric, `cancelOrder`/`annotateOrder` type them as `number`, and a metadata
 * value that doesn't parse cleanly means we do not reliably know which order
 * this is — which is exactly the case where the tool must not exist rather
 * than act on a best guess.
 */
export function resolveCodOrderContext(input: {
  metadata?: Record<string, string | number> | null;
}): CodOrderContext | undefined {
  const metadata = input.metadata ?? {};
  const shop = String(metadata.shop ?? metadata.shop_name ?? "").trim();
  if (!shop) return undefined;

  const rawOrderId = metadata.orderId ?? metadata.order_id;
  if (rawOrderId === undefined || rawOrderId === null || String(rawOrderId).trim() === "") return undefined;
  const orderId = Number(String(rawOrderId).trim());
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return undefined;

  return { shop, orderId };
}
