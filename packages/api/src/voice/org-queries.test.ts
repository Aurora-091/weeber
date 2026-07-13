import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * KPI math for computeOrgAnalytics (the "no fabricated metrics" rules):
 * null-not-zero on empty denominators, defensive recoveredAmount parsing,
 * confirmed-vs-attempted COD counting, delivery_rating averaging, and the
 * global-vs-org feature-flag overlay.
 */

let rowsByTable: Record<string, unknown[]> = {};

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  promise.orderBy = () => thenable(rows);
  return promise;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => thenable(rowsByTable[getTableName(table) ?? ""] ?? []),
    }),
  },
}));

import { computeOrgAnalytics, getEffectiveFlags, getShopifyStatus, buildInstallUrl } from "./org-queries";

const now = Date.now();
const call = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  orgId: "org-1",
  disposition: "completed-success",
  startedAt: new Date(now - 5 * 60_000),
  endedAt: new Date(now),
  capturedState: null,
  ...overrides,
});

describe("computeOrgAnalytics KPIs", () => {
  beforeEach(() => {
    rowsByTable = {
      orgs: [{ id: "org-1", currency: "INR", vertical: "shopify" }],
      calls: [],
      call_latency: [],
      tool_calls: [],
      scheduled_calls: [],
    };
  });

  it("returns null KPIs (not zeros) when there is no data", async () => {
    const analytics = await computeOrgAnalytics("org-1", 30);
    expect(analytics.totalCalls).toBe(0);
    expect(analytics.kpis).toEqual({ recovery: null, codConfirmation: null, feedback: null });
  });

  it("computes recovery revenue from real attribution rows, skipping junk amounts", async () => {
    rowsByTable.scheduled_calls = [
      { workflowName: "shopify-cart-recovery", status: "executed", recoveredOrderId: "o1", recoveredAmount: "150.50" },
      { workflowName: "shopify-cart-recovery", status: "executed", recoveredOrderId: "o2", recoveredAmount: "junk" },
      { workflowName: "shopify-cart-recovery", status: "executed", recoveredOrderId: null, recoveredAmount: null },
      { workflowName: "shopify-cart-recovery", status: "pending", recoveredOrderId: null, recoveredAmount: null },
    ];
    const { kpis } = await computeOrgAnalytics("org-1", 30);
    expect(kpis.recovery).toEqual({
      attemptedCalls: 3,
      recoveredOrders: 2,
      recoveredRevenue: 150.5,
      recoveryRate: 2 / 3,
    });
  });

  it("counts COD confirmations against executed attempts", async () => {
    rowsByTable.calls = [call({ id: 1 }), call({ id: 2 })];
    rowsByTable.scheduled_calls = [
      { workflowName: "shopify-cod-confirmation", status: "executed", recoveredOrderId: null, recoveredAmount: null },
      { workflowName: "shopify-cod-confirmation", status: "executed", recoveredOrderId: null, recoveredAmount: null },
    ];
    rowsByTable.tool_calls = [
      { callId: 1, toolName: "confirmCodOrder", input: { confirmed: true }, output: { recorded: true, confirmed: true } },
      { callId: 2, toolName: "confirmCodOrder", input: { confirmed: false }, output: { recorded: true, confirmed: false } },
    ];
    const { kpis } = await computeOrgAnalytics("org-1", 30);
    expect(kpis.codConfirmation).toEqual({ attemptedCalls: 2, confirmedOrders: 1, confirmRate: 0.5 });
  });

  it("averages 1-5 delivery_rating values and ignores invalid ones", async () => {
    rowsByTable.calls = [
      call({ id: 1, capturedState: { delivery_rating: "4" } }),
      call({ id: 2, capturedState: { delivery_rating: 5 } }),
      call({ id: 3, capturedState: { delivery_rating: "not a number" } }),
      call({ id: 4, capturedState: { delivery_rating: "9" } }), // out of range
      call({ id: 5 }),
    ];
    const { kpis } = await computeOrgAnalytics("org-1", 30);
    expect(kpis.feedback).toEqual({ responses: 2, averageRating: 4.5 });
  });

  it("carries the org currency for revenue display", async () => {
    const analytics = await computeOrgAnalytics("org-1", 30);
    expect(analytics.currency).toBe("INR");
  });
});

