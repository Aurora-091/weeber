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

  it("creates a new contact (search finds none) then logs a note, on a successful call", async () => {
    process.env.HUBSPOT_API_KEY = "test-key";
    let callCount = 0;
    global.fetch = (async (url: string) => {
      callCount += 1;
      // Mock the search endpoint returning no existing contact, so the real
      // code path is search (miss) -> create -> log note = 3 calls, not the
      // old create-only path's 2.
      if (String(url).includes("/search")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "contact-123" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await syncToHubspot("+15551234567", "Jamie", "Called about pricing");
    expect(result).toEqual({ synced: true, contactId: "contact-123" });
    expect(callCount).toBe(3); // search (miss) + create contact + log note
  });

  it("reuses an existing contact found via search instead of creating a duplicate", async () => {
    process.env.HUBSPOT_API_KEY = "test-key";
    let callCount = 0;
    global.fetch = (async (url: string) => {
      callCount += 1;
      if (String(url).includes("/search")) {
        return new Response(JSON.stringify({ results: [{ id: "existing-456" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "should-not-be-used" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await syncToHubspot("+15551234567", "Jamie", "Called about pricing");
    expect(result).toEqual({ synced: true, contactId: "existing-456" });
    expect(callCount).toBe(2); // search (hit) + log note — no create call
  });

  it("degrades to synced:false without throwing when the API is down", async () => {
    process.env.HUBSPOT_API_KEY = "test-key";
    global.fetch = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    const result = await syncToHubspot("+15551234567", "Jamie", "Called about pricing");
    expect(result.synced).toBe(false);
    if (!result.synced) expect(result.message).toContain("HubSpot sync failed");
  });
});
