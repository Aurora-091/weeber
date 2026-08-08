import { describe, it, expect } from "bun:test";
import {
  buildCallAuditRecord,
  buildPhoneNumberAuditTrail,
  renderAuditTrailText,
  tierForPurpose,
  type CallAuditRecord,
  type CallAuditStorageAdapter,
  type CallOptOutEvent,
  type ConsentAdapterFactory,
} from "./audit-trail";
import { createMemoryDncAdapter, createMemoryConsentAdapter } from "./adapters/memory";
import type { ConsentRecord } from "./storage";

const DISCLOSURE_TEXT =
  "Quick heads up before we start — this call may be recorded, and you're speaking with an AI assistant.";

function createMemoryAuditStorage(): CallAuditStorageAdapter & {
  seedCall: (call: Awaited<ReturnType<CallAuditStorageAdapter["getCall"]>>) => void;
  seedTranscript: (callId: string, turns: { role: "caller" | "agent"; text: string; at: Date }[]) => void;
  seedOptOut: (callId: string, events: CallOptOutEvent[]) => void;
} {
  const calls = new Map<string, NonNullable<Awaited<ReturnType<CallAuditStorageAdapter["getCall"]>>>>();
  const transcripts = new Map<string, { role: "caller" | "agent"; text: string; at: Date }[]>();
  const optOuts = new Map<string, CallOptOutEvent[]>();

  return {
    seedCall(call) {
      if (call) calls.set(call.callId, call);
    },
    seedTranscript(callId, turns) {
      transcripts.set(callId, turns);
    },
    seedOptOut(callId, events) {
      optOuts.set(callId, events);
    },
    async getCall(callId) {
      return calls.get(callId) ?? null;
    },
    async getTranscript(callId) {
      return transcripts.get(callId) ?? [];
    },
    async findCallsByPhoneNumber(phoneNumber) {
      return [...calls.values()]
        .filter((c) => c.fromNumber === phoneNumber || c.toNumber === phoneNumber)
        .map((c) => ({ callId: c.callId }));
    },
    async getOptOutEvents(callId) {
      return optOuts.get(callId) ?? [];
    },
  };
}

/** A ConsentAdapterFactory backed by a single in-memory consent adapter, ignoring orgId (tests seed per case). */
function factoryFor(records: ConsentRecord[]): ConsentAdapterFactory {
  const adapter = createMemoryConsentAdapter();
  adapter.seed(records);
  return () => adapter;
}

describe("tierForPurpose", () => {
  it("marks marketing and underwriting as PEWC (written) and the rest as PEC (oral)", () => {
    expect(tierForPurpose("marketing")).toBe("PEWC");
    expect(tierForPurpose("underwriting")).toBe("PEWC");
    expect(tierForPurpose("service")).toBe("PEC");
    expect(tierForPurpose("transactional")).toBe("PEC");
    expect(tierForPurpose("feedback")).toBe("PEC");
  });
});

