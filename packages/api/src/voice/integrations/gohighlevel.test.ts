import { describe, it, expect, afterEach } from "bun:test";
import { syncToGoHighLevel } from "./gohighlevel";
import { __resetBreakersForTests } from "./resilient-fetch";

const originalFetch = global.fetch;

describe("syncToGoHighLevel", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    __resetBreakersForTests();
  });

  it("returns not-configured when no API key is passed", async () => {
    const result = await syncToGoHighLevel("+15551234567", "Jamie", "notes");
    expect(result.synced).toBe(false);
    if (!result.synced) expect(result.message).toContain("not configured");
  });

  it("upserts a contact and logs a note when configured", async () => {
    let callCount = 0;
    global.fetch = (async (url: string) => {
      callCount += 1;
      if (String(url).includes("upsert")) {
        return new Response(JSON.stringify({ contact: { id: "ghl-contact-1" } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await syncToGoHighLevel("+15551234567", "Jamie", "notes", "test-key", "loc-1");
    expect(result).toEqual({ synced: true, contactId: "ghl-contact-1" });
    expect(callCount).toBe(2);
  });
});
