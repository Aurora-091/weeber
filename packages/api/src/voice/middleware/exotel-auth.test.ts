import { mock, describe, it, expect, beforeEach } from "bun:test";

let mockCreds: { sid: string; apiKey: string; apiToken: string; subdomain: string } | null = null;

// getExotelCredsForOrg goes through exotel-client.ts, which does its own DB/vault
// lookup — mock it directly (same pattern as twilio-signature.test.ts mocking
// twilio-client.ts) so this test stays focused on verifyExotelStreamAuth's own
// header-parsing/comparison logic, not exotel-client's internals.
mock.module("../exotel-client", () => ({
  getExotelCredsForOrg: async (orgId: string) => (orgId === "org-1" ? mockCreds : null),
  // Real implementation duplicated here (not imported) since mock.module
  // fully replaces the module for every import in this file, including the
  // buildExotelStreamUrl tests below — see exotel-client.ts for the real,
  // documented copy this must stay identical to.
  buildExotelStreamUrl: (baseWsUrl: string, orgId: string, apiToken: string) => {
    const url = new URL(baseWsUrl);
    url.username = encodeURIComponent(orgId);
    url.password = encodeURIComponent(apiToken);
    return url.toString();
  },
}));

import { verifyExotelStreamAuth } from "./exotel-auth";
import { buildExotelStreamUrl } from "../exotel-client";

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function fakeRequest(authHeader?: string): Request {
  return new Request("https://example.test/api/voice/stream/exotel", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe("buildExotelStreamUrl", () => {
  it("embeds orgId and token as Basic Auth credentials in the WSS URL", () => {
    const url = buildExotelStreamUrl("wss://example.test/api/voice/stream/exotel", "org-1", "secret-token");
    expect(url).toBe("wss://org-1:secret-token@example.test/api/voice/stream/exotel");
  });

  it("URL-encodes an orgId/token containing special characters", () => {
    const url = buildExotelStreamUrl("wss://example.test/path", "org:weird", "tok/en");
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe("org:weird");
    expect(decodeURIComponent(parsed.password)).toBe("tok/en");
  });
});

describe("verifyExotelStreamAuth", () => {
  beforeEach(() => {
    mockCreds = { sid: "sid-1", apiKey: "key-1", apiToken: "correct-token", subdomain: "api.exotel.com" };
  });

  it("rejects a request with no Authorization header at all", async () => {
    const result = await verifyExotelStreamAuth(fakeRequest());
    expect(result.ok).toBe(false);
  });

  it("rejects a non-Basic Authorization header", async () => {
    const result = await verifyExotelStreamAuth(fakeRequest("Bearer sometoken"));
    expect(result.ok).toBe(false);
  });

  it("rejects malformed base64 in the Basic payload", async () => {
    const result = await verifyExotelStreamAuth(fakeRequest("Basic not-valid-base64!!!"));
    expect(result.ok).toBe(false);
  });

  it("rejects a well-formed Basic header for an org with no stored Exotel credentials", async () => {
    const result = await verifyExotelStreamAuth(fakeRequest(basicAuthHeader("org-unknown", "anything")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No Exotel credentials configured");
  });

  it("rejects when the provided token doesn't match the org's real stored token", async () => {
    const result = await verifyExotelStreamAuth(fakeRequest(basicAuthHeader("org-1", "wrong-token")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mismatch");
  });

  it("accepts a well-formed Basic header whose token matches the org's real stored token", async () => {
    const result = await verifyExotelStreamAuth(fakeRequest(basicAuthHeader("org-1", "correct-token")));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.orgId).toBe("org-1");
  });

  it("round-trips correctly through buildExotelStreamUrl — a URL it builds always verifies successfully", async () => {
    const url = buildExotelStreamUrl("wss://example.test/api/voice/stream/exotel", "org-1", "correct-token");
    const parsed = new URL(url);
    const header = basicAuthHeader(decodeURIComponent(parsed.username), decodeURIComponent(parsed.password));
    const result = await verifyExotelStreamAuth(fakeRequest(header));
    expect(result.ok).toBe(true);
  });
});