describe("buildCallAuditRecord", () => {
  it("returns null for a call id that doesn't exist", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    const result = await buildCallAuditRecord("nope", storage, dnc, DISCLOSURE_TEXT);
    expect(result).toBeNull();
  });

  it("assembles a full record with transcript, disclosure check, and DNC status", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    storage.seedCall({
      callId: "1",
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15559998888",
      startedAt: new Date("2026-07-06T10:00:00Z"),
      endedAt: new Date("2026-07-06T10:05:00Z"),
      status: "completed",
      disposition: "interested",
    });
    storage.seedTranscript("1", [
      { role: "agent", text: DISCLOSURE_TEXT, at: new Date("2026-07-06T10:00:01Z") },
      { role: "caller", text: "Sure, go ahead.", at: new Date("2026-07-06T10:00:05Z") },
    ]);

    const record = await buildCallAuditRecord("1", storage, dnc, DISCLOSURE_TEXT);
    expect(record).not.toBeNull();
    expect(record!.disclosureConfirmed).toBe(true);
    expect(record!.dncStatus).toEqual({ isListed: false });
    expect(record!.transcript).toHaveLength(2);
    expect(record!.disposition).toBe("interested");
    // No consent factory wired and no opt-out seeded → both empty, and no disclosure fire time recorded.
    expect(record!.consentBasis).toEqual([]);
    expect(record!.optOutEvents).toEqual([]);
    expect(record!.disclosureFiredAt).toBeNull();
  });

  it("flags disclosure as not confirmed when the opening line doesn't match", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    storage.seedCall({
      callId: "2",
      direction: "inbound",
      fromNumber: "+15559998888",
      toNumber: "+15551110000",
      startedAt: new Date(),
      endedAt: new Date(),
      status: "completed",
      disposition: null,
    });
    storage.seedTranscript("2", [{ role: "agent", text: "Hey there, how can I help?", at: new Date() }]);

    const record = await buildCallAuditRecord("2", storage, dnc, DISCLOSURE_TEXT);
    expect(record!.disclosureConfirmed).toBe(false);
  });

  it("flags disclosure as not confirmed when there's no agent turn at all", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    storage.seedCall({
      callId: "3",
      direction: "inbound",
      fromNumber: "+15559998888",
      toNumber: "+15551110000",
      startedAt: new Date(),
      endedAt: null,
      status: "failed",
      disposition: null,
    });
    storage.seedTranscript("3", []);

    const record = await buildCallAuditRecord("3", storage, dnc, DISCLOSURE_TEXT);
    expect(record!.disclosureConfirmed).toBe(false);
  });

  it("surfaces DNC reason and addedAt when the number is listed", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    const addedAt = new Date("2026-06-01T00:00:00Z");
    await dnc.add({ phoneNumber: "+15559998888", reason: "caller requested", source: "agent", addedAt });

    storage.seedCall({
      callId: "4",
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15559998888",
      startedAt: new Date(),
      endedAt: new Date(),
      status: "completed",
      disposition: "not-interested",
    });
    storage.seedTranscript("4", []);

    const record = await buildCallAuditRecord("4", storage, dnc, DISCLOSURE_TEXT);
    expect(record!.dncStatus).toEqual({ isListed: true, reason: "caller requested", addedAt });
  });

  it("reads consent basis from the ledger, scoped to the call's org, resolving tier and active state", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    storage.seedCall({
      callId: "5",
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15559998888",
      startedAt: new Date("2026-07-06T10:00:00Z"),
      endedAt: new Date("2026-07-06T10:05:00Z"),
      status: "completed",
      disposition: "interested",
      orgId: "org_a",
    });
    storage.seedTranscript("5", []);

    const factory = factoryFor([
      {
        dataPrincipal: "+15559998888",
        purpose: "marketing",
        granted: true,
        grantedAt: new Date("2026-03-12T00:00:00Z"),
        version: "cart-recovery-v1",
        channel: "shopify",
        source: "checkout consent checkbox",
      },
    ]);

    const record = await buildCallAuditRecord("5", storage, dnc, DISCLOSURE_TEXT, factory);
    expect(record!.consentBasis).toHaveLength(1);
    const entry = record!.consentBasis[0]!;
    expect(entry.purpose).toBe("marketing");
    expect(entry.tier).toBe("PEWC");
    expect(entry.active).toBe(true);
    expect(entry.channel).toBe("shopify");
    expect(entry.version).toBe("cart-recovery-v1");
  });

  it("leaves consent basis empty when a factory is wired but the call has no org", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    storage.seedCall({
      callId: "6",
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15559998888",
      startedAt: new Date(),
      endedAt: new Date(),
      status: "completed",
      disposition: null,
      orgId: null,
    });
    storage.seedTranscript("6", []);

    const factory = factoryFor([
      {
        dataPrincipal: "+15559998888",
        purpose: "marketing",
        granted: true,
        grantedAt: new Date("2026-03-12T00:00:00Z"),
        version: "v1",
        channel: "shopify",
        source: "checkout",
      },
    ]);

    const record = await buildCallAuditRecord("6", storage, dnc, DISCLOSURE_TEXT, factory);
    expect(record!.consentBasis).toEqual([]);
  });

  it("marks a withdrawn consent as not active and carries withdrawnAt", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    storage.seedCall({
      callId: "7",
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15559998888",
      startedAt: new Date(),
      endedAt: new Date(),
      status: "completed",
      disposition: null,
      orgId: "org_a",
    });
    storage.seedTranscript("7", []);

    const withdrawnAt = new Date("2026-07-01T00:00:00Z");
    const factory = factoryFor([
      {
        dataPrincipal: "+15559998888",
        purpose: "service",
        granted: true,
        grantedAt: new Date("2026-03-12T00:00:00Z"),
        version: "v1",
        channel: "ivr",
        source: "verbal on inbound call",
        withdrawnAt,
      },
    ]);

    const record = await buildCallAuditRecord("7", storage, dnc, DISCLOSURE_TEXT, factory);
    const entry = record!.consentBasis[0]!;
    expect(entry.tier).toBe("PEC");
    expect(entry.active).toBe(false);
    expect(entry.withdrawnAt).toEqual(withdrawnAt);
  });

  it("includes per-call opt-out events and the disclosure fire time from canonical state", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    const firedAt = new Date("2026-07-06T10:00:02Z");
    const optOutAt = new Date("2026-07-06T10:03:00Z");
    storage.seedCall({
      callId: "8",
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15559998888",
      startedAt: new Date("2026-07-06T10:00:00Z"),
      endedAt: new Date("2026-07-06T10:05:00Z"),
      status: "completed",
      disposition: "opted-out",
      orgId: "org_a",
      disclosureFiredAt: firedAt,
    });
    storage.seedTranscript("8", []);
    storage.seedOptOut("8", [
      { firedAt: optOutAt, triggerPhrase: "take me off your list", dncPropagatedAt: null },
    ]);

    const record = await buildCallAuditRecord("8", storage, dnc, DISCLOSURE_TEXT);
    expect(record!.disclosureFiredAt).toEqual(firedAt);
    expect(record!.optOutEvents).toHaveLength(1);
    expect(record!.optOutEvents[0]!.triggerPhrase).toBe("take me off your list");
    expect(record!.optOutEvents[0]!.dncPropagatedAt).toBeNull();
  });
});

