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

let lastInsertValues: Record<string, unknown> | undefined;

/**
 * isAgentDispatchable reads agent_templates TWICE with different predicates
 * (does this key exist at all, then is it visible for the org's vertical), and
 * this fake db keys rows by table name only. When set, this queue answers those
 * two reads in order so a test can say "the template exists but is not visible
 * to this vertical" — the leftover-row case.
 */
let agentTemplateResponses: unknown[][] | undefined;

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table) ?? "";
        if (name === "agent_templates" && agentTemplateResponses?.length) {
          return thenable(agentTemplateResponses.shift() ?? []);
        }
        return thenable(rowsByTable[name] ?? []);
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        lastInsertValues = v;
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([v]) }),
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([v]) }),
          returning: () => Promise.resolve([v]),
        };
      },
    }),
  },
}));

import {
  computeOrgAnalytics,
  getEffectiveFlags,
  getShopifyStatus,
  buildInstallUrl,
  upsertAgentConfig,
  isAgentDispatchable,
} from "./org-queries";

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
      turn_latency: [],
      tool_calls: [],
      scheduled_calls: [],
      shop_links: [],
      shopify_webhook_events: [],
    };
  });

  it("returns null KPIs (not zeros) when there is no data", async () => {
    const analytics = await computeOrgAnalytics("org-1", 30);
    expect(analytics.totalCalls).toBe(0);
    expect(analytics.kpis).toEqual({
      recovery: null,
      codConfirmation: null,
      feedback: null,
      insuranceRenewal: null,
      insuranceLeadFollowup: null,
    });
  });

  it("computes insurance KPIs from agentPersona-matched calls (2026-07-18 fix -- was mislabeled Shopify data)", async () => {
    rowsByTable.scheduled_calls = [
      { workflowName: "insurance-policy-renewal", status: "executed" },
      { workflowName: "insurance-policy-renewal", status: "executed" },
      { workflowName: "insurance-lead-followup", status: "executed" },
      { workflowName: "insurance-lead-followup", status: "executed" },
    ];
    rowsByTable.calls = [
      call({ id: 1, agentPersona: "insurance-policy-renewal", disposition: "booked" }),
      call({ id: 2, agentPersona: "insurance-policy-renewal", disposition: "not-interested" }),
      call({ id: 3, agentPersona: "insurance-lead-followup", disposition: null }),
      call({ id: 4, agentPersona: "insurance-lead-followup", disposition: "not-interested" }),
    ];
    rowsByTable.tool_calls = [{ id: 1, callId: 3, toolName: "bookAppointment", input: {}, output: {} }];

    const analytics = await computeOrgAnalytics("org-1", 30);
    expect(analytics.kpis.insuranceRenewal).toEqual({ attemptedCalls: 2, confirmedCount: 1, confirmRate: 0.5 });
    expect(analytics.kpis.insuranceLeadFollowup).toEqual({ attemptedCalls: 2, qualifiedCount: 1, qualifyRate: 0.5 });
    // The bug this replaces: cart-recovery/COD-confirmation blocks must stay null, not leak
    // Shopify-shaped data into an insurance org's response just because these rows exist.
    expect(analytics.kpis.recovery).toBeNull();
    expect(analytics.kpis.codConfirmation).toBeNull();
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
      cartsAbandoned: 0,
      attemptedCalls: 3,
      recoveredOrders: 2,
      recoveredRevenue: 150.5,
      recoveryRate: 2 / 3,
      avgOrderValue: 75.25,
    });
  });

  // Regression coverage for the 2026-07-16 "Carts abandoned" metric: the
  // true raw count reuses the existing shopify_webhook_events idempotency
  // log (topic="checkouts"), scoped to the org via shop_links — NOT just
  // scheduledCalls rows, which only exist for checkouts that were actually
  // schedulable (undercounts real abandonment).
  it("counts cartsAbandoned from shopify_webhook_events via shop_links, independent of scheduledCalls", async () => {
    rowsByTable.shop_links = [{ shop: "my-store.myshopify.com" }];
    rowsByTable.shopify_webhook_events = [
      { id: 1, shop: "my-store.myshopify.com", topic: "checkouts", processedAt: new Date(now) },
      { id: 2, shop: "my-store.myshopify.com", topic: "checkouts", processedAt: new Date(now) },
      { id: 3, shop: "my-store.myshopify.com", topic: "checkouts", processedAt: new Date(now) },
      // Different topic on the same shop — must not be counted as abandoned carts.
      { id: 4, shop: "my-store.myshopify.com", topic: "orders", processedAt: new Date(now) },
      // Outside the 30-day analytics window — must not be counted either.
      { id: 5, shop: "my-store.myshopify.com", topic: "checkouts", processedAt: new Date(now - 60 * 24 * 60 * 60 * 1000) },
    ];
    // No scheduledCalls rows at all — e.g. every one of these checkouts had
    // no callable phone, so scheduledCalls alone would report 0 abandonment.
    const { kpis } = await computeOrgAnalytics("org-1", 30);
    expect(kpis.recovery).toEqual({
      cartsAbandoned: 3,
      attemptedCalls: 0,
      recoveredOrders: 0,
      recoveredRevenue: 0,
      recoveryRate: null,
      avgOrderValue: null,
    });
  });

  it("reports cartsAbandoned as 0 (not an error) for an org with no linked shop yet", async () => {
    rowsByTable.shop_links = [];
    rowsByTable.shopify_webhook_events = [{ id: 1, shop: "someone-elses-store.myshopify.com", topic: "checkouts" }];
    const analytics = await computeOrgAnalytics("org-1", 30);
    expect(analytics.kpis.recovery).toBeNull();
  });

  // Regression coverage for the 2026-07-16 merchant-reported bug: placing a
  // real order got counted as an abandoned cart. Root cause — Shopify fires
  // a "checkouts" webhook for EVERY checkout, including ones that go on to
  // complete as a real order; cartsAbandoned had no way to exclude those.
  // Fix: shopify/routes.ts's /orders/create handler now marks the checkout
  // "converted" (topic "checkout_converted", keyed by checkout_token) on
  // the same idempotency log — this test proves that exclusion actually
  // takes effect in the KPI math, not just that the write happens.
  it("excludes checkouts that converted into a real order from cartsAbandoned, even though Shopify still fired a 'checkouts' webhook for them", async () => {
    rowsByTable.shop_links = [{ shop: "my-store.myshopify.com" }];
    rowsByTable.shopify_webhook_events = [
      // Genuinely abandoned — checkout fired, no matching conversion.
      { id: 1, shop: "my-store.myshopify.com", topic: "checkouts", idempotencyKey: "token-abandoned", processedAt: new Date(now) },
      // Converted into a real order — checkout fired AND a matching
      // checkout_converted event exists for the same token. Must NOT count.
      { id: 2, shop: "my-store.myshopify.com", topic: "checkouts", idempotencyKey: "token-converted", processedAt: new Date(now) },
      { id: 3, shop: "my-store.myshopify.com", topic: "checkout_converted", idempotencyKey: "token-converted", processedAt: new Date(now) },
    ];
    const { kpis } = await computeOrgAnalytics("org-1", 30);
    expect(kpis.recovery?.cartsAbandoned).toBe(1);
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

  it("returns a period-over-period comparison block for trend deltas", async () => {
    rowsByTable.calls = [call({ id: 1 }), call({ id: 2 })];
    const analytics = await computeOrgAnalytics("org-1", 30);
    // The previous-window snapshot the frontend turns into "+X% vs previous
    // period": scalar totals + the same per-vertical KPI blocks, keyed by
    // the requested range length so the UI can label the comparison window.
    expect(analytics.comparison).toBeDefined();
    expect(analytics.comparison.rangeDays).toBe(30);
    expect(typeof analytics.comparison.totalCalls).toBe("number");
    expect(typeof analytics.comparison.totalMinutes).toBe("number");
    expect(analytics.comparison.kpis).toBeDefined();
  });
});

