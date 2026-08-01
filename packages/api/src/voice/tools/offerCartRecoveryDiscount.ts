import z from "zod";
import { tool } from "ai";
import { createDiscount } from "../../integrations/shopify/client";

/**
 * Shopify cart-recovery agent's tool — offers a discount code to close an
 * abandoned checkout.
 *
 * Factory, not a static `tool()` export (2026-08-01, G1.1) — the same
 * pattern as `createLookupInfoTool`, and for a stronger reason. Every
 * commercially meaningful input here is now bound from server-side call
 * context at session construction instead of being filled in by the model:
 *
 *   - `percentOff` — this is the merchant's money. It was previously a
 *     model-filled field (`z.number().min(1).max(30).default(10)`), which
 *     meant the LLM decided how much margin to give away on a live call,
 *     and quietly defaulted to 10% whenever it didn't specify. The merchant
 *     already configures this properly (flat or escalating-per-attempt) in
 *     the workflow canvas — `NodeConfigPanel` -> `resolveDiscountPercent`
 *     -> `clampDiscount` -> `scheduledCalls.metadata.discount_percent` —
 *     and that resolved number is what gets bound here. The model owns the
 *     *timing* of the offer (has the caller actually hesitated on price?),
 *     never the amount.
 *   - `shop` / `checkoutTokenOrOrderRef` — a model-invented checkout ref
 *     silently breaks the retry-safety contract (the same call retried must
 *     produce the same code, not a fresh one each attempt), and a
 *     model-supplied `shop` is a cross-tenant write surface. Both come from
 *     the call's own workflow metadata.
 *   - `prepaidOnly` — merchant policy, not a per-turn judgement call.
 *
 * What's left in the input schema is deliberately one field the model *is*
 * the right author of: `reason`, the hesitation it heard. That keeps the
 * schema non-empty (some strict-tool-calling providers are unhappy with a
 * zero-property object) and gives the merchant an audit trail on the call
 * detail timeline explaining why a discount fired at all.
 *
 * When a call has no discount configured (`discount_percent` absent or 0),
 * `buildVoiceTools` does not register this tool for that call at all —
 * rather than registering it at 0% or falling back to an org default. A
 * tool that isn't in the request can't be called, which is the only
 * airtight way to guarantee "no discount configured means no discount
 * offered"; it also matches the persona doc, which already instructs the
 * agent to skip the discount step entirely when none is configured.
 *
 * `prepaidOnly` (2026-07-18, India COD-aware cart recovery): the discount
 * is framed to the caller as a prepaid-checkout incentive by default — COD
 * is still 40-60% of India ecommerce and carries real RTO/refusal risk a
 * merchant never sees at cart-recovery time, so nudging a recovered cart
 * toward paying online (not just toward completing the order at all) is a
 * second, cheaper win layered on top of the recovery itself. This is a
 * conversational nudge, not a technical payment-method restriction —
 * Shopify discount codes apply regardless of the gateway the customer
 * ultimately picks at checkout (a hard restriction would need a Shopify
 * Function / checkout UI extension, out of scope here) — so it only threads
 * the framing into the discount's title (visible to merchant staff in
 * Shopify admin) and into the tool result, which tells the agent whether
 * it's allowed to promise the discount still applies if the customer
 * insists on COD. Set `prepaidOnly: false` for a merchant who wants the
 * discount to apply regardless of payment method (e.g. one running
 * COD-first by design).
 */
export type CartRecoveryDiscountContext = {
  /** Shopify shop domain, e.g. `acme.myshopify.com`. From the call's workflow metadata. */
  shop: string;
  /** Stable checkout token for this cart — the same value across every retry of this call. */
  checkoutTokenOrOrderRef: string;
  /**
   * The merchant's configured discount for this attempt, already resolved and
   * clamped by `workflows/variables.ts`. Must be > 0 — a 0 or negative value
   * means "no discount configured", and the caller is expected to not build
   * this tool at all in that case (see `resolveCartRecoveryContext`).
   */
  percentOff: number;
  /** Merchant policy — frame the discount as a prepaid-checkout incentive. Defaults to true. */
  prepaidOnly?: boolean;
};

