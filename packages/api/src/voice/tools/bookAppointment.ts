import z from "zod";
import { tool } from "ai";
import { bookOnGoogleCalendar } from "../integrations/google-calendar";
import { db } from "../../database";
import { orgIntegrations } from "../../database/schema";
import { eq, and } from "drizzle-orm";

async function getOrgCalendarCredentials(orgId: string): Promise<{
  accessToken: string;
  calendarId: string;
} | null> {
  const [row] = await db
    .select()
    .from(orgIntegrations)
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.provider, "google_calendar"), eq(orgIntegrations.enabled, true)))
    .limit(1);
  if (!row || !row.credentials) return null;
  const creds = row.credentials as Record<string, string>;
  if (!creds.access_token) return null;
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

export const bookAppointment = createBookAppointmentTool(undefined);
