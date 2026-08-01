import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Covers three things:
 *
 *  1. The confirmed=true tagging path (regression-proofing, unchanged).
 *  2. The confirmed=false immediate-cancel path (audit fix — see
 *     confirmCodOrder.ts's doc comment for why declines used to wait for
 *     retry-exhaustion instead of cancelling right away).
 *  3. G1.3: `shop`/`orderId` are bound server-side, not model-authored. The
 *     decline branch cancels and restocks a live order, and the model had no
 *     correct source for the order ID — it could only have guessed one. These
 *     tests assert the model cannot supply or override either value, and that
 *     `resolveCodOrderContext` refuses to produce a context it isn't sure of.
 */

let annotateCalls: unknown[] = [];
let cancelCalls: unknown[] = [];
let annotateShouldThrow = false;
let cancelShouldThrow = false;
let cancelResultStatus = 202;

mock.module("../../integrations/shopify/client", () => ({
  annotateOrder: async (input: unknown) => {
    annotateCalls.push(input);
    if (annotateShouldThrow) throw new Error("annotate failed");
    return { status: 200, data: { order_id: 1, tags_added: ["cod-confirmed"] } };
  },
  cancelOrder: async (input: unknown) => {
    cancelCalls.push(input);
    if (cancelShouldThrow) throw new Error("cancel failed");
    return { status: cancelResultStatus, data: { order_id: 1, status: "processing" } };
  },
}));

import { createConfirmCodOrderTool, resolveCodOrderContext } from "./confirmCodOrder";

