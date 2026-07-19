import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * §P0 fix (audit #06): bookAppointment used to read a single global env var
 * (GOOGLE_CALENDAR_ACCESS_TOKEN), shared across every org — a real
 * cross-tenant risk (every clinic org's bookings landing on the same
 * calendar the moment more than one is live). It's now a factory
 * (createBookAppointmentTool(orgId)) that looks up per-org credentials
 * from org_integrations, with no env-var fallback left in
 * google-calendar.ts. Covers the org-scoping/not-configured branching —
 * untested until now.
 */

let orgIntegrationRows: Array<{ credentials: Record<string, string>; enabled: boolean }> = [];
let lastCalendarArgs: unknown[] | null = null;
let vaultedCalendarCreds: Record<string, string> = {};

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => orgIntegrationRows,
        }),
      }),
    }),
  },
}));

// Vault-first read (audit 2026-07-19 finding #1) — defaults to empty so existing tests below
// exercise the legacy plaintext `orgIntegrations.credentials` fallback path unchanged.
mock.module("../../database/credential-vault", () => ({
  readOrgIntegrationCredentials: async () => vaultedCalendarCreds,
}));

mock.module("../integrations/google-calendar", () => ({
  bookOnGoogleCalendar: async (...args: unknown[]) => {
    lastCalendarArgs = args;
    return { booked: true, eventId: "evt-1", htmlLink: "https://calendar.google.com/evt-1" };
  },
}));

import { createBookAppointmentTool } from "./bookAppointment";

function callTool(orgId: string | undefined) {
  const tool = createBookAppointmentTool(orgId);
  return (tool.execute as (input: unknown) => Promise<unknown>)({
    callerName: "Jamie",
    dateTimeIso: "2026-08-01T10:00:00Z",
    notes: "follow-up visit",
  });
}

describe("createBookAppointmentTool — §P0 multi-tenant Calendar isolation", () => {
  beforeEach(() => {
    orgIntegrationRows = [];
    lastCalendarArgs = null;
    vaultedCalendarCreds = {};
  });

  it("refuses immediately when no orgId is captured — never falls back to a global/shared calendar", async () => {
    const result = (await callTool(undefined)) as { confirmed: false; message: string };
    expect(result.confirmed).toBe(false);
    expect(result.message).toContain("No org context");
    expect(lastCalendarArgs).toBeNull();
  });

  it("returns a clear not-configured result when the org has no Calendar connected", async () => {
    orgIntegrationRows = [];
    const result = (await callTool("org-a")) as { confirmed: false; message: string };
    expect(result.confirmed).toBe(false);
    expect(result.message).toContain("No Google Calendar connected for this organization");
  });

  it("also treats a stored row with no access_token as not-configured, not a crash", async () => {
    orgIntegrationRows = [{ credentials: { calendar_id: "primary" }, enabled: true }];
    const result = (await callTool("org-a")) as { confirmed: false; message: string };
    expect(result.confirmed).toBe(false);
    expect(result.message).toContain("No Google Calendar connected");
    expect(lastCalendarArgs).toBeNull();
  });

  it("uses this org's own stored access token + calendar id, not any other org's or a shared one", async () => {
    orgIntegrationRows = [{ credentials: { access_token: "org-a-token", calendar_id: "org-a-calendar" }, enabled: true }];
    const result = (await callTool("org-a")) as { confirmed: true; eventId: string };
    expect(result.confirmed).toBe(true);
    expect(result.eventId).toBe("evt-1");
    expect(lastCalendarArgs).toEqual([
      "Jamie",
      "2026-08-01T10:00:00Z",
      "follow-up visit",
      "org-a-token",
      "org-a-calendar",
    ]);
  });

  it("defaults to the 'primary' calendar when the org didn't set a specific calendar_id", async () => {
    orgIntegrationRows = [{ credentials: { access_token: "org-b-token" }, enabled: true }];
    await callTool("org-b");
    expect(lastCalendarArgs).toEqual(["Jamie", "2026-08-01T10:00:00Z", "follow-up visit", "org-b-token", "primary"]);
  });

  // Audit 2026-07-19 finding #1 (second half): vault-first credential resolution.
  it("prefers vaulted credentials over the legacy plaintext row when both exist", async () => {
    orgIntegrationRows = [{ credentials: { access_token: "legacy-plaintext-token", calendar_id: "legacy-cal" }, enabled: true }];
    vaultedCalendarCreds = { access_token: "vaulted-token", calendar_id: "vaulted-cal" };
    const result = (await callTool("org-a")) as { confirmed: true };
    expect(result.confirmed).toBe(true);
    expect(lastCalendarArgs).toEqual([
      "Jamie",
      "2026-08-01T10:00:00Z",
      "follow-up visit",
      "vaulted-token",
      "vaulted-cal",
    ]);
  });

  it("still requires the orgIntegrations row to exist/be enabled even when the vault has credentials", async () => {
    orgIntegrationRows = [];
    vaultedCalendarCreds = { access_token: "vaulted-token" };
    const result = (await callTool("org-a")) as { confirmed: false; message: string };
    expect(result.confirmed).toBe(false);
    expect(result.message).toContain("No Google Calendar connected");
  });
});
