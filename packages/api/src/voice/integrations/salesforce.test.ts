import { describe, it, expect, afterEach } from "bun:test";
import { syncToSalesforce } from "./salesforce";
import { __resetBreakersForTests } from "./resilient-fetch";

const originalFetch = global.fetch;
const originalToken = process.env.SALESFORCE_ACCESS_TOKEN;
const originalUrl = process.env.SALESFORCE_INSTANCE_URL;

describe("syncToSalesforce", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.SALESFORCE_ACCESS_TOKEN;
    else process.env.SALESFORCE_ACCESS_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.SALESFORCE_INSTANCE_URL;
    else process.env.SALESFORCE_INSTANCE_URL = originalUrl;
    __resetBreakersForTests();
  });

  it("returns not-configured when token or instance url is missing", async () => {
    delete process.env.SALESFORCE_ACCESS_TOKEN;
    delete process.env.SALESFORCE_INSTANCE_URL;
    const result = await syncToSalesforce("+15551234567", "Jamie Doe", "notes");
    expect(result.synced).toBe(false);
    if (!result.synced) expect(result.message).toContain("not configured");
  });

  it("creates a new contact when the SOQL lookup finds none, then logs a task", async () => {
    process.env.SALESFORCE_ACCESS_TOKEN = "test-token";
    process.env.SALESFORCE_INSTANCE_URL = "https://example.my.salesforce.com";
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

    const result = await syncToSalesforce("+15551234567", "Jamie Doe", "notes");
    expect(result).toEqual({ synced: true, contactId: "003abc" });
    expect(callCount).toBe(3); // query + create contact + create task
  });

  it("reuses an existing contact found via SOQL instead of creating a new one", async () => {
    process.env.SALESFORCE_ACCESS_TOKEN = "test-token";
    process.env.SALESFORCE_INSTANCE_URL = "https://example.my.salesforce.com";
    let callCount = 0;
    global.fetch = (async (url: string) => {
      callCount += 1;
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ records: [{ Id: "003existing" }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await syncToSalesforce("+15551234567", "Jamie Doe", "notes");
    expect(result).toEqual({ synced: true, contactId: "003existing" });
    expect(callCount).toBe(2); // query + create task (no contact creation)
  });
});
