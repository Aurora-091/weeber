import { describe, it, expect, afterEach } from "bun:test";
import { syncToHubspot } from "./hubspot";
import { __resetBreakersForTests } from "./resilient-fetch";

const originalFetch = global.fetch;
const originalKey = process.env.HUBSPOT_API_KEY;

describe("syncToHubspot", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.HUBSPOT_API_KEY;
    else process.env.HUBSPOT_API_KEY = originalKey;
    __resetBreakersForTests();
  });

  it("returns a clear not-configured result when HUBSPOT_API_KEY is unset", async () => {
    delete process.env.HUBSPOT_API_KEY;
    const result = await syncToHubspot("+15551234567", "Jamie", "Called about pricing");
    expect(result.synced).toBe(false);
    if (!result.synced) expect(result.message).toContain("not configured");
  });

  it("returns synced:true with the contact id on a successful call", async () => {
    process.env.HUBSPOT_API_KEY = "test-key";
    let callCount = 0;
    global.fetch = (async () => {
      callCount += 1;
      return new Response(JSON.stringify({ id: "contact-123" }), { status: 200 });
    }) as typeof fetch;

    const result = await syncToHubspot("+15551234567", "Jamie", "Called about pricing");
    expect(result).toEqual({ synced: true, contactId: "contact-123" });
    expect(callCount).toBe(2); // contact upsert + call log
  });

  it("degrades to synced:false without throwing when the API is down", async () => {
    process.env.HUBSPOT_API_KEY = "test-key";
    global.fetch = (async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;

    const result = await syncToHubspot("+15551234567", "Jamie", "Called about pricing");
    expect(result.synced).toBe(false);
    if (!result.synced) expect(result.message).toContain("HubSpot sync failed");
  });
});
