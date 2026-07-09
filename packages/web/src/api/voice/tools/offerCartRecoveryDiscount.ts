import z from "zod";
import { tool } from "ai";
import { createDiscount } from "../../integrations/shopify/client";

/**
 * Shopify cart-recovery agent's tool — offers a discount code to close an
 * abandoned checkout. `checkoutTokenOrOrderRef` must be the same stable
 * value across retries of the same call (passed in via the call's captured
 * state / workflow metadata, not invented by the model) — the contract
 * requires a retry-safe code, not a fresh random one each attempt.
 */
export const offerCartRecoveryDiscount = tool({
  description:
    "Offer the caller a discount code to complete their abandoned checkout. Only call this once the caller " +
    "has expressed hesitation about price, not as an opening move.",
  inputSchema: z.object({
    shop: z.string().describe("The Shopify shop domain, e.g. x.myshopify.com"),
    checkoutTokenOrOrderRef: z.string().describe("Stable identifier for this checkout — used to build a retry-safe code"),
    percentOff: z.number().min(1).max(30).default(10),
  }),
  async execute({ shop, checkoutTokenOrOrderRef, percentOff }) {
    const code = `RECOVER${percentOff}-${checkoutTokenOrOrderRef}`.toUpperCase();
    try {
      const result = await createDiscount({
        shop,
        code,
        title: `Cart recovery ${percentOff}%`,
        valueType: "percentage",
        value: percentOff,
        usageLimit: 1,
        appliesOncePerCustomer: true,
      });
      return { offered: true, code: result.data.code, status: result.data.status };
    } catch (err) {
      console.error("[shopify] failed to create recovery discount", err);
      return { offered: false, message: "Couldn't generate a discount code right now — don't promise one to the caller." };
    }
  },
});
