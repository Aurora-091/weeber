import { mock, describe, it, expect, beforeEach } from "bun:test";

let mockScheduledCallRows: any[] = [];
let mockSelectedOrgs: any[] = [];
let lastTwilioCallParams: any = null;
let lastPlivoParams: any = null;
let lastExotelParams: any = null;

function getTableName(table: any): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find(s => s.toString() === "Symbol(drizzle:Name)");
  return sym ? table[sym] : undefined;
}

mock.module("../../database", () => {
  return {
    db: {
      select: () => ({
        from: (table: any) => {
          const tableName = getTableName(table);
          return {
            where: () => {
              let result = [];
              if (tableName === "orgs") {
                result = mockSelectedOrgs;
              } else if (tableName === "scheduled_calls") {
                result = mockScheduledCallRows;
              }
              const mockQuery: any = [...result];
              mockQuery.limit = () => result;
              return mockQuery;
            }
          };
        }
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => [{ id: 1 }]
          })
        })
      })
    }
  };
});

mock.module("../twilio-client", () => {
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

// F1: scheduled calls must dispatch through the org's real telephony
// provider, not always Twilio. These capture whether the India providers get
// called from the scheduler sweep.
mock.module("../plivo-client", () => {
  return {
    createPlivoOutboundCall: async (params: any) => {
      lastPlivoParams = params;
      return { ok: true, requestUuid: "plivo_req_uuid" };
    },
    buildPlivoStreamXml: () => "",
  };
});

mock.module("../exotel-client", () => {
  return {
    createExotelOutboundCall: async (params: any) => {
      lastExotelParams = params;
      return { ok: true, callSid: "exotel_call_sid" };
    },
  };
});

mock.module("../session-store", () => {
  return {
    sessionStore: {
      set: () => Promise.resolve()
    }
  };
});

mock.module("@openvent/compliance", () => {
  return {
    isOnDoNotCallList: async () => false,
    checkCallingWindow: () => ({ allowed: true })
  };
});

mock.module("../../../../openvent-compliance/src/index", () => {
  return {
    isOnDoNotCallList: async () => false,
    checkCallingWindow: () => ({ allowed: true })
  };
});

import { executeDueScheduledCalls } from "./scheduler";

describe("Scheduler - Outbound Caller ID resolution", () => {
  beforeEach(() => {
    mockScheduledCallRows = [];
    mockSelectedOrgs = [];
    lastTwilioCallParams = null;
    lastPlivoParams = null;
    lastExotelParams = null;
    process.env.TWILIO_PHONE_NUMBER = "+15551112222";
  });

  it("dials with org outboundNumber if configured in scheduler sweep", async () => {
    mockScheduledCallRows = [
      {
        id: 1,
        toNumber: "+15557776666",
        orgId: "org-123",
        attempt: 1,
        maxAttempts: 2,
        workflowName: "test-workflow",
        persona: "test-persona"
      }
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888" }];

    await executeDueScheduledCalls();

    expect(lastTwilioCallParams).toBeDefined();
    expect(lastTwilioCallParams.from).toBe("+15559998888");
  });

  it("dials with default TWILIO_PHONE_NUMBER if org outboundNumber is not set in scheduler sweep", async () => {
    mockScheduledCallRows = [
      {
        id: 1,
        toNumber: "+15557776666",
        orgId: "org-123",
        attempt: 1,
        maxAttempts: 2,
        workflowName: "test-workflow",
        persona: "test-persona"
      }
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: null }];

    await executeDueScheduledCalls();

    expect(lastTwilioCallParams).toBeDefined();
    expect(lastTwilioCallParams.from).toBe("+15551112222");
  });

  it("routes a Plivo org's scheduled call through Plivo, not Twilio (F1)", async () => {
    mockScheduledCallRows = [
      {
        id: 1,
        toNumber: "+919876543210",
        orgId: "org-plivo",
        attempt: 1,
        maxAttempts: 2,
        workflowName: "test-workflow",
        persona: "test-persona",
      },
    ];
    mockSelectedOrgs = [
      { id: "org-plivo", outboundNumber: "+911140001234", telephonyProvider: "plivo" },
    ];

    await executeDueScheduledCalls();

    expect(lastPlivoParams).toBeDefined();
    expect(lastPlivoParams.orgId).toBe("org-plivo");
    expect(lastPlivoParams.to).toBe("+919876543210");
    expect(lastPlivoParams.from).toBe("+911140001234");
    // The bug this covers: the sweep used to fall through to Twilio for every
    // org regardless of provider.
    expect(lastTwilioCallParams).toBeNull();
  });

  it("routes an Exotel org's scheduled call through Exotel, not Twilio (F1)", async () => {
    mockScheduledCallRows = [
      {
        id: 1,
        toNumber: "+919876543210",
        orgId: "org-exotel",
        attempt: 1,
        maxAttempts: 2,
        workflowName: "test-workflow",
        persona: "test-persona",
      },
    ];
    mockSelectedOrgs = [
      { id: "org-exotel", outboundNumber: "+911140005678", telephonyProvider: "exotel" },
    ];

    await executeDueScheduledCalls();

    expect(lastExotelParams).toBeDefined();
    expect(lastExotelParams.orgId).toBe("org-exotel");
    expect(lastExotelParams.to).toBe("+919876543210");
    expect(lastExotelParams.from).toBe("+911140005678");
    expect(lastTwilioCallParams).toBeNull();
  });
});
