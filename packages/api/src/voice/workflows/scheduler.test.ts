import { mock, describe, it, expect, beforeEach } from "bun:test";

let mockScheduledCallRows: any[] = [];
let mockSelectedOrgs: any[] = [];
let lastTwilioCallParams: any = null;

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
});
