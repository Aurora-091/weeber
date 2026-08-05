import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * /incoming must attribute a genuinely INBOUND call to the org that owns the
 * dialled number. It previously wrote `orgId: session?.orgId ?? null`, and an
 * inbound call has no session to read — so every inbound call landed with
 * `orgId: null`, which downstream costs it caller memory, org feature flags,
 * the org's own persona and CRM sync (see org-attribution.ts).
 *
 * This drives the real Hono route, so it also covers the wiring — that the
 * lookup actually runs on the deferred insert path, not just that the helper
 * works in isolation.
 */

delete process.env.ADMIN_API_KEY;
delete process.env.WEBHOOK_URL;

let orgRows: { orgId: string; number: string | null }[] = [];
let phoneRows: { orgId: string; number: string; status: string }[] = [];
let insertedCalls: Record<string, unknown>[] = [];
let bumpedOrgIds: (string | null | undefined)[] = [];

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table) ?? "";
        const rows = name === "orgs" ? orgRows : name === "org_phone_numbers" ? phoneRows : [];
        const result = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
        result.where = () => {
          const withLimit = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
          withLimit.limit = () => Promise.resolve(rows);
          return withLimit;
        };
        return result;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (getTableName(table) === "calls") insertedCalls.push(values);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
    execute: async () => [],
  },
}));

mock.module("./twilio-client", () => ({
  twilioClient: {},
  getWsUrl: () => "wss://api.weeber.test",
  getPublicUrl: () => "https://api.weeber.test",
  getTwilioClientForOrg: async () => ({}),
}));

// The real signature check needs a Twilio-signed request; this stands in for
// it and hands the route the same parsed body shape it produces.
mock.module("./middleware/twilio-signature", () => ({
  requireTwilioSignature: async (c: any, next: any) => {
    const body = await c.req.parseBody();
    c.set("twilioBody", body);
    await next();
  },
}));

mock.module("./middleware/admin-auth", () => ({
  requireAdminKey: async (_c: any, next: any) => {
    await next();
  },
}));

mock.module("./middleware/rate-limit", () => ({
  rateLimitOutboundCalls: async (_c: any, next: any) => {
    await next();
  },
}));

mock.module("../app/org-activity", () => ({
  bumpOrgActivity: (orgId: string | null | undefined) => {
    bumpedOrgIds.push(orgId);
  },
}));

const { voice } = await import("./routes");
const { sessionStore } = await import("./session-store");

const ORG_NUMBER = "+15551110000";
const CALLER = "+919999999999";

async function postIncoming(callSid: string, to = ORG_NUMBER, from = CALLER, query = "") {
  const res = await voice.request(`/incoming${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CallSid: callSid, From: from, To: to }).toString(),
  });
  expect(res.status).toBe(200);
  // The `calls` insert is deliberately fire-and-forget so it can't delay the
  // TwiML response (and therefore Twilio's <Connect><Stream> handshake) —
  // give that deferred chain its microtasks before asserting on it.
  for (let i = 0; i < 50 && insertedCalls.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return insertedCalls[0];
}

describe("/incoming — inbound call org attribution", () => {
  beforeEach(() => {
    orgRows = [];
    phoneRows = [];
    insertedCalls = [];
    bumpedOrgIds = [];
  });

  it("attributes an inbound call to the org that owns the dialled number", async () => {
    phoneRows = [{ orgId: "org-shop", number: ORG_NUMBER, status: "active" }];

    const row = await postIncoming("CA_inbound_provisioned");

    expect(row).toBeDefined();
    expect(row!.orgId).toBe("org-shop");
    expect(row!.direction).toBe("inbound");
    expect(row!.toNumber).toBe(ORG_NUMBER);
  });

  it("attributes an inbound call on a legacy orgs.outboundNumber too", async () => {
    orgRows = [{ orgId: "org-legacy", number: ORG_NUMBER }];

    const row = await postIncoming("CA_inbound_legacy");

    expect(row!.orgId).toBe("org-legacy");
  });

  it("heartbeats the resolved org, not just an org that arrived on a session", async () => {
    phoneRows = [{ orgId: "org-shop", number: ORG_NUMBER, status: "active" }];

    await postIncoming("CA_inbound_heartbeat");

    expect(bumpedOrgIds).toContain("org-shop");
  });

  it("still inserts the call with a null org when no org owns the dialled number", async () => {
    const row = await postIncoming("CA_inbound_unknown", "+15550001111");

    expect(row).toBeDefined();
    expect(row!.orgId).toBeNull();
  });

  it("trusts a signature-covered ?orgId= from an outbound call's answer URL when the session write lost the race", async () => {
    // place-outbound-call.ts stamps the org into the Twilio answer URL, but
    // our callers only write the session *after* placeOutboundCall returns.
    // On an instant answer this webhook can arrive first — with no session at
    // all — and the call must still be attributed and marked outbound.
    phoneRows = [];

    const row = await postIncoming("CA_url_org", "+15557776666", ORG_NUMBER, "?orgId=org-placed");

    expect(row!.orgId).toBe("org-placed");
    expect(row!.direction).toBe("outbound");
  });

  it("prefers ?orgId= over a number lookup that would attribute the call to the customer's org", async () => {
    // Worst case of relying on the number alone: we dial a customer who
    // themselves happen to be one of our orgs, so `To` resolves to *their*
    // org rather than the one that placed the call.
    phoneRows = [{ orgId: "org-customer", number: "+15557776666", status: "active" }];

    const row = await postIncoming("CA_url_org_wins", "+15557776666", ORG_NUMBER, "?orgId=org-placed");

    expect(row!.orgId).toBe("org-placed");
  });

  it("lets an outbound call's session org win over the number lookup", async () => {
    // The dialled number belongs to a different org than the session says —
    // the session is authoritative here, because we placed this call and
    // stamped it ourselves (`To` is the customer, not our own number).
    phoneRows = [{ orgId: "org-wrong", number: ORG_NUMBER, status: "active" }];
    await sessionStore.set("CA_outbound_session", {
      callSid: "CA_outbound_session",
      direction: "outbound",
      orgId: "org-placed",
    } as any);

    const row = await postIncoming("CA_outbound_session");

    expect(row!.orgId).toBe("org-placed");
    expect(row!.direction).toBe("outbound");
  });
});
