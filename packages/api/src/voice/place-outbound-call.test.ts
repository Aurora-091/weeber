import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * First tests for place-outbound-call.ts. Focus: the TwiML/answer URL each
 * provider is handed, because that URL is the only thing that tells
 * /incoming an inbound-looking webhook is actually a call we placed. The
 * session is written by this function's *callers*, after it returns
 * (voice/routes.ts, workflows/scheduler.ts), so on an instant answer the
 * webhook can beat the session — and without the org in the URL that call
 * lands as a plain inbound one with no org, no persona and the wrong
 * direction.
 */

let orgRows: Record<string, unknown>[] = [];
let phoneRows: Record<string, unknown>[] = [];
let agentConfigRows: Record<string, unknown>[] = [];
let lastTwilioCreate: Record<string, unknown> | null = null;
let lastPlivoInput: Record<string, unknown> | null = null;

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  return promise;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        if (name === "orgs") return thenable(orgRows);
        if (name === "org_phone_numbers") return thenable(phoneRows);
        if (name === "org_agent_configs") return thenable(agentConfigRows);
        return thenable([]);
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

mock.module("./twilio-client", () => ({
  getPublicUrl: () => "https://api.weeber.test",
  getWsUrl: () => "wss://api.weeber.test",
  getTwilioClientForOrg: async () => ({
    calls: {
      create: async (params: Record<string, unknown>) => {
        lastTwilioCreate = params;
        return { sid: "CA_placed", status: "queued" };
      },
    },
  }),
}));

mock.module("./plivo-client", () => ({
  createPlivoOutboundCall: async (input: Record<string, unknown>) => {
    lastPlivoInput = input;
    return { ok: true, requestUuid: "RU_placed" };
  },
}));

mock.module("./exotel-client", () => ({
  createExotelOutboundCall: async () => ({ ok: true, callSid: "EX_placed" }),
}));

const { placeOutboundCall } = await import("./place-outbound-call");

describe("placeOutboundCall — the org must survive in the answer URL", () => {
  beforeEach(() => {
    orgRows = [];
    phoneRows = [];
    agentConfigRows = [];
    lastTwilioCreate = null;
    lastPlivoInput = null;
    process.env.TWILIO_PHONE_NUMBER = "+15551112222";
  });

  it("stamps the org into the Twilio TwiML URL", async () => {
    orgRows = [{ id: "org-shop", outboundNumber: "+15559998888", telephonyProvider: "twilio" }];

    const result = await placeOutboundCall({ orgId: "org-shop", to: "+15557776666" });

    expect(result.ok).toBe(true);
    expect(lastTwilioCreate!.url).toBe("https://api.weeber.test/api/voice/incoming?orgId=org-shop");
  });

  it("percent-encodes the org id rather than splicing it in raw", async () => {
    orgRows = [{ id: "org shop&x", outboundNumber: "+15559998888", telephonyProvider: "twilio" }];

    await placeOutboundCall({ orgId: "org shop&x", to: "+15557776666" });

    expect(lastTwilioCreate!.url).toBe("https://api.weeber.test/api/voice/incoming?orgId=org%20shop%26x");
  });

  it("omits the query entirely for a call with no org (single-tenant/self-hosted)", async () => {
    const result = await placeOutboundCall({ to: "+15557776666" });

    expect(result.ok).toBe(true);
    expect(lastTwilioCreate!.url).toBe("https://api.weeber.test/api/voice/incoming");
  });

  it("keeps the status/recording callbacks query-free, since only the answer URL needs the org", async () => {
    orgRows = [{ id: "org-shop", outboundNumber: "+15559998888", telephonyProvider: "twilio" }];

    await placeOutboundCall({ orgId: "org-shop", to: "+15557776666" });

    expect(lastTwilioCreate!.statusCallback).toBe("https://api.weeber.test/api/voice/status-callback");
    expect(lastTwilioCreate!.recordingStatusCallback).toBe("https://api.weeber.test/api/voice/recording-status");
  });

  it("still stamps the org into Plivo's answer URL (the pattern Twilio now matches)", async () => {
    orgRows = [{ id: "org-india", outboundNumber: "+919999900000", telephonyProvider: "plivo" }];

    const result = await placeOutboundCall({ orgId: "org-india", to: "+919999911111" });

    expect(result.ok).toBe(true);
    expect(lastPlivoInput!.answerUrl).toBe(
      "https://api.weeber.test/api/voice/incoming/plivo?orgId=org-india",
    );
  });
});
