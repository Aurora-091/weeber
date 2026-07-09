import { describe, it, expect, afterEach } from "bun:test";
import { syncToGoHighLevel } from "./gohighlevel";
import { __resetBreakersForTests } from "./resilient-fetch";

const originalFetch = global.fetch;
const originalKey = process.env.GOHIGHLEVEL_API_KEY;
const originalLocation = process.env.GOHIGHLEVEL_LOCATION_ID;

describe("syncToGoHighLevel", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOHIGHLEVEL_API_KEY;
    else process.env.GOHIGHLEVEL_API_KEY = originalKey;
    if (originalLocation === undefined) delete process.env.GOHIGHLEVEL_LOCATION_ID;
    else process.env.GOHIGHLEVEL_LOCATION_ID = originalLocation;
    __resetBreakersForTests();
  });

  it("returns not-configured when either API key or location id is missing", async () => {
    delete process.env.GOHIGHLEVEL_API_KEY;
    delete process.env.GOHIGHLEVEL_LOCATION_ID;
    const result = await syncToGoHighLevel("+15551234567", "Jamie", "notes");
    expect(result.synced).toBe(false);
    if (!result.synced) expect(result.message).toContain("not configured");
  });

  it("upserts a contact and logs a note when configured", async () => {
    process.env.GOHIGHLEVEL_API_KEY = "test-key";
    process.env.GOHIGHLEVEL_LOCATION_ID = "loc-1";
    let callCount = 0;
    global.fetch = (async (url: string) => {
      callCount += 1;
      if (String(url).includes("upsert")) {
        return new Response(JSON.stringify({ contact: { id: "ghl-contact-1" } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await syncToGoHighLevel("+15551234567", "Jamie", "notes");
    expect(result).toEqual({ synced: true, contactId: "ghl-contact-1" });
    expect(callCount).toBe(2);
  });
});
