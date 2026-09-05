import z from "zod";
import { tool } from "ai";
import { bookOnGoogleCalendar } from "../integrations/google-calendar";
import { db } from "../../database";
import { orgIntegrations } from "../../database/schema";
import { eq, and } from "drizzle-orm";
import { readOrgIntegrationCredentials } from "../../database/credential-vault";

// Vault-first, plaintext-jsonb fallback — same transition pattern as
// resolve-crm.ts (audit 2026-07-19 finding #1). The orgIntegrations row is
// still the source of truth for whether Calendar is connected/enabled; only
// the credential *values* prefer the vault.
async function getOrgCalendarCredentials(orgId: string): Promise<{
  accessToken: string;
  calendarId: string;
} | null> {
  const [row] = await db
    .select()
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.provider, "google_calendar"), eq(orgIntegrations.enabled, true)))
    .limit(1);
  if (!row) return null;

  const vaulted = await readOrgIntegrationCredentials(orgId, "google_calendar");
  if (vaulted.access_token) {
    return { accessToken: vaulted.access_token, calendarId: vaulted.calendar_id || "primary" };
  }

  if (!row.credentials) return null;
  const creds = row.credentials as Record<string, string>;
  if (!creds.access_token) return null;
  console.warn(`[bookAppointment] org ${orgId} google_calendar is on legacy plaintext credentials — not yet vaulted`);
  return { accessToken: creds.access_token, calendarId: creds.calendar_id || "primary" };
}

export function createBookAppointmentTool(orgId: string | undefined) {
  return tool({
    description:
      "Book an appointment for the caller. Use this once you've confirmed a date/time and the caller's name.",
    inputSchema: z.object({
      callerName: z.string(),
      dateTimeIso: z.string().describe("ISO 8601 date-time for the appointment"),
      notes: z.string().optional(),
    }),
    async execute({ callerName, dateTimeIso, notes }) {
      if (!orgId) {
        return {
          confirmed: false,
          callerName,
          dateTimeIso,
          notes: notes ?? null,
          message: "(not configured) No org context — cannot look up Calendar credentials.",
        };
      }

      const calendarConfig = await getOrgCalendarCredentials(orgId);
      if (!calendarConfig) {
        return {
          confirmed: false,
          callerName,
          dateTimeIso,
          notes: notes ?? null,
          message: "(not configured) No Google Calendar connected for this organization. Connect one in Settings > Integrations.",
        };
      }

      const result = await bookOnGoogleCalendar(
        callerName,
        dateTimeIso,
        notes,
        calendarConfig.accessToken,
        calendarConfig.calendarId,
      );

      if (!result.booked) {
        return {
          confirmed: false,
          callerName,
          dateTimeIso,
          notes: notes ?? null,
          message: result.message,
        };
      }

      return {
        confirmed: true,
        callerName,
        dateTimeIso,
        notes: notes ?? null,
        eventId: result.eventId,
        htmlLink: result.htmlLink,
        message: `Booked ${callerName} for ${dateTimeIso}.`,
      };
    },
  });
}
