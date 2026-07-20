import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import crypto from "node:crypto";

/**
 * Audit 2026-07-19 finding #1/#3 follow-up: requirePlivoSignature used to read
 * `orgs.plivoAuthToken` (plaintext) directly, skipping the vault entirely — the one telephony
 * signature-validation read path that never checked the vault at all, unlike
 * twilio-client.ts/plivo-client.ts/exotel-client.ts. Now vault-first with the plaintext column
 * as a fallback, same pattern as those. Covers: vault token used when present, plaintext
 * fallback when the vault has nothing, and the existing fail-open-with-warning behavior when
 * neither resolves.
 */

let vaultToken: string | null = null;
let plaintextToken: string | null = null;

mock.module("../../database/credential-vault", () => ({
  readCredential: async (_orgId: string, _field: string) => vaultToken,
  PLIVO_FIELDS: { authId: "plivo_auth_id", authToken: "plivo_auth_token" },
}));

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (plaintextToken ? [{ token: plaintextToken }] : []),
        }),
      }),
    }),
  },
}));

mock.module("../../database/schema", () => ({ orgs: {} }));

import { requirePlivoSignature } from "./plivo-signature";

function sign(method: string, url: string, nonce: string, token: string): string {
  const baseString = `${method} ${url}${nonce}`;
  return crypto.createHmac("sha256", token).update(baseString).digest("base64");
}

function buildApp() {
  const app = new Hono();
  app.post("/incoming/plivo", requirePlivoSignature, (c) => c.json({ ok: true }));
  return app;
}

describe("requirePlivoSignature", () => {
  beforeEach(() => {
    vaultToken = null;
    plaintextToken = null;
  });

  it("validates against the vaulted token when the vault has one", async () => {
    vaultToken = "vaulted-secret";
    plaintextToken = "legacy-plaintext-secret"; // should be ignored — vault wins
    const app = buildApp();
    const url = "http://localhost/incoming/plivo?orgId=org-a";
    const nonce = "nonce-1";
    const sig = sign("POST", url, nonce, "vaulted-secret");
    const res = await app.request(url, {
      method: "POST",
      headers: { "x-plivo-signature-v3": sig, "x-plivo-signature-v3-nonce": nonce },
    });
    expect(res.status).toBe(200);
  });

  it("falls back to the legacy plaintext token when the vault has nothing", async () => {
    vaultToken = null;
    plaintextToken = "legacy-plaintext-secret";
    const app = buildApp();
    const url = "http://localhost/incoming/plivo?orgId=org-a";
    const nonce = "nonce-2";
    const sig = sign("POST", url, nonce, "legacy-plaintext-secret");
    const res = await app.request(url, {
      method: "POST",
      headers: { "x-plivo-signature-v3": sig, "x-plivo-signature-v3-nonce": nonce },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a signature computed with the wrong token", async () => {
    vaultToken = "vaulted-secret";
    const app = buildApp();
    const url = "http://localhost/incoming/plivo?orgId=org-a";
    const nonce = "nonce-3";
    const sig = sign("POST", url, nonce, "wrong-token");
    const res = await app.request(url, {
      method: "POST",
      headers: { "x-plivo-signature-v3": sig, "x-plivo-signature-v3-nonce": nonce },
    });
    expect(res.status).toBe(401);
  });

  // Audit 2026-07-19 finding #4 (extended to Plivo alongside the Twilio fix): used to fail
  // OPEN (skip validation, warn) when no token could be resolved at all -- now fails CLOSED.
  it("fails CLOSED (401) rather than skipping validation when no token can be resolved at all", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost/incoming/plivo?orgId=org-with-nothing", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
