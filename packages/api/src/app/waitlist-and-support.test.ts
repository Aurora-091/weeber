import { mock, describe, it, expect, beforeEach } from "bun:test";
import { waitlistSignups, supportTickets } from "../database/schema";

let mockSelectResult: any[] = [];
let mockInserted: any[] = [];
let mockUpdated: any[] = [];

mock.module("../database", () => {
  return {
    db: {
      select: (fields?: any) => {
        const chain: any = {
          from: () => chain,
          where: () => chain,
          limit: () => chain,
          orderBy: () => chain,
          then: (resolve: any) => {
            if (fields && fields.value) {
              // Return a count wrapper
              return resolve([{ value: mockSelectResult.length }]);
            }
            return resolve(mockSelectResult);
          },
        };
        return chain;
      },
      insert: (table: any) => ({
        values: (data: any) => {
          const insertedRow = {
            id: 42,
            createdAt: new Date(),
            updatedAt: new Date(),
            referralCount: 0,
            unsubscribed: false,
            status: "open",
            ownReferralCode: "weeber-mock123",
            unsubscribeToken: "unsub-mock123",
            ...data,
          };
          mockInserted.push({ table, data: insertedRow });
          return {
            returning: () => Promise.resolve([insertedRow]),
          };
        },
      }),
      update: (table: any) => ({
        set: (data: any) => ({
          where: (cond: any) => {
            mockUpdated.push({ table, data });
            return {
              returning: () => Promise.resolve([{ id: 42, ...data }]),
            };
          },
        }),
      }),
    },
  };
});

import { joinWaitlist, addWaitlistPhone, getWaitlistDisplayCount, unsubscribeByToken } from "./waitlist";
import { submitSupportTicket, listSupportTickets, updateSupportTicketStatus } from "./support";
import { publicRoutes } from "./public-routes";

describe("Waitlist Service", () => {
  beforeEach(() => {
    mockSelectResult = [];
    mockInserted = [];
    mockUpdated = [];
  });

  it("handles new waitlist signup", async () => {
    // 1. Existing email check returns nothing
    mockSelectResult = [];

    const res = await joinWaitlist({ email: "test@example.com", name: "Alice" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyJoined).toBe(false);
      expect(res.ownReferralCode).toStartWith("weeber-");
    }
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0].data.email).toBe("test@example.com");
  });

  it("prevents duplicate waitlist signups", async () => {
    // 1. Existing email check returns match
    mockSelectResult = [{ id: 42, ownReferralCode: "weeber-existing" }];

    const res = await joinWaitlist({ email: "test@example.com" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyJoined).toBe(true);
      expect(res.ownReferralCode).toBe("weeber-existing");
    }
    expect(mockInserted).toHaveLength(0);
  });

  it("saves waitlist phone number", async () => {
    const success = await addWaitlistPhone("test@example.com", "+1234567890");
    expect(success).toBe(true);
    expect(mockUpdated).toHaveLength(1);
    expect(mockUpdated[0].data.phone).toBe("+1234567890");
  });

  it("resolves waitlist display count with offset", async () => {
    mockSelectResult = new Array(5); // 5 users
    const count = await getWaitlistDisplayCount();
    expect(count).toBe(45); // 40 offset + 5 signups
  });

  it("marks waitlist unsubscribed by token", async () => {
    mockSelectResult = [{ id: 42, unsubscribed: false }];
    const status = await unsubscribeByToken("unsub-token-123");
    expect(status).toBe("unsubscribed");
    expect(mockUpdated).toHaveLength(1);
    expect(mockUpdated[0].data.unsubscribed).toBe(true);
  });
});

describe("Support Service", () => {
  beforeEach(() => {
    mockSelectResult = [];
    mockInserted = [];
    mockUpdated = [];
  });

  it("submits a support ticket", async () => {
    const ticket = await submitSupportTicket({ email: "test@example.com", subject: "Help", message: "Broken" });
    expect(ticket).toBeDefined();
    expect(ticket?.subject).toBe("Help");
    expect(mockInserted).toHaveLength(1);
  });

  it("updates support ticket status", async () => {
    const ticket = await updateSupportTicketStatus(100, "resolved");
    expect(ticket).toBeDefined();
    expect(ticket?.status).toBe("resolved");
    expect(mockUpdated).toHaveLength(1);
  });
});

describe("Public routes", () => {
  beforeEach(() => {
    mockSelectResult = [];
    mockInserted = [];
    mockUpdated = [];
  });

  it("POST /waitlist rejects invalid input", async () => {
    const res = await publicRoutes.request("/waitlist", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /waitlist accepts valid email", async () => {
    const res = await publicRoutes.request("/waitlist", {
      method: "POST",
      body: JSON.stringify({ email: "join@example.com" }),
    });
    expect(res.status).toBe(201);
  });

  it("POST /support accepts ticket details", async () => {
    const res = await publicRoutes.request("/support", {
      method: "POST",
      body: JSON.stringify({ email: "hi@example.com", subject: "Inquiry", message: "Nice tool" }),
    });
    expect(res.status).toBe(201);
  });
});
