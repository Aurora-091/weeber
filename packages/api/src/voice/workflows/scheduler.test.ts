import { mock, describe, it, expect, beforeEach } from "bun:test";

let mockScheduledCallRows: any[] = [];
let mockSelectedOrgs: any[] = [];
let lastTwilioCallParams: any = null;
let lastPlivoParams: any = null;
let lastExotelParams: any = null;
let mockUpdateCalls: { table: string | undefined; data: any }[] = [];
let mockClaimReturning: any[] = [{ id: 1 }];

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
      update: (table: any) => ({
        set: (data: any) => {
          const tableName = getTableName(table);
          mockUpdateCalls.push({ table: tableName, data });
          return {
            where: () => ({
              returning: () => (data.status === "claimed" ? mockClaimReturning : [{ id: 1 }])
            })
          };
        }
      }),
      // credential-vault.ts's readCredential() (used by getTwilioClientForOrg,
      // called from this scheduler's own outbound-call path) calls
      // db.execute() — no row means it falls through to the plaintext-column
      // path this mock's `select` above already covers via the "orgs" table.
      execute: async () => []
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

let mockDncResult = false;
let mockCallingWindowResult: { allowed: boolean; reason?: string } = { allowed: true };

mock.module("@openvent/compliance", () => {
  return {
    isOnDoNotCallList: async () => mockDncResult,
    checkCallingWindow: () => mockCallingWindowResult
  };
});

mock.module("../../../../openvent-compliance/src/index", () => {
  return {
    isOnDoNotCallList: async () => mockDncResult,
    checkCallingWindow: () => mockCallingWindowResult
  };
});

import { executeDueScheduledCalls, callScheduledRowNow } from "./scheduler";

