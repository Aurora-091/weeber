import { mock, describe, it, expect, beforeEach } from "bun:test";

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
            limit: () => mockSelectedOrgs,
            // ADR-112: the org-level number lookup now orders explicitly, so
            // .orderBy() must stay chainable into .limit() the way the real
            // builder is.
            orderBy: () => ({ limit: () => mockSelectedOrgs })
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

mock.module("@weeber/compliance", () => {
  return {
    checkOutboundCallCompliance: async () => {
      return mockComplianceResult;
    },
    // ADR-096: the outbound route no longer calls checkOutboundCallCompliance
    // directly — it calls compliance/outbound-gate.ts's assertOutboundCallAllowed,
    // which is also what placeOutboundCall enforces with. The real gate runs in
    // these tests (that is the point of the chokepoint); these are the package
    // primitives it composes.
    isOnDoNotCallList: async () => mockDncListed,
    checkCallingWindow: () => ({
      allowed: mockWindowAllowed,
      reason: "blocked for test",
      resolvedTimezone: null,
      localHour: 12,
    }),
    resolveUsState: () => null,
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

let mockComplianceResult: { allowed: boolean; reason?: string; failedCheck?: string } = { allowed: true };
// ADR-096 split the single "is this call compliant" boolean into the two gates
// that behave differently under the non-production BYPASS_COMPLIANCE env var:
// the calling window IS bypassable outside production, DNC is not — anywhere,
// in any environment.
let mockDncListed = false;
let mockWindowAllowed = true;

import { voice } from "./routes";

describe("Voice routes - Outbound Caller ID resolution", () => {
  beforeEach(() => {
    mockSelectedOrgs = [];
    lastTwilioCallParams = null;
    process.env.TWILIO_PHONE_NUMBER = "+15551112222";
    mockDncListed = false;
    mockWindowAllowed = true;
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

// Global Compliance Engine Tier 0 fix #1 (docs/global-compliance-engine-plan.md,
// 2026-07-16): BYPASS_COMPLIANCE used to be reachable via a client-supplied
// request-body flag with no environment restriction at all. Locks in: the
// request-body variant is never honored (any environment), and the env var
// itself is hard-disabled in production regardless of its value.
describe("Voice routes - BYPASS_COMPLIANCE hardening", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBypassEnv = process.env.BYPASS_COMPLIANCE;

  beforeEach(() => {
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888" }];
    lastTwilioCallParams = null;
    process.env.TWILIO_PHONE_NUMBER = "+15551112222";
    // A call blocked by real compliance is the control for every test below —
    // if the bypass logic is broken, a "blocked" call would silently succeed instead.
    // ADR-096: the control is now the CALLING WINDOW, not DNC. DNC is no longer
    // bypassable by the env var either (it never should have been — the old
    // implementation skipped the whole compliance block, DNC included, while the
    // comment beside it claimed DNC had no bypass anywhere). The last test in
    // this block covers that directly.
    mockComplianceResult = { allowed: false, reason: "blocked for test", failedCheck: "dnc" };
    mockDncListed = false;
    mockWindowAllowed = false;
  });

  it("ignores a client-supplied bypassCompliance:true in the request body (dev/test env)", async () => {
    delete process.env.NODE_ENV; // non-production
    delete process.env.BYPASS_COMPLIANCE;

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15557776666", orgId: "org-123", bypassCompliance: true })
    });

    expect(res.status).toBe(403);
    expect(lastTwilioCallParams).toBeNull();

    process.env.NODE_ENV = originalNodeEnv;
    process.env.BYPASS_COMPLIANCE = originalBypassEnv;
  });

  it("ignores a client-supplied bypassCompliance:true even when BYPASS_COMPLIANCE=true is also set", async () => {
    delete process.env.NODE_ENV;
    process.env.BYPASS_COMPLIANCE = "not-the-string-true"; // env bypass itself off

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15557776666", orgId: "org-123", bypassCompliance: true })
    });

    expect(res.status).toBe(403);
    expect(lastTwilioCallParams).toBeNull();

    process.env.NODE_ENV = originalNodeEnv;
    process.env.BYPASS_COMPLIANCE = originalBypassEnv;
  });

  it("honors BYPASS_COMPLIANCE=true outside production", async () => {
    delete process.env.NODE_ENV;
    process.env.BYPASS_COMPLIANCE = "true";

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15557776666", orgId: "org-123" })
    });

    expect(res.status).toBe(201);
    expect(lastTwilioCallParams).toBeDefined();

    process.env.NODE_ENV = originalNodeEnv;
    process.env.BYPASS_COMPLIANCE = originalBypassEnv;
  });

  it("does NOT bypass DNC, even outside production with BYPASS_COMPLIANCE=true (ADR-096)", async () => {
    delete process.env.NODE_ENV;
    process.env.BYPASS_COMPLIANCE = "true";
    mockWindowAllowed = true; // only DNC blocks here
    mockDncListed = true;

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15557776666", orgId: "org-123" })
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Do Not Call") });
    expect(lastTwilioCallParams).toBeNull();

    process.env.NODE_ENV = originalNodeEnv;
    process.env.BYPASS_COMPLIANCE = originalBypassEnv;
  });

  it("hard-disables BYPASS_COMPLIANCE=true in production — the real gap this fix closes", async () => {
    process.env.NODE_ENV = "production";
    process.env.BYPASS_COMPLIANCE = "true";

    const res = await voice.request("/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15557776666", orgId: "org-123" })
    });

    expect(res.status).toBe(403);
    expect(lastTwilioCallParams).toBeNull();

    process.env.NODE_ENV = originalNodeEnv;
    process.env.BYPASS_COMPLIANCE = originalBypassEnv;
  });
});
