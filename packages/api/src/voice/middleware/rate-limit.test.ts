import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

/**
 * Audit 2026-07-19 finding #2 — outbound-call rate limiter is now per-org (keyed by the
 * request body's `orgId`), not a global process-local singleton. Covers: two different orgs
 * never share a bucket, requests with no orgId share an isolated "unscoped" bucket (not a
 * free-for-all shared with real orgs), and the 429 response shape.
 */

let lastOrgIdSeen: string | null = null;
let nextResult: { allowed: boolean; callCount: number; windowStart: Date } = {
  allowed: true,
  callCount: 1,
  windowStart: new Date(),
};

mock.module("../../database/rate-limit-store", () => ({
  checkAndIncrementOutboundRateLimit: async (orgId: string) => {
    lastOrgIdSeen = orgId;
    return nextResult;
  },
}));

import { rateLimitOutboundCalls } from "./rate-limit";

function buildApp() {
  const app = new Hono();
  app.post("/calls/outbound", rateLimitOutboundCalls, async (c) => {
    // The route handler re-reads the body after the middleware already parsed it once —
    // exercises the same "Hono caches the parsed body" assumption the middleware relies on.
    const body = await c.req.json();
    return c.json({ ok: true, body });
  });
  return app;
}

describe("rateLimitOutboundCalls", () => {
  beforeEach(() => {
    lastOrgIdSeen = null;
    nextResult = { allowed: true, callCount: 1, windowStart: new Date() };
  });

  it("keys the limiter by the request body's orgId", async () => {
    const app = buildApp();
    await app.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15551234567", orgId: "org-specific" }),
    });
    expect(lastOrgIdSeen).toBe("org-specific");
  });

  it("falls back to a shared 'unscoped' bucket when no orgId is present, not a crash", async () => {
    const app = buildApp();
    const res = await app.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15551234567" }),
    });
    expect(lastOrgIdSeen).toBe("unscoped");
    expect(res.status).toBe(200);
  });

  it("lets the request through and the handler can still read the body when allowed", async () => {
    nextResult = { allowed: true, callCount: 1, windowStart: new Date() };
    const app = buildApp();
    const res = await app.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15551234567", orgId: "org-a" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { body: { orgId: string } };
    expect(json.body.orgId).toBe("org-a");
  });

  it("returns 429 with a Retry-After-style message when the limit is exceeded", async () => {
    nextResult = { allowed: false, callCount: 31, windowStart: new Date() };
    const app = buildApp();
    const res = await app.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15551234567", orgId: "org-a" }),
    });
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("rate limit exceeded");
  });

  it("handles a missing/invalid JSON body without the middleware itself crashing", async () => {
    const app = buildApp();
    const res = await app.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // The middleware's own .catch(() => null) means it falls to the "unscoped" bucket and calls
    // next() -- it never crashes. The 500 here comes from this test route's handler re-parsing
    // the same invalid body (a real route would normally validate/400 on that itself, same as
    // the actual /calls/outbound handler already does before this middleware existed).
    expect(lastOrgIdSeen).toBe("unscoped");
    expect(res.status).toBe(500);
  });
});