describe("Scheduler - Outbound Caller ID resolution", () => {
  beforeEach(() => {
    mockScheduledCallRows = [];
    mockSelectedOrgs = [];
    lastTwilioCallParams = null;
    lastPlivoParams = null;
    lastExotelParams = null;
    mockDncResult = false;
    mockCallingWindowResult = { allowed: true };
    mockUpdateCalls = [];
    mockClaimReturning = [{ id: 1 }];
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

describe("Scheduler — DNC and calling-window gates (sweep)", () => {
  beforeEach(() => {
    mockScheduledCallRows = [];
    mockSelectedOrgs = [];
    lastTwilioCallParams = null;
    mockDncResult = false;
    mockCallingWindowResult = { allowed: true };
    mockUpdateCalls = [];
    mockClaimReturning = [{ id: 1 }];
    process.env.TWILIO_PHONE_NUMBER = "+15551112222";
  });

  it("cancels (not defers) a call to a number on the DNC list", async () => {
    mockScheduledCallRows = [
      { id: 1, toNumber: "+15557776666", orgId: "org-123", attempt: 1, maxAttempts: 2, workflowName: "test-workflow", persona: "test-persona" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888" }];
    mockDncResult = true;

    await executeDueScheduledCalls();

    expect(lastTwilioCallParams).toBeNull();
    const cancelUpdate = mockUpdateCalls.find((u) => u.table === "scheduled_calls" && u.data.status === "canceled");
    expect(cancelUpdate).toBeDefined();
    // The block reason must be persisted so the Orders page can show WHY.
    expect(cancelUpdate!.data.lastBlockReason).toBe("dnc");
    expect(typeof cancelUpdate!.data.lastBlockDetail).toBe("string");
    expect(cancelUpdate!.data.blockedAt).toBeInstanceOf(Date);
  });

  it("defers (requeues +30min, status back to pending) a call blocked by the calling window", async () => {
    mockScheduledCallRows = [
      { id: 1, toNumber: "+917499291834", orgId: "org-123", attempt: 1, maxAttempts: 2, workflowName: "shopify-cod-confirmation", persona: "test-persona" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888", callingWindowTestModeUntil: null }];
    mockCallingWindowResult = { allowed: false, reason: "outside TRAI-permitted calling window" };

    await executeDueScheduledCalls();

    expect(lastTwilioCallParams).toBeNull();
    const deferUpdate = mockUpdateCalls.find((u) => u.table === "scheduled_calls" && u.data.status === "pending" && u.data.runAt);
    expect(deferUpdate).toBeDefined();
    // A deferred call carries its block reason so a "pending" row can still
    // explain why it hasn't gone out yet (outside the calling window).
    expect(deferUpdate!.data.lastBlockReason).toBe("calling_window");
    expect(typeof deferUpdate!.data.lastBlockDetail).toBe("string");
    expect(deferUpdate!.data.blockedAt).toBeInstanceOf(Date);
  });

  it("clears any prior block reason when a scheduled call finally succeeds", async () => {
    mockScheduledCallRows = [
      { id: 1, toNumber: "+15557776666", orgId: "org-123", attempt: 1, maxAttempts: 2, workflowName: "shopify-cart-recovery", persona: "test-persona", lastBlockReason: "calling_window", lastBlockDetail: "outside window" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888" }];

    await executeDueScheduledCalls();

    const executedUpdate = mockUpdateCalls.find((u) => u.table === "scheduled_calls" && u.data.status === "executed");
    expect(executedUpdate).toBeDefined();
    // A deferred-then-succeeded row must not keep showing a stale reason.
    expect(executedUpdate!.data.lastBlockReason).toBeNull();
    expect(executedUpdate!.data.lastBlockDetail).toBeNull();
    expect(executedUpdate!.data.blockedAt).toBeNull();
  });

  // Regression coverage for the 2026-07-16 "turn off compliance for testing"
  // feature: an org with an active (non-expired) callingWindowTestModeUntil
  // bypasses ONLY the calling-window check — the call still places even
  // though checkCallingWindow itself says blocked.
  it("bypasses the calling-window block when the org's test mode is active and not yet expired", async () => {
    mockScheduledCallRows = [
      { id: 1, toNumber: "+917499291834", orgId: "org-123", attempt: 1, maxAttempts: 2, workflowName: "shopify-cod-confirmation", persona: "test-persona" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888", callingWindowTestModeUntil: new Date(Date.now() + 60 * 60 * 1000) }];
    mockCallingWindowResult = { allowed: false, reason: "outside TRAI-permitted calling window" };

    await executeDueScheduledCalls();

    expect(lastTwilioCallParams).toBeDefined();
    expect(lastTwilioCallParams.to).toBe("+917499291834");
  });

  it("does NOT bypass the calling-window block once the org's test mode has expired", async () => {
    mockScheduledCallRows = [
      { id: 1, toNumber: "+917499291834", orgId: "org-123", attempt: 1, maxAttempts: 2, workflowName: "shopify-cod-confirmation", persona: "test-persona" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888", callingWindowTestModeUntil: new Date(Date.now() - 60 * 60 * 1000) }];
    mockCallingWindowResult = { allowed: false, reason: "outside TRAI-permitted calling window" };

    await executeDueScheduledCalls();

    expect(lastTwilioCallParams).toBeNull();
  });

  // DNC is never bypassed by test mode, no exceptions — explicit decision.
  it("still enforces DNC even when the org's calling-window test mode is active", async () => {
    mockScheduledCallRows = [
      { id: 1, toNumber: "+917499291834", orgId: "org-123", attempt: 1, maxAttempts: 2, workflowName: "shopify-cod-confirmation", persona: "test-persona" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888", callingWindowTestModeUntil: new Date(Date.now() + 60 * 60 * 1000) }];
    mockDncResult = true;

    await executeDueScheduledCalls();

    expect(lastTwilioCallParams).toBeNull();
    expect(mockUpdateCalls.some((u) => u.table === "scheduled_calls" && u.data.status === "canceled")).toBe(true);
  });
});

describe("callScheduledRowNow — manual call-now button", () => {
  beforeEach(() => {
    mockScheduledCallRows = [];
    mockSelectedOrgs = [];
    lastTwilioCallParams = null;
    mockDncResult = false;
    mockCallingWindowResult = { allowed: true };
    mockUpdateCalls = [];
    mockClaimReturning = [{ id: 1 }];
    process.env.TWILIO_PHONE_NUMBER = "+15551112222";
  });

  it("places the call immediately, skipping run_at entirely, and marks it executed", async () => {
    mockScheduledCallRows = [
      { id: 5, orgId: "org-123", toNumber: "+15557776666", status: "pending", workflowName: "shopify-cart-recovery", persona: "test-persona", attempt: 1, maxAttempts: 2 },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888" }];

    const result = await callScheduledRowNow("org-123", 5);

    expect(result.ok).toBe(true);
    expect(lastTwilioCallParams).toBeDefined();
    expect(mockUpdateCalls.some((u) => u.table === "scheduled_calls" && u.data.status === "executed")).toBe(true);
  });

  it("returns 404-shaped not-found when the row doesn't belong to this org", async () => {
    mockScheduledCallRows = [];
    const result = await callScheduledRowNow("org-123", 999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(409);
  });

  it("refuses to re-call a row that's already executed", async () => {
    mockScheduledCallRows = [
      { id: 5, orgId: "org-123", toNumber: "+15557776666", status: "executed", workflowName: "shopify-cart-recovery" },
    ];
    const result = await callScheduledRowNow("org-123", 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(409);
    expect(lastTwilioCallParams).toBeNull();
  });

  it("blocks on DNC with 403 and cancels the row permanently — no bypass for manual calls either", async () => {
    mockScheduledCallRows = [
      { id: 5, orgId: "org-123", toNumber: "+15557776666", status: "pending", workflowName: "shopify-cart-recovery" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888" }];
    mockDncResult = true;

    const result = await callScheduledRowNow("org-123", 5);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(403);
    expect(mockUpdateCalls.some((u) => u.table === "scheduled_calls" && u.data.status === "canceled")).toBe(true);
    expect(lastTwilioCallParams).toBeNull();
  });

  it("blocks on calling-window with 409 and releases the row back to pending (not lost, sweep can still pick it up)", async () => {
    mockScheduledCallRows = [
      { id: 5, orgId: "org-123", toNumber: "+917499291834", status: "pending", workflowName: "shopify-cod-confirmation" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888", callingWindowTestModeUntil: null }];
    mockCallingWindowResult = { allowed: false, reason: "outside TRAI-permitted calling window" };

    const result = await callScheduledRowNow("org-123", 5);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(409);
    const releaseUpdate = mockUpdateCalls.find((u) => u.table === "scheduled_calls" && u.data.status === "pending");
    expect(releaseUpdate).toBeDefined();
    expect(lastTwilioCallParams).toBeNull();
  });

  it("respects the org's active calling-window test mode for a manual call too", async () => {
    mockScheduledCallRows = [
      { id: 5, orgId: "org-123", toNumber: "+917499291834", status: "pending", workflowName: "shopify-cod-confirmation" },
    ];
    mockSelectedOrgs = [{ id: "org-123", outboundNumber: "+15559998888", callingWindowTestModeUntil: new Date(Date.now() + 60 * 60 * 1000) }];
    mockCallingWindowResult = { allowed: false, reason: "outside TRAI-permitted calling window" };

    const result = await callScheduledRowNow("org-123", 5);

    expect(result.ok).toBe(true);
    expect(lastTwilioCallParams).toBeDefined();
  });
});