describe("getShopifyStatus", () => {
  it("splits the stored comma-separated scopes string into an array — regression for the Integrations page white-screen bug (frontend calls .map() on scopes, API was passing the raw DB string through)", async () => {
    rowsByTable = {
      shop_links: [
        {
          shop: "testung-7598.myshopify.com",
          connectedAt: new Date(),
          disconnectedAt: null,
          scopes: "read_checkouts,read_customers,write_discounts,write_orders",
        },
      ],
      org_agent_configs: [{ enabled: true }, { enabled: true }],
    };
    const status = await getShopifyStatus("org-1");
    expect(Array.isArray(status.shops[0].scopes)).toBe(true);
    expect(status.shops[0].scopes).toEqual(["read_checkouts", "read_customers", "write_discounts", "write_orders"]);
    expect(status.hasShop).toBe(true);
    expect(status.enabledAgentCount).toBe(2);
  });

  it("returns null scopes as null, not an empty array or a crash", async () => {
    rowsByTable = {
      shop_links: [{ shop: "x.myshopify.com", connectedAt: new Date(), disconnectedAt: null, scopes: null }],
      org_agent_configs: [],
    };
    const status = await getShopifyStatus("org-1");
    expect(status.shops[0].scopes).toBeNull();
  });
});

describe("buildInstallUrl", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.WEEBERSH_INSTALL_URL;
    delete process.env.PUBLIC_MERCHANT_APP_URL;
    delete process.env.PUBLIC_APP_URL;
  });

  it("returns null when WEEBERSH_INSTALL_URL is unconfigured", () => {
    expect(buildInstallUrl("org-1")).toBeNull();
  });

  it("regression: return_url must be the merchant app origin + /integrations, never the API's own origin or the stale /app/shopify path", () => {
    process.env.WEEBERSH_INSTALL_URL = "https://weebersh.up.railway.app/auth/login";
    process.env.PUBLIC_MERCHANT_APP_URL = "https://app.weeber.ai";
    // A real, live value this bug actually leaked in production -- included to make the
    // regression concrete, not just a synthetic string.
    process.env.PUBLIC_APP_URL = "https://api-production-c1bb.up.railway.app";

    const url = buildInstallUrl("org-1", "teststore");
    expect(url).toContain("org_id=org-1");
    expect(url).toContain("shop=teststore");
    expect(url).toContain(encodeURIComponent("https://app.weeber.ai/integrations?shopify_connected=1"));
    expect(url).not.toContain("api-production-c1bb.up.railway.app");
    expect(url).not.toContain(encodeURIComponent("/app/shopify"));
  });

  it("falls back to PUBLIC_APP_URL only when PUBLIC_MERCHANT_APP_URL is unset (last-resort, not the primary path)", () => {
    process.env.WEEBERSH_INSTALL_URL = "https://weebersh.up.railway.app/auth/login";
    process.env.PUBLIC_APP_URL = "https://api-production-c1bb.up.railway.app";

    const url = buildInstallUrl("org-1");
    expect(url).toContain(encodeURIComponent("https://api-production-c1bb.up.railway.app/integrations?shopify_connected=1"));
  });

  it("omits return_url entirely when neither URL env var is set, rather than building a broken one", () => {
    process.env.WEEBERSH_INSTALL_URL = "https://weebersh.up.railway.app/auth/login";
    const url = buildInstallUrl("org-1");
    expect(url).not.toContain("return_url");
  });
});

describe("getEffectiveFlags", () => {
  it("overlays org-scoped rows on global rows", async () => {
    rowsByTable = {
      feature_flags: [
        { key: "new-analytics", orgId: "", enabled: true },
        { key: "new-analytics", orgId: "org-1", enabled: false },
        { key: "beta-voices", orgId: "", enabled: true },
        { key: "org-only", orgId: "org-1", enabled: true },
      ],
    };
    const flags = await getEffectiveFlags("org-1");
    expect(flags).toEqual({ "new-analytics": false, "beta-voices": true, "org-only": true });
  });
});
