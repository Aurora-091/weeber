import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Covers both the existing confirmed=true tagging path (regression-proofing
 * it, not just the new behavior) and the new confirmed=false immediate-cancel
 * path (audit fix — see confirmCodOrder.ts's doc comment for why declines
 * used to wait for retry-exhaustion instead of cancelling right away).
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

import { confirmCodOrder } from "./confirmCodOrder";

describe("confirmCodOrder tool", () => {
  beforeEach(() => {
    annotateCalls = [];
    cancelCalls = [];
    annotateShouldThrow = false;
    cancelShouldThrow = false;
    cancelResultStatus = 202;
  });

  it("confirmed=true tags the order via annotateOrder and never calls cancelOrder", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await confirmCodOrder.execute({
      shop: "teststore.myshopify.com",
      orderId: 123,
      confirmed: true,
      notes: "customer confirmed",
    });
    expect(result).toEqual({ recorded: true, confirmed: true, tagged: true });
    expect(annotateCalls).toEqual([
      { shop: "teststore.myshopify.com", orderId: 123, tagsAdd: ["cod-confirmed"], note: "customer confirmed" },
    ]);
    expect(cancelCalls).toEqual([]);
  });

  it("confirmed=true still reports recorded when annotateOrder fails, but tagged: false — never silently drops the confirmation", async () => {
    annotateShouldThrow = true;
    // @ts-expect-error
    const result = await confirmCodOrder.execute({ shop: "x.myshopify.com", orderId: 5, confirmed: true });
    expect(result).toEqual({ recorded: true, confirmed: true, tagged: false });
  });

  it("confirmed=false (explicit decline) cancels the order immediately via cancelOrder, not just recording", async () => {
    // @ts-expect-error
    const result = await confirmCodOrder.execute({
      shop: "teststore.myshopify.com",
      orderId: 456,
      confirmed: false,
      notes: "customer said no, cancel it",
    });
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
    // @ts-expect-error
    await confirmCodOrder.execute({
      shop: "teststore.myshopify.com",
      orderId: 456,
      confirmed: false,
      notes: "customer said no, cancel it",
    });
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
    // @ts-expect-error
    const result = await confirmCodOrder.execute({ shop: "x.myshopify.com", orderId: 7, confirmed: false });
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
    // @ts-expect-error
    const result = await confirmCodOrder.execute({ shop: "x.myshopify.com", orderId: 9, confirmed: false });
    expect(result).toEqual({ recorded: true, confirmed: false, notes: null, canceled: false, tagged: true });
  });

  it("confirmed=false still reports canceled: true when annotateOrder (tagging) throws — tagging failure never blocks the cancel", async () => {
    annotateShouldThrow = true;
    // @ts-expect-error
    const result = await confirmCodOrder.execute({ shop: "x.myshopify.com", orderId: 10, confirmed: false });
    expect(result).toEqual({ recorded: true, confirmed: false, notes: null, canceled: true, tagged: false });
  });

  it("confirmed=false with a 200 (already_cancelled) response still reports canceled: true", async () => {
    cancelResultStatus = 200;
    // @ts-expect-error
    const result = await confirmCodOrder.execute({ shop: "x.myshopify.com", orderId: 11, confirmed: false });
    expect(result).toMatchObject({ canceled: true });
  });
});
