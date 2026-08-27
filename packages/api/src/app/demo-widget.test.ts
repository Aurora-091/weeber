import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Real demo-call widget (2026-08-27) — covers `placeDemoCall`'s guardrail ordering (kill switch,
 * agentKey validity, consent, Turnstile, phone normalization, then the three rate-limit tiers)
 * and that a happy path writes the consent record and calls `placeOutboundCall` with the demo
 * org id and the right agentKey. Follows this suite's "mock the I/O boundary" convention (see
 * rate-limit-store.test.ts, place-outbound-call.test.ts) — `checkAndIncrementKeyedRateLimit`,
 * `verifyTurnstileToken`, `isGlobalFlagEnabled`, and `placeOutboundCall` are all mocked directly
 * rather than reaching into their own internals.
 *
 * The per-IP limiter (`fixed-window-limiter.ts`) is real, in-memory — deliberately not mocked, so
 * one test can prove the actual trip-after-N-calls behavior. Every other test uses its own unique
 * IP so it can't share that limiter's window with the dedicated per-IP test below.
 */

let flagEnabled = true;
let turnstileOk = true;
let turnstileConfigured = true;
let phoneLimitResult = { allowed: true, callCount: 1, windowStart: new Date() };
let globalLimitResult = { allowed: true, callCount: 1, windowStart: new Date() };
let lastKeyedLimitCalls: Array<{ scope: string; key: string }> = [];
let placeOutboundResult: unknown = { ok: true, provider: "twilio", sessionKey: "CA123", status: "queued" };
let lastPlaceOutboundInput: unknown = null;
let lastConsentInsert: unknown = null;

mock.module("../voice/demo-widget-flag", () => ({
  isGlobalFlagEnabled: async () => flagEnabled,
}));

mock.module("../voice/turnstile", () => ({
  verifyTurnstileToken: async () => turnstileOk,
  isTurnstileConfigured: () => turnstileConfigured,
}));

mock.module("../database/rate-limit-store", () => ({
  checkAndIncrementKeyedRateLimit: async (scope: string, key: string) => {
    lastKeyedLimitCalls.push({ scope, key });
    return scope === "phone" ? phoneLimitResult : globalLimitResult;
  },
}));

mock.module("../voice/place-outbound-call", () => ({
  placeOutboundCall: async (input: unknown) => {
    lastPlaceOutboundInput = input;
    return placeOutboundResult;
  },
}));

mock.module("../database", () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        lastConsentInsert = v;
        return Promise.resolve();
      },
    }),
  },
}));

import { placeDemoCall } from "./demo-widget";

const baseInput = {
  agentKey: "shopify-cod-confirmation" as unknown,
  phone: "+14155551234" as unknown,
  consent: true as unknown,
  turnstileToken: "tok" as unknown,
  userAgent: "test-agent",
};

describe("placeDemoCall", () => {
  beforeEach(() => {
    flagEnabled = true;
    turnstileOk = true;
    turnstileConfigured = true;
    phoneLimitResult = { allowed: true, callCount: 1, windowStart: new Date() };
    globalLimitResult = { allowed: true, callCount: 1, windowStart: new Date() };
    lastKeyedLimitCalls = [];
    placeOutboundResult = { ok: true, provider: "twilio", sessionKey: "CA123", status: "queued" };
    lastPlaceOutboundInput = null;
    lastConsentInsert = null;
  });

  it("fails closed (403) when the kill switch is disabled", async () => {
    flagEnabled = false;
    const result = await placeDemoCall({ ...baseInput, ip: "ip-killswitch" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(403);
  });

  it("rejects an unknown agentKey (400)", async () => {
    const result = await placeDemoCall({ ...baseInput, agentKey: "not-a-real-template", ip: "ip-badkey" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(400);
  });

  it("rejects when consent is not exactly true (400)", async () => {
    const result = await placeDemoCall({ ...baseInput, consent: "yes", ip: "ip-consent" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(400);
  });

  it("rejects when Turnstile verification fails (400)", async () => {
    turnstileOk = false;
    const result = await placeDemoCall({ ...baseInput, ip: "ip-turnstile" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(400);
  });

  it("skips Turnstile entirely while unconfigured (no Cloudflare keys set up) — a missing/empty token doesn't block the call", async () => {
    turnstileConfigured = false;
    turnstileOk = false; // proves the skip, not a lucky mock — verification would fail if it ran
    const result = await placeDemoCall({ ...baseInput, turnstileToken: "", ip: "ip-turnstile-unconfigured" });
    expect(result.ok).toBe(true);
  });

  it("rejects an unparseable phone number (400)", async () => {
    const result = await placeDemoCall({ ...baseInput, phone: "not-a-phone", ip: "ip-phone" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(400);
  });

  it("trips the per-IP limiter after the configured number of calls from one IP (429)", async () => {
    const ip = "ip-repeat-offender";
    const first = await placeDemoCall({ ...baseInput, ip });
    const second = await placeDemoCall({ ...baseInput, ip });
    const third = await placeDemoCall({ ...baseInput, ip });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.statusCode).toBe(429);
  });

  it("returns 429 when the per-phone-number limiter blocks", async () => {
    phoneLimitResult = { allowed: false, callCount: 2, windowStart: new Date() };
    const result = await placeDemoCall({ ...baseInput, ip: "ip-phonelimit" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(429);
  });

  it("returns 429 when the global daily limiter blocks", async () => {
    globalLimitResult = { allowed: false, callCount: 51, windowStart: new Date() };
    const result = await placeDemoCall({ ...baseInput, ip: "ip-globallimit" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(429);
  });

  it("checks the per-phone limiter keyed on the normalized number, and the global limiter on a fixed key", async () => {
    await placeDemoCall({ ...baseInput, ip: "ip-keys" });
    const phoneCall = lastKeyedLimitCalls.find((c) => c.scope === "phone");
    const globalCall = lastKeyedLimitCalls.find((c) => c.scope === "global");
    expect(phoneCall?.key).toBe("+14155551234");
    expect(globalCall?.key).toBeTruthy();
  });

  it("happy path: writes a consent record with ip/UA and calls placeOutboundCall with the demo org + agentKey", async () => {
    const result = await placeDemoCall({ ...baseInput, ip: "ip-happy" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionKey).toBe("CA123");
      expect(result.status).toBe("queued");
    }
    expect(lastConsentInsert).toMatchObject({
      dataPrincipal: "+14155551234",
      purpose: "marketing",
      channel: "web",
      source: "demo-widget",
      ipAddress: "ip-happy",
      userAgent: "test-agent",
    });
    expect(lastPlaceOutboundInput).toMatchObject({
      to: "+14155551234",
      agentKey: "shopify-cod-confirmation",
    });
  });

  it("maps a placeOutboundCall refusal straight through", async () => {
    placeOutboundResult = { ok: false, error: "This number is on the Do Not Call list.", statusCode: 403 };
    const result = await placeDemoCall({ ...baseInput, ip: "ip-refused" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(403);
      expect(result.error).toBe("This number is on the Do Not Call list.");
    }
  });
});
