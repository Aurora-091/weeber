import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { verifyTurnstileToken, isTurnstileConfigured } from "./turnstile";

/**
 * Real demo-call widget (2026-08-27) — Turnstile is the first CAPTCHA integration in this
 * codebase, and it must fail CLOSED on every error path (no secret configured, a non-2xx
 * response, a network error, a malformed response) since an unverifiable token blocking a demo
 * call is a far smaller cost than an unverified one placing one.
 */

const originalFetch = globalThis.fetch;
const originalSecret = process.env.TURNSTILE_SECRET_KEY;

describe("verifyTurnstileToken", () => {
  beforeEach(() => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalSecret;
  });

  it("returns true when Cloudflare reports success", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch;
    expect(await verifyTurnstileToken("good-token", "1.2.3.4")).toBe(true);
  });

  it("returns false when Cloudflare reports failure", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as unknown as typeof fetch;
    expect(await verifyTurnstileToken("bad-token", "1.2.3.4")).toBe(false);
  });

  it("fails closed on a non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await verifyTurnstileToken("token", undefined)).toBe(false);
  });

  it("fails closed on a network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await verifyTurnstileToken("token", undefined)).toBe(false);
  });

  it("fails closed when no secret is configured, without ever calling fetch", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await verifyTurnstileToken("token", undefined)).toBe(false);
    expect(called).toBe(false);
  });

  it("rejects an empty token without calling fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await verifyTurnstileToken("", undefined)).toBe(false);
    expect(called).toBe(false);
  });
});

describe("isTurnstileConfigured", () => {
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalSecret;
  });

  it("is true once TURNSTILE_SECRET_KEY is set", () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    expect(isTurnstileConfigured()).toBe(true);
  });

  it("is false with no secret configured — the 2026-08-27 no-Cloudflare-keys-yet state", () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(isTurnstileConfigured()).toBe(false);
  });
});
