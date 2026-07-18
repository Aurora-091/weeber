import z from "zod";
import { tool } from "ai";
import { createDiscount } from "../../integrations/shopify/client";

/**
 * Shopify cart-recovery agent's tool — offers a discount code to close an
 * abandoned checkout. `checkoutTokenOrOrderRef` must be the same stable
 * value across retries of the same call (passed in via the call's captured
 * state / workflow metadata, not invented by the model) — the contract
 * requires a retry-safe code, not a fresh random one each attempt.
 *
 * `prepaidOnly` (2026-07-18, India COD-aware cart recovery): the discount
 * is framed to the caller as a prepaid-checkout incentive by default — COD
 * is still 40-60% of India ecommerce and carries real RTO/refusal risk a
 * merchant never sees at cart-recovery time, so nudging a recovered cart
 * toward paying online (not just toward completing the order at all) is a
 * second, cheaper win layered on top of the recovery itself. This is a
 * conversational nudge, not a technical payment-method restriction — Shopify
 * discount codes apply regardless of the gateway the customer ultimately
 * picks at checkout (a hard restriction would need a Shopify Function /
 * checkout UI extension, out of scope here) — so the tool only threads the
 * framing into the discount's title (visible to merchant staff in Shopify
 * admin) and tells the agent whether it's allowed to promise the discount
 * still applies if the customer insists on COD. Set `prepaidOnly: false`
 * for a merchant who wants the discount to apply regardless of payment
 * method (e.g. one running COD-first by design).
 */
export const offerCartRecoveryDiscount = tool({
  description:
    "Offer the caller a discount code to complete their abandoned checkout. Only call this once the caller " +
    "has expressed hesitation about price, not as an opening move.",
  inputSchema: z.object({
    shop: z.string().describe("The Shopify shop domain, e.g. x.myshopify.com"),
    checkoutTokenOrOrderRef: z.string().describe("Stable identifier for this checkout — used to build a retry-safe code"),
    percentOff: z.number().min(1).max(30).default(10),
    prepaidOnly: z
      .boolean()
      .default(true)
      .describe("Frame the discount as a prepaid-checkout incentive — mention it's for paying online now, not COD"),
  }),
  async execute({ shop, checkoutTokenOrOrderRef, percentOff, prepaidOnly = true }) {
    const code = `RECOVER${percentOff}-${checkoutTokenOrOrderRef}`.toUpperCase();
    const title = `Cart recovery ${percentOff}%${prepaidOnly ? " — prepaid only" : ""}`;
    try {
      const result = await createDiscount({
        shop,
        code,
        title,
        valueType: "percentage",
        value: percentOff,
        usageLimit: 1,
        appliesOncePerCustomer: true,
      });
      return { offered: true, code: result.data.code, status: result.data.status, prepaidOnly };
    } catch (err) {
      console.error("[shopify] failed to create recovery discount", err);
      return { offered: false, message: "Couldn't generate a discount code right now — don't promise one to the caller." };
    }
  },
});
