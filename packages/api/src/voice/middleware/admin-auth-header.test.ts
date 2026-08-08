import { describe, it, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { requireAdminKey } from "./admin-auth";

/**
 * The admin header was renamed X-OpenVent-Admin-Key -> X-Weeber-Admin-Key when
 * the OpenVent branding was removed. The old name is accepted PERMANENTLY, not
 * behind a deprecation window, because it is a live wire contract with callers
 * this repo can neither see nor redeploy: operator curl scripts, saved
 * Postman/Bruno collections, cron jobs. Accepting a second header name grants
 * no extra access — the key is still the only secret — so there is nothing to
 * win by removing it, and a silent 401 at 3am to lose.
 *
 * These tests exist so that "delete the legacy header, it's been months" fails
 * loudly in CI instead of shipping.
 */

process.env.ADMIN_API_KEY = "test-admin-key";
afterAll(() => {
  delete process.env.ADMIN_API_KEY;
});

const app = new Hono().use("*", requireAdminKey).get("/probe", (c) => c.json({ actor: c.get("adminActor") }));

async function probe(headers: Record<string, string>) {
  return app.request("/probe", { headers });
}

describe("admin key header — dual accept", () => {
  it("authenticates with the current X-Weeber-Admin-Key header", async () => {
    const res = await probe({ "X-Weeber-Admin-Key": "test-admin-key" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: "env-admin-key" });
  });

  it("still authenticates with the legacy X-OpenVent-Admin-Key header", async () => {
    const res = await probe({ "X-OpenVent-Admin-Key": "test-admin-key" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: "env-admin-key" });
  });

  it("prefers the new header when both are sent, so a stale legacy value can't win", async () => {
    const res = await probe({
      "X-Weeber-Admin-Key": "test-admin-key",
      "X-OpenVent-Admin-Key": "stale-wrong-key",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong key under either header name", async () => {
    expect((await probe({ "X-Weeber-Admin-Key": "nope" })).status).toBe(401);
    expect((await probe({ "X-OpenVent-Admin-Key": "nope" })).status).toBe(401);
  });

  it("rejects a request with no admin header at all", async () => {
    const res = await probe({});
    expect(res.status).toBe(401);
  });
});
