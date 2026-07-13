import { describe, it, expect, mock, beforeEach } from "bun:test";

let rowsByTable: Record<string, unknown[]> = {};

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  return promise;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: () => thenable(rowsByTable.org_agent_configs ?? []),
    }),
  },
}));

import { getRetryDefaults, resolveRetryConfig, isShopifyWorkflow } from "./retry-config";

describe("getRetryDefaults", () => {
  it("returns the known Shopify template defaults matching the old env-var defaults", () => {
    expect(getRetryDefaults("shopify-cart-recovery")).toEqual({
      firstCallDelayMinutes: 45,
      retryDelayMinutes: 60,
      maxAttempts: 2,
    });
    expect(getRetryDefaults("shopify-cod-confirmation")).toEqual({
      firstCallDelayMinutes: 30,
      retryDelayMinutes: 30,
      maxAttempts: 3,
    });
    expect(getRetryDefaults("shopify-feedback")).toEqual({
      firstCallDelayMinutes: 3 * 24 * 60,
      retryDelayMinutes: 0,
      maxAttempts: 1,
    });
  });

  it("falls back to a generic default for an unrecognized template key", () => {
    expect(getRetryDefaults("some-future-vertical-template")).toEqual({
      firstCallDelayMinutes: 30,
      retryDelayMinutes: 30,
      maxAttempts: 3,
    });
  });
});

describe("isShopifyWorkflow", () => {
  it("matches any shopify-prefixed workflow name", () => {
    expect(isShopifyWorkflow("shopify-cart-recovery")).toBe(true);
    expect(isShopifyWorkflow("shopify-cod-confirmation")).toBe(true);
    expect(isShopifyWorkflow("shopify-feedback")).toBe(true);
  });

  it("does not match a non-Shopify or missing workflow name", () => {
    expect(isShopifyWorkflow("lead-followup")).toBe(false);
    expect(isShopifyWorkflow(undefined)).toBe(false);
    expect(isShopifyWorkflow(null)).toBe(false);
    expect(isShopifyWorkflow("")).toBe(false);
  });
});

describe("resolveRetryConfig", () => {
  beforeEach(() => {
    rowsByTable = {};
  });

  it("returns platform defaults when orgId is missing", async () => {
    const config = await resolveRetryConfig(undefined, "shopify-cod-confirmation");
    expect(config).toEqual({ firstCallDelayMinutes: 30, retryDelayMinutes: 30, maxAttempts: 3 });
  });

  it("returns platform defaults when the org has no override row", async () => {
    rowsByTable.org_agent_configs = [];
    const config = await resolveRetryConfig("org-1", "shopify-cod-confirmation");
    expect(config).toEqual({ firstCallDelayMinutes: 30, retryDelayMinutes: 30, maxAttempts: 3 });
  });

  it("uses the org's override fields where set, falling back to defaults per-field otherwise", async () => {
    rowsByTable.org_agent_configs = [{ firstCallDelayMinutes: 10, retryDelayMinutes: null, maxAttempts: 5 }];
    const config = await resolveRetryConfig("org-1", "shopify-cod-confirmation");
    expect(config).toEqual({
      firstCallDelayMinutes: 10, // overridden
      retryDelayMinutes: 30, // falls back — org left this null
      maxAttempts: 5, // overridden
    });
  });

  it("uses full org overrides when all three fields are set", async () => {
    rowsByTable.org_agent_configs = [{ firstCallDelayMinutes: 5, retryDelayMinutes: 15, maxAttempts: 10 }];
    const config = await resolveRetryConfig("org-1", "shopify-cart-recovery");
    expect(config).toEqual({ firstCallDelayMinutes: 5, retryDelayMinutes: 15, maxAttempts: 10 });
  });
});
