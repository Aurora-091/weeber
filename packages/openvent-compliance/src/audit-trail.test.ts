import { describe, it, expect } from "bun:test";
import {
  buildCallAuditRecord,
  buildPhoneNumberAuditTrail,
  renderAuditTrailText,
  type CallAuditStorageAdapter,
} from "./audit-trail";
import { createMemoryDncAdapter } from "./adapters/memory";

const DISCLOSURE_TEXT =
  "Quick heads up before we start — this call may be recorded, and you're speaking with an AI assistant.";

function createMemoryAuditStorage(): CallAuditStorageAdapter & {
  seedCall: (call: Awaited<ReturnType<CallAuditStorageAdapter["getCall"]>>) => void;
  seedTranscript: (callId: string, turns: { role: "caller" | "agent"; text: string; at: Date }[]) => void;
} {
  const calls = new Map<string, NonNullable<Awaited<ReturnType<CallAuditStorageAdapter["getCall"]>>>>();
  const transcripts = new Map<string, { role: "caller" | "agent"; text: string; at: Date }[]>();

  return {
    seedCall(call) {
      if (call) calls.set(call.callId, call);
    },
    seedTranscript(callId, turns) {
      transcripts.set(callId, turns);
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
  };
}

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

describe("renderAuditTrailText", () => {
  it("returns a clear message for an empty result set", () => {
    expect(renderAuditTrailText([])).toBe("No calls found for this query.");
  });

  it("renders a readable record including transcript, disposition, and DNC status", () => {
    const text = renderAuditTrailText([
      {
        callId: "1",
        direction: "outbound",
        fromNumber: "+15551110000",
        toNumber: "+15559998888",
        startedAt: new Date("2026-07-06T10:00:00Z"),
        endedAt: new Date("2026-07-06T10:05:00Z"),
        status: "completed",
        disposition: "interested",
        disclosureConfirmed: true,
        disclosureText: "Hi there",
        disclosureVersion: "en",
        transcript: [{ role: "agent", text: "Hi there", at: new Date("2026-07-06T10:00:01Z") }],
        dncStatus: { isListed: false },
      },
    ]);
    expect(text).toContain("Call 1 of 1");
    expect(text).toContain("Disposition: interested");
    expect(text).toContain("disclosure spoken: yes");
    expect(text).toContain("variant: en");
    expect(text).toContain("not listed");
    expect(text).toContain("Hi there");
  });

  it("clearly flags an unconfirmed disclosure and a DNC-listed number", () => {
    const text = renderAuditTrailText([
      {
        callId: "2",
        direction: "outbound",
        fromNumber: "+15551110000",
        toNumber: "+15559998888",
        startedAt: new Date(),
        endedAt: null,
        status: "failed",
        disposition: null,
        disclosureConfirmed: false,
        disclosureText: null,
        disclosureVersion: null,
        transcript: [],
        dncStatus: { isListed: true, reason: "opted out", addedAt: new Date("2026-06-01T00:00:00Z") },
      },
    ]);
    expect(text).toContain("NOT CONFIRMED");
    expect(text).toContain("ON THE LIST");
    expect(text).toContain("opted out");
  });

  it("uses the call's own persisted disclosure wording for the spoken check, not the fallback", async () => {
    const storage = createMemoryAuditStorage();
    const dnc = createMemoryDncAdapter();
    const hindiLine = "शुरू करने से पहले एक छोटी सी बात — यह कॉल रिकॉर्ड की जा सकती है, और आप एक एआई असिस्टेंट से बात कर रहे हैं।";
    storage.seedCall({
      callId: "9",
      direction: "outbound",
      fromNumber: "+919000000000",
      toNumber: "+919111111111",
      startedAt: new Date(),
      endedAt: new Date(),
      status: "completed",
      disposition: null,
      disclosureText: hindiLine,
      disclosureVersion: "hi",
    });
    // Agent spoke the Hindi line; the English fallback would NOT match it.
    storage.seedTranscript("9", [{ role: "agent", text: hindiLine, at: new Date() }]);

    const record = await buildCallAuditRecord("9", storage, dnc, DISCLOSURE_TEXT);
    expect(record!.disclosureConfirmed).toBe(true);
    expect(record!.disclosureVersion).toBe("hi");
    expect(record!.disclosureText).toBe(hindiLine);
  });
});