export function createOfferCartRecoveryDiscountTool(ctx: CartRecoveryDiscountContext) {
  const prepaidOnly = ctx.prepaidOnly ?? true;
  const percentOff = ctx.percentOff;

  return tool({
    description:
      `Offer the caller this merchant's pre-approved ${percentOff}% discount code to complete their ` +
      "abandoned checkout. The amount, the checkout it applies to, and whether it's framed as a " +
      "prepaid-checkout incentive are all fixed by the merchant — you are only deciding *when* to " +
      "offer it. Only call this once the caller has expressed hesitation about price, not as an " +
      "opening move, and only once per call. Never state a different percentage than the one this " +
      "tool returns.",
    inputSchema: z.object({
      reason: z
        .string()
        .describe(
          "The price hesitation you actually heard, in the caller's own words where possible — e.g. " +
            "\"said it's more than they wanted to spend\". Recorded for the merchant; it does not " +
            "change the discount.",
        ),
    }),
    async execute({ reason }) {
      const code = `RECOVER${percentOff}-${ctx.checkoutTokenOrOrderRef}`.toUpperCase();
      const title = `Cart recovery ${percentOff}%${prepaidOnly ? " — prepaid only" : ""}`;
      try {
        const result = await createDiscount({
          shop: ctx.shop,
          code,
          title,
          valueType: "percentage",
          value: percentOff,
          usageLimit: 1,
          appliesOncePerCustomer: true,
        });
        return { offered: true, code: result.data.code, percentOff, status: result.data.status, prepaidOnly, reason };
      } catch (err) {
        console.error("[shopify] failed to create recovery discount", err);
        return {
          offered: false,
          message: "Couldn't generate a discount code right now — don't promise one to the caller.",
        };
      }
    },
  });
}

/**
 * Builds the bound context for a call from its `scheduledCalls.metadata`
 * (threaded onto the session as `workflowMetadata` by scheduler.ts, plus
 * `checkoutToken` as its own session field).
 *
 * Returns `undefined` — meaning "do not give this call the discount tool at
 * all" — whenever the merchant hasn't authorized a discount for this
 * attempt, or when the metadata needed to build a retry-safe code isn't
 * there. Both are deliberately silent-safe: the agent simply has one fewer
 * ability, which the cart-recovery persona already handles ("if not
 * configured, skip Step 2 entirely, do not invent a coupon").
 *
 * `shop_name` is the metadata key that actually carries the shop *domain*
 * (see integrations/shopify/routes.ts, where the run context is seeded with
 * `shop_name: shop`) — `shop` is checked first anyway so a future rename
 * doesn't silently disable discounts.
 */
export function resolveCartRecoveryContext(input: {
  metadata?: Record<string, string | number> | null;
  checkoutToken?: string | null;
}): CartRecoveryDiscountContext | undefined {
  const metadata = input.metadata ?? {};
  const shop = String(metadata.shop ?? metadata.shop_name ?? "").trim();
  const ref = String(input.checkoutToken ?? metadata.checkout_token ?? metadata.order_id ?? "").trim();
  const percentOff = Number(metadata.discount_percent ?? 0);

  if (!shop || !ref) return undefined;
  if (!Number.isFinite(percentOff) || percentOff <= 0) return undefined;

  // Metadata values arrive as string|number (JSON column, and the graph
  // engine stringifies most context), so compare on the normalized string
  // rather than on a boolean that will never actually be one.
  const prepaidRaw = metadata.discount_prepaid_only;
  const prepaidOnly =
    prepaidRaw === undefined || prepaidRaw === null
      ? true
      : !["false", "0", "no", "off"].includes(String(prepaidRaw).trim().toLowerCase());

  return { shop, checkoutTokenOrOrderRef: ref, percentOff, prepaidOnly };
}
