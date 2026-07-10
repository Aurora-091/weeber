import { mock, describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "crypto";

let mockCallRows: { orgId: string | null }[] = [];
let mockOrgRows: { id: string }[] = [];
let mockOrgCreds: { accountSid: string; authToken: string } | null = null;

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  return promise;
}

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        if (name === "calls") return thenable(mockCallRows);
        if (name === "orgs") return thenable(mockOrgRows);
        return thenable([]);
      },
    }),
  },
}));

// getAuthTokenForOrg goes through twilio-client.ts, which does its own DB
// lookup — mock it directly instead of re-mocking the DB shape it expects,
// so this test stays focused on the *resolution order* this middleware adds
// (CallSid -> To -> global fallback), not twilio-client's internals.
mock.module("../twilio-client", () => ({
  getPublicUrl: () => "https://example.test",
  getAuthTokenForOrg: async (orgId?: string | null) => {
    if (orgId && mockOrgCreds) return mockOrgCreds.authToken;
    return process.env.TWILIO_AUTH_TOKEN;
  },
}));

process.env.TWILIO_AUTH_TOKEN = "global-token";

const { requireTwilioSignature } = await import("./twilio-signature");

function buildApp() {
  const app = new Hono();
  app.post("/hook", requireTwilioSignature, (c) => c.json({ ok: true }));
  return app;
}

/** Same HMAC-SHA1-over-URL-plus-sorted-params scheme Twilio's own
 * `validateRequest` checks against (documented signing algorithm) — signing
 * it ourselves here rather than depending on an internal/undocumented SDK
 * export to produce a matching signature. */
function signTwilioRequest(authToken: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

function signedRequest(params: Record<string, string>, authToken: string) {
  const url = "https://example.test/hook";
  const body = new URLSearchParams(params).toString();
  const sig = signTwilioRequest(authToken, url, params);
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
    body,
  });
}

describe("requireTwilioSignature — org-aware token resolution", () => {
  beforeEach(() => {
    mockCallRows = [];
    mockOrgRows = [];
    mockOrgCreds = null;
  });

  it("validates against the global token when no CallSid/To match resolves an org", async () => {
    const app = buildApp();
    const params = { CallSid: "CAunknown", CallStatus: "completed" };
    const res = await app.request(signedRequest(params, "global-token"));
    expect(res.status).toBe(200);
  });

  it("rejects a request signed with the wrong token when no org resolves", async () => {
    const app = buildApp();
    const params = { CallSid: "CAunknown", CallStatus: "completed" };
    const res = await app.request(signedRequest(params, "wrong-token"));
    expect(res.status).toBe(403);
  });

  it("resolves the org's own auth token via CallSid -> calls.orgId and validates against it", async () => {
    mockCallRows = [{ orgId: "org_byo" }];
    mockOrgCreds = { accountSid: "ACsub", authToken: "org-specific-token" };
    const app = buildApp();
    const params = { CallSid: "CAknown", CallStatus: "completed" };

    // Signed with the org's own token — must pass even though it's not the global one.
    const res = await app.request(signedRequest(params, "org-specific-token"));
    expect(res.status).toBe(200);

    // Signed with the global token instead — must now fail, since this call
    // belongs to an org with its own dedicated credentials.
    const wrongRes = await app.request(signedRequest(params, "global-token"));
    expect(wrongRes.status).toBe(403);
  });

  it("falls back to resolving by dialed number (To) when CallSid has no matching call row yet", async () => {
    mockCallRows = []; // fresh inbound call, no DB row yet
    mockOrgRows = [{ id: "org_byo" }];
    mockOrgCreds = { accountSid: "ACsub", authToken: "org-specific-token" };
    const app = buildApp();
    const params = { CallSid: "CAfresh", To: "+15550001111" };

    const res = await app.request(signedRequest(params, "org-specific-token"));
    expect(res.status).toBe(200);
  });
});
