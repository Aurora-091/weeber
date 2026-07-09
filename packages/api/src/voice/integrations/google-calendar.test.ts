import { describe, it, expect, afterEach } from "bun:test";
import { bookOnGoogleCalendar } from "./google-calendar";
import { __resetBreakersForTests } from "./resilient-fetch";

const originalFetch = global.fetch;
const originalToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;

describe("bookOnGoogleCalendar", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = originalToken;
    __resetBreakersForTests();
  });

  it("returns not-configured when GOOGLE_CALENDAR_ACCESS_TOKEN is unset", async () => {
    delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    const result = await bookOnGoogleCalendar("Jamie", "2026-08-01T10:00:00Z", "notes");
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.message).toContain("not configured");
  });

  it("books an event and returns the event id + link on success", async () => {
    process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "test-token";
    global.fetch = (async () =>
      new Response(JSON.stringify({ id: "evt-1", htmlLink: "https://calendar.google.com/evt-1" }), {
        status: 200,
      })) as typeof fetch;

    const result = await bookOnGoogleCalendar("Jamie", "2026-08-01T10:00:00Z", "notes");
    expect(result).toEqual({
      booked: true,
      eventId: "evt-1",
      htmlLink: "https://calendar.google.com/evt-1",
    });
  });

  it("treats a non-2xx response as a failure instead of a false success", async () => {
    process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "test-token";
    global.fetch = (async () => new Response("invalid grant", { status: 401 })) as typeof fetch;

    const result = await bookOnGoogleCalendar("Jamie", "2026-08-01T10:00:00Z", "notes");
    expect(result.booked).toBe(false);
    if (!result.booked) expect(result.message).toContain("Google Calendar booking failed");
  });
});
