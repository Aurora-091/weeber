import { describe, it, expect, afterEach } from "bun:test";
import { syncToSalesforce } from "./salesforce";
import { __resetBreakersForTests } from "./resilient-fetch";

const originalFetch = global.fetch;

describe("syncToSalesforce", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    __resetBreakersForTests();
  });

  it("returns not-configured when no access token is passed", async () => {
    const result = await syncToSalesforce("+15551234567", "Jamie Doe", "notes");
    expect(result.synced).toBe(false);
    if (!result.synced) expect(result.message).toContain("not configured");
  });

  it("creates a new contact when the SOQL lookup finds none, then logs a task", async () => {
    let callCount = 0;
    global.fetch = (async (url: string) => {
      callCount += 1;
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ records: [] }), { status: 200 });
      }
      if (String(url).includes("/sobjects/Contact")) {
        return new Response(JSON.stringify({ id: "003abc" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await syncToSalesforce(
      "+15551234567",
      "Jamie Doe",
      "notes",
      "test-token",
      "https://example.my.salesforce.com",
    );
    expect(result).toEqual({ synced: true, contactId: "003abc" });
    expect(callCount).toBe(3); // query + create contact + create task
  });

  it("reuses an existing contact found via SOQL instead of creating a new one", async () => {
    let callCount = 0;
    global.fetch = (async (url: string) => {
      callCount += 1;
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ records: [{ Id: "003existing" }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await syncToSalesforce(
      "+15551234567",
      "Jamie Doe",
      "notes",
      "test-token",
      "https://example.my.salesforce.com",
    );
    expect(result).toEqual({ synced: true, contactId: "003existing" });
    expect(callCount).toBe(2); // query + create task (no contact creation)
  });
});
