import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Covers the base discount-creation path plus the new prepaidOnly framing
 * (2026-07-18, India COD-aware cart recovery) — the discount title should
 * carry the "prepaid only" suffix by default, be omittable for a merchant
 * who wants the discount to apply regardless of payment method, and the
 * flag should round-trip back in the tool's result so the model can tell
 * the caller accurately.
 */

let createDiscountCalls: unknown[] = [];
let shouldThrow = false;

mock.module("../../integrations/shopify/client", () => ({
  createDiscount: async (input: unknown) => {
    createDiscountCalls.push(input);
    if (shouldThrow) throw new Error("discount create failed");
    return { status: 200, data: { code: (input as { code: string }).code, status: "created" } };
  },
}));

import { offerCartRecoveryDiscount } from "./offerCartRecoveryDiscount";

describe("offerCartRecoveryDiscount tool", () => {
  beforeEach(() => {
    createDiscountCalls = [];
    shouldThrow = false;
  });

  it("defaults prepaidOnly to true and suffixes the discount title so merchant staff see the framing in Shopify admin", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await offerCartRecoveryDiscount.execute({
      shop: "teststore.myshopify.com",
      checkoutTokenOrOrderRef: "abc123",
      percentOff: 10,
    });
    expect(result).toMatchObject({ offered: true, prepaidOnly: true });
    expect(createDiscountCalls).toEqual([
      {
        shop: "teststore.myshopify.com",
        code: "RECOVER10-ABC123",
        title: "Cart recovery 10% — prepaid only",
        valueType: "percentage",
        value: 10,
        usageLimit: 1,
        appliesOncePerCustomer: true,
      },
    ]);
  });

  it("prepaidOnly: false omits the suffix and round-trips false in the result", async () => {
    // @ts-expect-error
    const result = await offerCartRecoveryDiscount.execute({
      shop: "teststore.myshopify.com",
      checkoutTokenOrOrderRef: "xyz789",
      percentOff: 15,
      prepaidOnly: false,
    });
    expect(result).toMatchObject({ offered: true, prepaidOnly: false });
    expect(createDiscountCalls).toEqual([
      {
        shop: "teststore.myshopify.com",
        code: "RECOVER15-XYZ789",
        title: "Cart recovery 15%",
        valueType: "percentage",
        value: 15,
        usageLimit: 1,
        appliesOncePerCustomer: true,
      },
    ]);
  });

  it("still reports offered: false with a caller-safe message when createDiscount throws", async () => {
    shouldThrow = true;
    // @ts-expect-error
    const result = await offerCartRecoveryDiscount.execute({
      shop: "x.myshopify.com",
      checkoutTokenOrOrderRef: "fail1",
      percentOff: 10,
    });
    expect(result).toEqual({
      offered: false,
      message: "Couldn't generate a discount code right now — don't promise one to the caller.",
    });
  });
});
