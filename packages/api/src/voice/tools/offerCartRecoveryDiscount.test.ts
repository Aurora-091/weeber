import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * G1.1 (2026-08-01) — the discount is the MERCHANT's number, never the
 * model's.
 *
 * This tool used to accept `percentOff` (and `shop`, and
 * `checkoutTokenOrOrderRef`) as model-filled input schema fields with a
 * silent `.default(10)`, which meant an LLM decided how much of a
 * merchant's margin to give away on a live call, and gave away 10% whenever
 * it didn't decide anything at all. It is now a factory whose commercial
 * inputs are bound server-side from the call's own workflow metadata, and
 * the model's only input is `reason` — the hesitation it heard.
 *
 * These tests pin the two properties that actually matter commercially:
 *   1. the percentage in the code, the title, and the Shopify payload is
 *      always the bound merchant value, whatever the model says;
 *   2. a call with no merchant-configured discount resolves to no context
 *      at all, which is what makes `buildVoiceTools` skip registering the
 *      tool (an unregistered tool cannot be called — the only airtight
 *      version of "not configured means not offered").
 * Plus the retry-safety property: the same call retried must produce the
 * same code, not a fresh one per attempt.
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

import {
  createOfferCartRecoveryDiscountTool,
  resolveCartRecoveryContext,
} from "./offerCartRecoveryDiscount";

const BASE = { shop: "teststore.myshopify.com", checkoutTokenOrOrderRef: "abc123", percentOff: 10 };

// The AI SDK's `tool()` return type doesn't surface `execute` publicly; every
// tool test in this directory reaches through it the same way.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, input: Record<string, unknown> = { reason: "said it was too expensive" }) =>
  tool.execute(input);

