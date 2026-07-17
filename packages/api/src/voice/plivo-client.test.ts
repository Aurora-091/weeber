import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Plivo mid-call hangup/transfer tests (2026-07-17, closing the gap flagged in
 * docs/india-telephony.md — "Mid-call hang-up ... remain Twilio-only"). Mocks credential
 * resolution (db + credential-vault) and global fetch, same "mock the I/O boundary, exercise the
 * real function" pattern as the other provider-client tests in this file's directory.
 */

let credentialVaultValues: Record<string, string | null> = {};
let orgRow: { authId: string | null; authToken: string | null } | undefined;

mock.module("../database/credential-vault", () => ({
  readCredential: async (_orgId: string, field: string) => credentialVaultValues[field] ?? null,
  PLIVO_FIELDS: { authId: "plivo_auth_id", authToken: "plivo_auth_token" },
}));

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (orgRow ? [{ authId: orgRow.authId, authToken: orgRow.authToken }] : []),
        }),
      }),
    }),
  },
}));

mock.module("../database/schema", () => ({ orgs: {} }));
mock.module("drizzle-orm", () => ({ eq: () => undefined }));

import { hangupPlivoCall, transferPlivoCall, buildPlivoTransferXml } from "./plivo-client";

const ORG_ID = "org-1";
const CALL_UUID = "call-uuid-123";

describe("hangupPlivoCall / transferPlivoCall", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    credentialVaultValues = { plivo_auth_id: "auth-id", plivo_auth_token: "auth-token" };
    orgRow = undefined;
    originalFetch = globalThis.fetch;
  });

  it("hangupPlivoCall returns not-configured when no Plivo credentials exist for the org", async () => {
    credentialVaultValues = {};
    const result = await hangupPlivoCall(ORG_ID, CALL_UUID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No Plivo credentials");
  });

  it("hangupPlivoCall issues a DELETE to the correct Call endpoint and succeeds on a 204", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return { ok: true, status: 204, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const result = await hangupPlivoCall(ORG_ID, CALL_UUID);
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("DELETE");
    expect(capturedUrl).toBe(`https://api.plivo.com/v1/Account/auth-id/Call/${CALL_UUID}/`);
    globalThis.fetch = originalFetch;
  });

  it("hangupPlivoCall surfaces Plivo's own error message on a non-2xx response", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({ error: "Call not found" }) })) as unknown as typeof fetch;
    const result = await hangupPlivoCall(ORG_ID, CALL_UUID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Call not found");
    globalThis.fetch = originalFetch;
  });

  it("hangupPlivoCall degrades to a clear error (not a throw) when Plivo can't be reached at all", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await hangupPlivoCall(ORG_ID, CALL_UUID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Failed to reach Plivo");
    globalThis.fetch = originalFetch;
  });

  it("transferPlivoCall POSTs legs=aleg with the given aleg_url and succeeds on 2xx", async () => {
    let capturedBody = "";
    let capturedMethod = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method ?? "";
      capturedBody = String(init?.body ?? "");
      return { ok: true, status: 202, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const alegUrl = "https://example.weeber.ai/api/voice/transfer-xml/plivo?to=%2B15551234567";
    const result = await transferPlivoCall(ORG_ID, CALL_UUID, alegUrl);
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("POST");
    const parsed = JSON.parse(capturedBody);
    expect(parsed.legs).toBe("aleg");
    expect(parsed.aleg_url).toBe(alegUrl);
    globalThis.fetch = originalFetch;
  });

  it("transferPlivoCall returns not-configured when no Plivo credentials exist for the org", async () => {
    credentialVaultValues = {};
    const result = await transferPlivoCall(ORG_ID, CALL_UUID, "https://example.com/xml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No Plivo credentials");
  });
});

describe("buildPlivoTransferXml", () => {
  it("wraps the transfer number in a <Dial> inside a <Response>", () => {
    expect(buildPlivoTransferXml("+15551234567")).toBe("<Response><Dial>+15551234567</Dial></Response>");
  });
});
