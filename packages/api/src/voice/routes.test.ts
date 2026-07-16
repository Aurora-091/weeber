import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

// requireAdminKey is mocked to a no-op below, but that mock has proven
// fragile to unrelated changes elsewhere in routes.ts's import graph
// (adding *any* new import, even one with zero dependencies, has been
// observed to make bun's mock.module stop intercepting "./middleware/
// admin-auth" in this file — a bun mocking quirk, not a logic bug). Belt
// and suspenders: clearing the real env var means the REAL requireAdminKey
// falls through to its own no-key-configured no-op path even if the mock
// above doesn't apply, so this test doesn't silently start failing again
// the next time routes.ts gains an import for an unrelated reason.
delete process.env.ADMIN_API_KEY;

let mockSelectedOrgs: any[] = [];
let lastTwilioCallParams: any = null;

mock.module("../database", () => {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => mockSelectedOrgs
          })
        })
      }),
      // credential-vault.ts's readCredential() calls db.execute() to read
      // an org's vault-stored Twilio creds — return no row so the caller
      // falls through to the plaintext-column path this test already
      // mocks via `select` above (matches production's documented
      // vault-first-then-plaintext-fallback behavior during the
      // migration transition).
      execute: async () => []
    }
  };
});

mock.module("./twilio-client", () => {
  return {
    twilioClient: {
      calls: {
        create: async (params: any) => {
          lastTwilioCallParams = params;
          return { sid: "CA_test_sid", status: "queued" };
        }
      }
    },
    getPublicUrl: () => "http://localhost"
  };
});

mock.module("./middleware/admin-auth", () => {
  return {
    requireAdminKey: async (_c: any, next: any) => {
      await next();
    }
  };
});

mock.module("./middleware/rate-limit", () => {
  return {
    rateLimitOutboundCalls: async (_c: any, next: any) => {
      await next();
    }
  };
});

mock.module("@openvent/compliance", () => {
  return {
    checkOutboundCallCompliance: async () => {
      return { allowed: true };
    },
    addToDoNotCallList: async () => {},
    removeFromDoNotCallList: async () => {},
    listDoNotCall: async () => [],
    eraseCallerData: async () => ({ callsDeleted: 0 }),
    getDisclosureLine: () => "",
    buildCallAuditRecord: () => null,
    buildPhoneNumberAuditTrail: () => null,
    renderAuditTrailText: () => ""
  };
});

import { voice } from "./routes";

describe("Voice routes - Outbound Caller ID resolution", () => {
  beforeEach(() => {
    mockSelectedOrgs = [];
    lastTwilioCallParams = null;
    process.env.TWILIO_PHONE_NUMBER = "+15551112222";
  });

  it("dials with org outboundNumber if configured", async () => {
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888" }];

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        to: "+15557776666",
        orgId: "org-123"
      })
    });

    expect(res.status).toBe(201);
    expect(lastTwilioCallParams).toBeDefined();
    expect(lastTwilioCallParams.from).toBe("+15559998888");
  });

  it("dials with default TWILIO_PHONE_NUMBER if org outboundNumber is not set", async () => {
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: null }];

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        to: "+15557776666",
        orgId: "org-123"
      })
    });

    expect(res.status).toBe(201);
    expect(lastTwilioCallParams).toBeDefined();
    expect(lastTwilioCallParams.from).toBe("+15551112222");
  });
});

describe("Voice routes - compliance bypass hardening (prod)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnvBypass = process.env.BYPASS_COMPLIANCE;

  beforeEach(() => {
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888" }];
    lastTwilioCallParams = null;
    process.env.TWILIO_PHONE_NUMBER = "+15551112222";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalEnvBypass === undefined) delete process.env.BYPASS_COMPLIANCE;
    else process.env.BYPASS_COMPLIANCE = originalEnvBypass;
  });

  it("rejects a request-body bypassCompliance in production (403) and never dials", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.BYPASS_COMPLIANCE;

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15557776666", orgId: "org-123", bypassCompliance: true }),
    });

    expect(res.status).toBe(403);
    expect(lastTwilioCallParams).toBeNull();
  });

  it("hard-fails (500) when BYPASS_COMPLIANCE=true is set in production and never dials", async () => {
    process.env.NODE_ENV = "production";
    process.env.BYPASS_COMPLIANCE = "true";

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15557776666", orgId: "org-123" }),
    });

    expect(res.status).toBe(500);
    expect(lastTwilioCallParams).toBeNull();
  });
});