describe("buildPhoneNumberAuditTrail", () => {
  it("returns every call involving a number, sorted oldest first", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    storage.seedCall({
      callId: "later",
      direction: "outbound",
      fromNumber: "+15551110000",
      toNumber: "+15559998888",
      startedAt: new Date("2026-07-06T12:00:00Z"),
      endedAt: new Date(),
      status: "completed",
      disposition: null,
    });
    storage.seedCall({
      callId: "earlier",
      direction: "inbound",
      fromNumber: "+15559998888",
      toNumber: "+15551110000",
      startedAt: new Date("2026-07-01T12:00:00Z"),
      endedAt: new Date(),
      status: "completed",
      disposition: null,
    });
    storage.seedTranscript("later", []);
    storage.seedTranscript("earlier", []);

    const trail = await buildPhoneNumberAuditTrail("+15559998888", storage, dnc, DISCLOSURE_TEXT);
    expect(trail.map((r) => r.callId)).toEqual(["earlier", "later"]);
  });

  it("returns an empty array for a number with no calls", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    const trail = await buildPhoneNumberAuditTrail("+15550000000", storage, dnc, DISCLOSURE_TEXT);
    expect(trail).toEqual([]);
  });
});

/** Builds a minimal valid CallAuditRecord for renderer tests, with overrides. */
function makeRecord(overrides: Partial<CallAuditRecord> = {}): CallAuditRecord {
  return {
    callId: "1",
    direction: "outbound",
    fromNumber: "+15551110000",
    toNumber: "+15559998888",
    startedAt: new Date("2026-07-06T10:00:00Z"),
    endedAt: new Date("2026-07-06T10:05:00Z"),
    status: "completed",
    disposition: "interested",
    consentBasis: [],
    disclosureConfirmed: true,
    disclosureFiredAt: null,
    optOutEvents: [],
    transcript: [],
    dncStatus: { isListed: false },
    ...overrides,
  };
}

describe("renderAuditTrailText", () => {
  it("returns a clear message for an empty result set", () => {
    expect(renderAuditTrailText([])).toBe("No calls found for this query.");
  });

  it("renders a readable record including transcript, disposition, and DNC status", () => {
    const text = renderAuditTrailText([
      makeRecord({
        transcript: [{ role: "agent", text: "Hi there", at: new Date("2026-07-06T10:00:01Z") }],
      }),
    ]);
    expect(text).toContain("Call 1 of 1");
    expect(text).toContain("Disposition: interested");
    expect(text).toContain("Spoken: yes");
    expect(text).toContain("not listed");
    expect(text).toContain("Hi there");
  });

  it("shows a plain-language consent basis line with tier and grant date", () => {
    const text = renderAuditTrailText([
      makeRecord({
        consentBasis: [
          {
            purpose: "marketing",
            tier: "PEWC",
            grantedAt: new Date("2026-03-12T00:00:00Z"),
            version: "cart-recovery-v1",
            channel: "shopify",
            source: "checkout consent checkbox",
            active: true,
            withdrawnAt: null,
          },
        ],
      }),
    ]);
    expect(text).toContain("Marketing consent (written / PEWC), granted 12 Mar 2026 — active");
    expect(text).toContain("cart-recovery-v1");
  });

  it("states plainly when no consent is on file", () => {
    const text = renderAuditTrailText([makeRecord({ consentBasis: [] })]);
    expect(text).toContain("No consent record on file for this number under this org.");
  });

  it("renders opt-out events and notes when not yet propagated to DNC", () => {
    const text = renderAuditTrailText([
      makeRecord({
        optOutEvents: [
          {
            firedAt: new Date("2026-07-06T10:03:00Z"),
            triggerPhrase: "take me off your list",
            dncPropagatedAt: null,
          },
        ],
      }),
    ]);
    expect(text).toContain("Caller opted out at 2026-07-06T10:03:00.000Z");
    expect(text).toContain("take me off your list");
    expect(text).toContain("not yet propagated to Do-Not-Call list");
  });

  it("clearly flags an unconfirmed disclosure and a DNC-listed number", () => {
    const text = renderAuditTrailText([
      makeRecord({
        callId: "2",
        endedAt: null,
        status: "failed",
        disposition: null,
        disclosureConfirmed: false,
        dncStatus: { isListed: true, reason: "opted out", addedAt: new Date("2026-06-01T00:00:00Z") },
      }),
    ]);
    expect(text).toContain("NOT CONFIRMED");
    expect(text).toContain("ON THE LIST");
    expect(text).toContain("opted out");
  });
});