describe("confirmCodOrder tool", () => {
  beforeEach(() => {
    annotateCalls = [];
    cancelCalls = [];
    annotateShouldThrow = false;
    cancelShouldThrow = false;
    cancelResultStatus = 202;
  });

  it("confirmed=true tags the order via annotateOrder and never calls cancelOrder", async () => {
    const tool = createConfirmCodOrderTool({ shop: "teststore.myshopify.com", orderId: 123 });
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await tool.execute({ confirmed: true, notes: "customer confirmed" });
    expect(result).toEqual({ recorded: true, confirmed: true, tagged: true });
    expect(annotateCalls).toEqual([
      { shop: "teststore.myshopify.com", orderId: 123, tagsAdd: ["cod-confirmed"], note: "customer confirmed" },
    ]);
    expect(cancelCalls).toEqual([]);
  });

  it("confirmed=true still reports recorded when annotateOrder fails, but tagged: false — never silently drops the confirmation", async () => {
    annotateShouldThrow = true;
    const tool = createConfirmCodOrderTool({ shop: "x.myshopify.com", orderId: 5 });
    // @ts-expect-error
    const result = await tool.execute({ confirmed: true });
    expect(result).toEqual({ recorded: true, confirmed: true, tagged: false });
  });

  it("confirmed=false (explicit decline) cancels the order immediately via cancelOrder, not just recording", async () => {
    const tool = createConfirmCodOrderTool({ shop: "teststore.myshopify.com", orderId: 456 });
    // @ts-expect-error
    const result = await tool.execute({ confirmed: false, notes: "customer said no, cancel it" });
    expect(result).toEqual({
      recorded: true,
      confirmed: false,
      notes: "customer said no, cancel it",
      canceled: true,
      tagged: true,
    });
    expect(cancelCalls).toEqual([
      {
        shop: "teststore.myshopify.com",
        orderId: 456,
        reason: "DECLINED",
        notifyCustomer: false,
        restock: true,
        staffNote: "customer said no, cancel it",
      },
    ]);
  });

  it("confirmed=false also tags the order cod-declined via annotateOrder (same visibility as the confirmed path)", async () => {
    const tool = createConfirmCodOrderTool({ shop: "teststore.myshopify.com", orderId: 456 });
    // @ts-expect-error
    await tool.execute({ confirmed: false, notes: "customer said no, cancel it" });
    expect(annotateCalls).toEqual([
      {
        shop: "teststore.myshopify.com",
        orderId: 456,
        tagsAdd: ["cod-declined"],
        note: "customer said no, cancel it",
      },
    ]);
  });

  it("confirmed=false with no notes still cancels and tags, using a sensible default staff note", async () => {
    const tool = createConfirmCodOrderTool({ shop: "x.myshopify.com", orderId: 7 });
    // @ts-expect-error
    const result = await tool.execute({ confirmed: false });
    expect(result).toMatchObject({ canceled: true, tagged: true });
    expect(cancelCalls).toEqual([
      {
        shop: "x.myshopify.com",
        orderId: 7,
        reason: "DECLINED",
        notifyCustomer: false,
        restock: true,
        staffNote: "Customer explicitly declined COD order during confirmation call",
      },
    ]);
    expect(annotateCalls).toEqual([
      {
        shop: "x.myshopify.com",
        orderId: 7,
        tagsAdd: ["cod-declined"],
        note: "Customer explicitly declined COD order during confirmation call",
      },
    ]);
  });

  it("confirmed=false still reports recorded when cancelOrder throws, but canceled: false — visible failure, not a silent no-op (tagging still attempted independently)", async () => {
    cancelShouldThrow = true;
    const tool = createConfirmCodOrderTool({ shop: "x.myshopify.com", orderId: 9 });
    // @ts-expect-error
    const result = await tool.execute({ confirmed: false });
    expect(result).toEqual({ recorded: true, confirmed: false, notes: null, canceled: false, tagged: true });
  });

  it("confirmed=false still reports canceled: true when annotateOrder (tagging) throws — tagging failure never blocks the cancel", async () => {
    annotateShouldThrow = true;
    const tool = createConfirmCodOrderTool({ shop: "x.myshopify.com", orderId: 10 });
    // @ts-expect-error
    const result = await tool.execute({ confirmed: false });
    expect(result).toEqual({ recorded: true, confirmed: false, notes: null, canceled: true, tagged: false });
  });

  it("confirmed=false with a 200 (already_cancelled) response still reports canceled: true", async () => {
    cancelResultStatus = 200;
    const tool = createConfirmCodOrderTool({ shop: "x.myshopify.com", orderId: 11 });
    // @ts-expect-error
    const result = await tool.execute({ confirmed: false });
    expect(result).toMatchObject({ canceled: true });
  });
});

describe("confirmCodOrder — the model cannot choose the order (G1.3)", () => {
  beforeEach(() => {
    annotateCalls = [];
    cancelCalls = [];
    annotateShouldThrow = false;
    cancelShouldThrow = false;
    cancelResultStatus = 202;
  });

  it("the model-facing input schema is exactly { confirmed, notes } — shop and orderId are not model inputs", () => {
    const tool = createConfirmCodOrderTool({ shop: "bound.myshopify.com", orderId: 999 });
    const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    // The strongest possible assertion: not "shop is validated" but "shop is
    // not a field the model can even emit". A hallucinated order ID has
    // nowhere to go.
    expect(Object.keys(shape).sort()).toEqual(["confirmed", "notes"]);
  });

  it("ignores shop/orderId if a model emits them anyway — the bound values win", async () => {
    const tool = createConfirmCodOrderTool({ shop: "bound.myshopify.com", orderId: 111 });
    // @ts-expect-error — deliberately passing the fields the old schema accepted
    const result = await tool.execute({
      confirmed: false,
      notes: "no thanks",
      shop: "attacker.myshopify.com",
      orderId: 222,
    });
    expect(result).toMatchObject({ canceled: true });
    // A cross-tenant write is the failure this prevents: every outbound call
    // must carry the bound shop, never the one in the model's arguments.
    for (const call of [...cancelCalls, ...annotateCalls]) {
      expect(call).toMatchObject({ shop: "bound.myshopify.com", orderId: 111 });
    }
  });

  it("the description tells the agent it does not identify the order, and that a decline is irreversible", () => {
    const tool = createConfirmCodOrderTool({ shop: "x.myshopify.com", orderId: 1 });
    expect(tool.description).toContain("You do not identify the order");
    expect(tool.description).toContain("cannot be undone");
  });

  it("two calls in the same process stay independent — no shared mutable order state", async () => {
    const a = createConfirmCodOrderTool({ shop: "a.myshopify.com", orderId: 1 });
    const b = createConfirmCodOrderTool({ shop: "b.myshopify.com", orderId: 2 });
    // @ts-expect-error
    await a.execute({ confirmed: true });
    // @ts-expect-error
    await b.execute({ confirmed: true });
    expect(annotateCalls).toMatchObject([
      { shop: "a.myshopify.com", orderId: 1 },
      { shop: "b.myshopify.com", orderId: 2 },
    ]);
  });
});