describe("computeOrgAnalytics turn latency percentiles (§2)", () => {
  beforeEach(() => {
    rowsByTable = {
      orgs: [{ id: "org-1", currency: "INR", vertical: "shopify" }],
      calls: [call({ id: 1 })],
      call_latency: [],
      turn_latency: [],
      tool_calls: [],
      scheduled_calls: [],
    };
  });

  it("returns null percentiles with a 0 sample count when there are no turns yet", async () => {
    const { turnLatencyPercentiles } = await computeOrgAnalytics("org-1", 30);
    expect(turnLatencyPercentiles.voiceToVoiceMs).toEqual({ p50: null, p90: null, sampleCount: 0 });
  });

  it("computes P50/P90 by nearest-rank over voiceToVoiceMs, ignoring null (greeting) rows", async () => {
    // 10 samples, 100..1000ms in steps of 100 — nearest-rank P50 is the 5th
    // value (500), P90 is the 9th value (900).
    rowsByTable.turn_latency = [
      ...Array.from({ length: 10 }, (_, i) => ({
        callId: 1,
        turnIndex: i + 1,
        llmTtftMs: 50 + i * 10,
        ttsFirstByteMs: 80 + i * 10,
        voiceToVoiceMs: (i + 1) * 100,
      })),
      // Greeting row — no voiceToVoiceMs, must not skew the distribution or
      // count toward its sample size.
      { callId: 1, turnIndex: 0, llmTtftMs: 200, ttsFirstByteMs: 300, voiceToVoiceMs: null },
    ];
    const { turnLatencyPercentiles } = await computeOrgAnalytics("org-1", 30);
    expect(turnLatencyPercentiles.voiceToVoiceMs).toEqual({ p50: 500, p90: 900, sampleCount: 10 });
    expect(turnLatencyPercentiles.llmTtftMs.sampleCount).toBe(11);
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
    delete process.env.PUBLIC_USER_APP_URL;
    delete process.env.PUBLIC_MERCHANT_APP_URL;
    delete process.env.PUBLIC_APP_URL;
  });

  it("returns null when WEEBERSH_INSTALL_URL is unconfigured", () => {
    expect(buildInstallUrl("org-1")).toBeNull();
  });

  it("regression: return_url must be the user app origin + /integrations, never the API's own origin or the stale /app/shopify path", () => {
    process.env.WEEBERSH_INSTALL_URL = "https://weebersh.up.railway.app/auth/login";
    process.env.PUBLIC_USER_APP_URL = "https://app.weeber.ai";
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

  it("falls back to the old PUBLIC_MERCHANT_APP_URL name when PUBLIC_USER_APP_URL is unset (one-release back-compat for the ADR-052 rename)", () => {
    process.env.WEEBERSH_INSTALL_URL = "https://weebersh.up.railway.app/auth/login";
    process.env.PUBLIC_MERCHANT_APP_URL = "https://app.weeber.ai";
    process.env.PUBLIC_APP_URL = "https://api-production-c1bb.up.railway.app";

    const url = buildInstallUrl("org-1");
    expect(url).toContain(encodeURIComponent("https://app.weeber.ai/integrations?shopify_connected=1"));
  });

  it("falls back to PUBLIC_APP_URL only when neither PUBLIC_USER_APP_URL nor PUBLIC_MERCHANT_APP_URL is set (last-resort, not the primary path)", () => {
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

describe("upsertAgentConfig", () => {
  beforeEach(() => {
    lastInsertValues = undefined;
    // ADR-091: the templateKey is now checked against the visibility predicate
    // before anything is written, so the fake db has to return a matching
    // agent_templates row for the write path to be reached at all.
    rowsByTable = { agent_templates: [{ key: "template-a" }] };
  });

  it("refuses to write a config row for a template this org cannot see (ADR-091)", async () => {
    // `templateKey` arrives from a URL path param. Without this check, a
    // merchant could create their own customization row against another
    // account's private template — or against a key that is not a template.
    rowsByTable = { agent_templates: [] };
    const result = await upsertAgentConfig("org-1", "someone-elses-bespoke", { personaPrompt: "mine now" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("someone-elses-bespoke");
    expect(lastInsertValues).toBeUndefined();
  });

  it("regression: sttFallbackOrder/ttsFallbackOrder/llmFallbackModels must reach the insert values, not be silently dropped", async () => {
    await upsertAgentConfig("org-1", "template-a", {
      personaPrompt: "You are a helpful agent.",
      sttFallbackOrder: ["deepgram", "elevenlabs"],
      ttsFallbackOrder: ["cartesia", "sarvam"],
      llmFallbackModels: ["openai/gpt-4o-mini", "groq/llama-3.1-70b"],
    });

    expect(lastInsertValues).toBeDefined();
    expect(lastInsertValues?.sttFallbackOrder).toEqual(["deepgram", "elevenlabs"]);
    expect(lastInsertValues?.ttsFallbackOrder).toEqual(["cartesia", "sarvam"]);
    expect(lastInsertValues?.llmFallbackModels).toEqual(["openai/gpt-4o-mini", "groq/llama-3.1-70b"]);
  });

  it("passes through undefined (not fabricated defaults) when a frame omits the failover fields", async () => {
    await upsertAgentConfig("org-1", "template-a", { personaPrompt: "Hello." });

    expect(lastInsertValues).toBeDefined();
    expect(lastInsertValues?.sttFallbackOrder).toBeUndefined();
    expect(lastInsertValues?.ttsFallbackOrder).toBeUndefined();
    expect(lastInsertValues?.llmFallbackModels).toBeUndefined();
  });
});

/**
 * ADR-092. `org_agent_configs.enabled` was read in two cosmetic places and
 * nowhere on the call path, so a paused agent still dialled. These pin the
 * predicate that now gates scheduled dispatch — including the two fail-OPEN
 * cases, which are the ones a careless "just check enabled" refactor breaks.
 */
describe("isAgentDispatchable (ADR-092)", () => {
  beforeEach(() => {
    agentTemplateResponses = undefined;
    rowsByTable = {
      orgs: [{ id: "org-1", vertical: "insurance" }],
      org_agent_configs: [],
      agent_templates: [{ key: "insurance-post-sale-welcome" }],
    };
  });

  it("blocks an agent whose config row is explicitly disabled", async () => {
    rowsByTable.org_agent_configs = [{ enabled: false }];
    const result = await isAgentDispatchable("org-1", "insurance-post-sale-welcome");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("paused");
  });

  it("allows an agent whose config row is enabled", async () => {
    rowsByTable.org_agent_configs = [{ enabled: true }];
    expect((await isAgentDispatchable("org-1", "insurance-post-sale-welcome")).ok).toBe(true);
  });

  it("fails OPEN when there is no config row at all — an org that never touched the agents UI runs on template defaults, and treating absent as disabled would stop every unconfigured org's first workflow call", async () => {
    rowsByTable.org_agent_configs = [];
    expect((await isAgentDispatchable("org-1", "insurance-post-sale-welcome")).ok).toBe(true);
  });

  it("blocks a template left over from a previous vertical, even when its row says enabled (audit 12 found 3 of these in production, one holding an active caller ID)", async () => {
    rowsByTable.org_agent_configs = [{ enabled: true }];
    // 1st read: the key IS a real template. 2nd read: it is not visible for
    // this org's current vertical.
    agentTemplateResponses = [[{ key: "shopify-cart-recovery" }], []];
    const result = await isAgentDispatchable("org-1", "shopify-cart-recovery");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("insurance");
  });

  it("fails OPEN for an agent identity that is not a catalog template key at all — the scheduler keys this on persona/workflowName, and the legacy engine writes the merchant's own workflow name there", async () => {
    rowsByTable.org_agent_configs = [];
    agentTemplateResponses = [[]]; // no template with that key exists
    expect((await isAgentDispatchable("org-1", "my-custom-followup-flow")).ok).toBe(true);
  });

  it("blocks when the org no longer exists rather than resolving against a null vertical", async () => {
    rowsByTable.orgs = [];
    const result = await isAgentDispatchable("org-gone", "insurance-post-sale-welcome");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("org-gone");
  });
});
