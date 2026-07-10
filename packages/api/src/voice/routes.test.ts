import { mock, describe, it, expect, beforeEach } from "bun:test";

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
      })
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
    requireAdminKey: async (c: any, next: any) => {
      await next();
    }
  };
});

mock.module("./middleware/rate-limit", () => {
  return {
    rateLimitOutboundCalls: async (c: any, next: any) => {
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