describe("resolveCodOrderContext — refuses anything it isn't sure of (G1.3)", () => {
  it("resolves shop + orderId from the COD producer's camelCase metadata", () => {
    expect(resolveCodOrderContext({ metadata: { shop: "s.myshopify.com", orderId: 42 } })).toEqual({
      shop: "s.myshopify.com",
      orderId: 42,
    });
  });

  it("accepts snake_case order_id too", () => {
    expect(resolveCodOrderContext({ metadata: { shop: "s.myshopify.com", order_id: 42 } })).toEqual({
      shop: "s.myshopify.com",
      orderId: 42,
    });
  });

  it("prefers orderId when both are present — it is what workflows/engine.ts reads for the post-call annotate", () => {
    expect(resolveCodOrderContext({ metadata: { shop: "s.myshopify.com", orderId: 1, order_id: 2 } })).toEqual({
      shop: "s.myshopify.com",
      orderId: 1,
    });
  });

  it("coerces a stringified order id — workflow context values round-trip through JSON as strings", () => {
    expect(resolveCodOrderContext({ metadata: { shop: "s.myshopify.com", orderId: "42" } })).toEqual({
      shop: "s.myshopify.com",
      orderId: 42,
    });
  });

  it("falls back to shop_name when shop is absent", () => {
    expect(resolveCodOrderContext({ metadata: { shop_name: "s.myshopify.com", orderId: 42 } })).toEqual({
      shop: "s.myshopify.com",
      orderId: 42,
    });
  });

  it("returns undefined with no metadata at all (inbound call, or one no workflow placed)", () => {
    expect(resolveCodOrderContext({ metadata: undefined })).toBeUndefined();
    expect(resolveCodOrderContext({ metadata: null })).toBeUndefined();
    expect(resolveCodOrderContext({ metadata: {} })).toBeUndefined();
  });

  it("returns undefined without a shop", () => {
    expect(resolveCodOrderContext({ metadata: { orderId: 42 } })).toBeUndefined();
    expect(resolveCodOrderContext({ metadata: { shop: "   ", orderId: 42 } })).toBeUndefined();
  });

  it("returns undefined without an order reference — a cart-recovery call must not carry a cancel tool", () => {
    expect(resolveCodOrderContext({ metadata: { shop: "s.myshopify.com", checkout_token: "tok" } })).toBeUndefined();
    expect(resolveCodOrderContext({ metadata: { shop: "s.myshopify.com", orderId: "" } })).toBeUndefined();
  });

  it("returns undefined for an order reference that isn't a clean positive integer", () => {
    // Not a validation nicety: an unparseable ref means we don't know which
    // order this is, and the tool's decline branch destroys whichever one it
    // is handed. Refusing to build the context removes the tool from the call.
    for (const bad of ["abc", "12abc", "0", "-5", "1.5", "NaN", "Infinity"]) {
      expect(resolveCodOrderContext({ metadata: { shop: "s.myshopify.com", orderId: bad } })).toBeUndefined();
    }
  });
});
