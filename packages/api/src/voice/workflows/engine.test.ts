import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Covers the new org-scoped Shopify retry path (issue 3 feature) —
 * confirms it actually fires instead of silently no-op'ing the way the
 * generic WORKFLOWS-env-var path always has in production (WORKFLOWS is
 * confirmed unset there), and that it correctly cancels an exhausted COD
 * order in-process rather than depending on the never-actually-invoked
 * /internal/cod-confirmation-exhausted HTTP route.
 */

let insertedRows: unknown[] = [];
let retryConfigByKey: Record<string, { firstCallDelayMinutes: number; retryDelayMinutes: number; maxAttempts: number }> = {};
let cancelOrderCalls: unknown[] = [];
let cancelOrderShouldThrow = false;

mock.module("../../database", () => ({
  db: {
    insert: () => ({
      values: (row: unknown) => {
        insertedRows.push(row);
        return Promise.resolve();
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  },
}));

mock.module("../retry-config", () => ({
  resolveRetryConfig: async (_orgId: string | undefined, templateKey: string) =>
    retryConfigByKey[templateKey] ?? { firstCallDelayMinutes: 30, retryDelayMinutes: 30, maxAttempts: 3 },
  isShopifyWorkflow: (name: string | undefined | null) => Boolean(name && name.startsWith("shopify-")),
}));

mock.module("../../integrations/shopify/client", () => ({
  cancelOrder: async (input: unknown) => {
    cancelOrderCalls.push(input);
    if (cancelOrderShouldThrow) throw new Error("cancel failed");
    return { status: 202, data: { order_id: 1, status: "processing" } };
  },
}));

import { runWorkflowForOutcome } from "./engine";

describe("runWorkflowForOutcome — Shopify org-scoped retry path", () => {
  beforeEach(() => {
    insertedRows = [];
    cancelOrderCalls = [];
    cancelOrderShouldThrow = false;
    retryConfigByKey = {};
  });

  it("schedules a retry for a no-answer outcome on a Shopify workflow, using the org's resolved retry config", async () => {
    retryConfigByKey["shopify-cod-confirmation"] = { firstCallDelayMinutes: 30, retryDelayMinutes: 45, maxAttempts: 3 };
    await runWorkflowForOutcome({
      toNumber: "+15551234567",
      outcome: "no-answer",
      persona: "shopify-cod-confirmation",
      previousAttempt: 1,
      orgId: "org-1",
      metadata: { shop: "x.myshopify.com", orderId: 42 },
    });
    expect(insertedRows).toEqual([
      {
        toNumber: "+15551234567",
        workflowName: "shopify-cod-confirmation",
        persona: "shopify-cod-confirmation",
        webhookUrl: undefined,
        attempt: 2,
        maxAttempts: 3,
        runAt: expect.any(Date),
        status: "pending",
        orgId: "org-1",
        checkoutToken: undefined,
        metadata: { shop: "x.myshopify.com", orderId: 42 },
      },
    ]);
    expect(cancelOrderCalls).toEqual([]);
  });

  it("cancels the order in-process when a COD confirmation's retries are exhausted", async () => {
    retryConfigByKey["shopify-cod-confirmation"] = { firstCallDelayMinutes: 30, retryDelayMinutes: 30, maxAttempts: 3 };
    await runWorkflowForOutcome({
      toNumber: "+15551234567",
      outcome: "no-answer",
      persona: "shopify-cod-confirmation",
      previousAttempt: 3, // nextAttempt = 4 > maxAttempts 3 -> exhausted
      orgId: "org-1",
      metadata: { shop: "x.myshopify.com", orderId: 42 },
    });
    expect(insertedRows).toEqual([]); // no further retry scheduled
    expect(cancelOrderCalls).toEqual([
      {
        shop: "x.myshopify.com",
        orderId: 42,
        reason: "CUSTOMER",
        notifyCustomer: false,
        restock: true,
        staffNote: "No COD confirmation after max call attempts",
      },
    ]);
  });

  it("does not attempt to cancel anything when cart-recovery retries are exhausted (only COD confirmation has an exhaustion action)", async () => {
    retryConfigByKey["shopify-cart-recovery"] = { firstCallDelayMinutes: 45, retryDelayMinutes: 60, maxAttempts: 2 };
    await runWorkflowForOutcome({
      toNumber: "+15551234567",
      outcome: "busy",
      persona: "shopify-cart-recovery",
      previousAttempt: 2,
      orgId: "org-1",
      metadata: { shop: "x.myshopify.com", checkoutToken: "abc" },
    });
    expect(insertedRows).toEqual([]);
    expect(cancelOrderCalls).toEqual([]);
  });

  it("does not throw and still reports nothing scheduled when cancelOrder fails on exhaustion", async () => {
    cancelOrderShouldThrow = true;
    retryConfigByKey["shopify-cod-confirmation"] = { firstCallDelayMinutes: 30, retryDelayMinutes: 30, maxAttempts: 1 };
    await expect(
      runWorkflowForOutcome({
        toNumber: "+15551234567",
        outcome: "failed",
        persona: "shopify-cod-confirmation",
        previousAttempt: 1,
        orgId: "org-1",
        metadata: { shop: "x.myshopify.com", orderId: 7 },
      }),
    ).resolves.toBeUndefined();
    expect(cancelOrderCalls.length).toBe(1);
  });

  it("does NOT intercept a non-retryable outcome for a Shopify workflow — falls through to the generic (unconfigured) path with no error and no insert", async () => {
    await runWorkflowForOutcome({
      toNumber: "+15551234567",
      outcome: "not-interested",
      persona: "shopify-cod-confirmation",
      orgId: "org-1",
    });
    expect(insertedRows).toEqual([]);
  });

  it("does NOT intercept a Shopify-workflow call with no orgId — falls through to the generic path", async () => {
    await runWorkflowForOutcome({
      toNumber: "+15551234567",
      outcome: "no-answer",
      persona: "shopify-cod-confirmation",
    });
    expect(insertedRows).toEqual([]);
  });
});