describe("createOfferCartRecoveryDiscountTool — bound merchant inputs", () => {
  beforeEach(() => {
    createDiscountCalls = [];
    shouldThrow = false;
  });

  it("defaults prepaidOnly to true and suffixes the title so merchant staff see the framing in Shopify admin", async () => {
    const result = await run(createOfferCartRecoveryDiscountTool(BASE));
    expect(result).toMatchObject({ offered: true, prepaidOnly: true, percentOff: 10 });
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
    const result = await run(
      createOfferCartRecoveryDiscountTool({
        shop: "teststore.myshopify.com",
        checkoutTokenOrOrderRef: "xyz789",
        percentOff: 15,
        prepaidOnly: false,
      }),
    );
    expect(result).toMatchObject({ offered: true, prepaidOnly: false, percentOff: 15 });
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

  it("uses the bound percentage even when the model tries to pass its own", async () => {
    // The regression that motivated G1.1: the model naming a number. There
    // is no longer a schema field for it, but a provider that sends extra
    // properties anyway must not be able to influence the amount.
    const result = await run(createOfferCartRecoveryDiscountTool({ ...BASE, percentOff: 5 }), {
      reason: "wants a bigger discount",
      percentOff: 30,
      shop: "attacker.myshopify.com",
      checkoutTokenOrOrderRef: "someone-elses-cart",
    });
    expect(result).toMatchObject({ offered: true, percentOff: 5 });
    expect(createDiscountCalls).toEqual([
      expect.objectContaining({ shop: "teststore.myshopify.com", value: 5, code: "RECOVER5-ABC123" }),
    ]);
  });

  it("returns the model's stated reason on the result so the merchant gets an audit trail", async () => {
    const result = await run(createOfferCartRecoveryDiscountTool(BASE), {
      reason: "said shipping pushed it over budget",
    });
    expect(result).toMatchObject({ reason: "said shipping pushed it over budget" });
  });

  it("is retry-safe — the same call re-run produces the same code, not a second one", async () => {
    const tool = createOfferCartRecoveryDiscountTool(BASE);
    const first = (await run(tool)) as { code: string };
    const second = (await run(tool)) as { code: string };
    expect(second.code).toBe(first.code);
  });

  it("exposes only `reason` to the model — no commercial field is model-writable", async () => {
    const tool = createOfferCartRecoveryDiscountTool(BASE) as unknown as {
      inputSchema: { shape: Record<string, unknown> };
    };
    expect(Object.keys(tool.inputSchema.shape)).toEqual(["reason"]);
  });

  it("names the exact percentage in the description so the model can't invent a different one to say", async () => {
    const tool = createOfferCartRecoveryDiscountTool({ ...BASE, percentOff: 12 }) as unknown as {
      description: string;
    };
    expect(tool.description).toContain("12%");
  });

  it("still reports offered: false with a caller-safe message when createDiscount throws", async () => {
    shouldThrow = true;
    const result = await run(
      createOfferCartRecoveryDiscountTool({ ...BASE, checkoutTokenOrOrderRef: "fail1" }),
    );
    expect(result).toEqual({
      offered: false,
      message: "Couldn't generate a discount code right now — don't promise one to the caller.",
    });
  });
});

describe("resolveCartRecoveryContext — the merchant's configuration is the gate", () => {
  it("resolves a full context from workflow metadata", () => {
    expect(
      resolveCartRecoveryContext({
        metadata: { shop_name: "acme.myshopify.com", discount_percent: 15 },
        checkoutToken: "tok_1",
      }),
    ).toEqual({
      shop: "acme.myshopify.com",
      checkoutTokenOrOrderRef: "tok_1",
      percentOff: 15,
      prepaidOnly: true,
    });
  });

  it("prefers an explicit `shop` key over `shop_name`", () => {
    const ctx = resolveCartRecoveryContext({
      metadata: { shop: "explicit.myshopify.com", shop_name: "legacy.myshopify.com", discount_percent: 10 },
      checkoutToken: "tok_1",
    });
    expect(ctx?.shop).toBe("explicit.myshopify.com");
  });

  it("accepts a stringified percentage — the graph engine stringifies most context values", () => {
    const ctx = resolveCartRecoveryContext({
      metadata: { shop: "acme.myshopify.com", discount_percent: "20" },
      checkoutToken: "tok_1",
    });
    expect(ctx?.percentOff).toBe(20);
  });

  it("falls back to checkout_token then order_id from metadata when no session token is set", () => {
    expect(
      resolveCartRecoveryContext({
        metadata: { shop: "acme.myshopify.com", discount_percent: 10, checkout_token: "meta_tok" },
      })?.checkoutTokenOrOrderRef,
    ).toBe("meta_tok");
    expect(
      resolveCartRecoveryContext({
        metadata: { shop: "acme.myshopify.com", discount_percent: 10, order_id: "1234" },
      })?.checkoutTokenOrOrderRef,
    ).toBe("1234");
  });

  it("reads prepaid-only off metadata, treating the falsey strings as false", () => {
    for (const raw of ["false", "0", "no", "off", "FALSE", " No "]) {
      const ctx = resolveCartRecoveryContext({
        metadata: { shop: "a.myshopify.com", discount_percent: 10, discount_prepaid_only: raw },
        checkoutToken: "t",
      });
      expect(ctx?.prepaidOnly, `raw=${JSON.stringify(raw)}`).toBe(false);
    }
    for (const raw of ["true", "1", "yes"]) {
      const ctx = resolveCartRecoveryContext({
        metadata: { shop: "a.myshopify.com", discount_percent: 10, discount_prepaid_only: raw },
        checkoutToken: "t",
      });
      expect(ctx?.prepaidOnly, `raw=${JSON.stringify(raw)}`).toBe(true);
    }
  });

  describe("returns undefined — meaning the tool is never registered for this call", () => {
    it("when no discount is configured at all", () => {
      expect(
        resolveCartRecoveryContext({ metadata: { shop: "a.myshopify.com" }, checkoutToken: "t" }),
      ).toBeUndefined();
    });

    it("when the configured discount is 0 (an escalating schedule's first attempt)", () => {
      expect(
        resolveCartRecoveryContext({
          metadata: { shop: "a.myshopify.com", discount_percent: 0 },
          checkoutToken: "t",
        }),
      ).toBeUndefined();
    });

    it("when the configured discount is negative or non-numeric", () => {
      for (const bad of [-5, "abc", ""]) {
        expect(
          resolveCartRecoveryContext({
            metadata: { shop: "a.myshopify.com", discount_percent: bad },
            checkoutToken: "t",
          }),
          `discount_percent=${JSON.stringify(bad)}`,
        ).toBeUndefined();
      }
    });

    it("when there is no shop — a discount can't be written without a tenant", () => {
      expect(
        resolveCartRecoveryContext({ metadata: { discount_percent: 10 }, checkoutToken: "t" }),
      ).toBeUndefined();
    });

    it("when there is no stable checkout ref — a per-attempt-random code breaks retry safety", () => {
      expect(
        resolveCartRecoveryContext({ metadata: { shop: "a.myshopify.com", discount_percent: 10 } }),
      ).toBeUndefined();
    });

    it("on an inbound call with no workflow metadata at all", () => {
      expect(resolveCartRecoveryContext({})).toBeUndefined();
      expect(resolveCartRecoveryContext({ metadata: null, checkoutToken: null })).toBeUndefined();
    });
  });
});
