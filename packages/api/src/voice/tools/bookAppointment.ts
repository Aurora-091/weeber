import z from "zod";
import { tool } from "ai";
import { bookOnGoogleCalendar } from "../integrations/google-calendar";

/**
 * Books a caller in. Real Google Calendar booking if GOOGLE_CALENDAR_ACCESS_TOKEN
 * is set (see ../integrations/google-calendar.ts, wrapped in the shared
 * resilience layer so a slow/down Calendar API can't stall the call); falls
 * back to a clear "not configured" result otherwise so the agent can tell
 * the caller honestly instead of pretending the booking happened.
 */
export const bookAppointment = tool({
  description:
    "Book an appointment for the caller. Use this once you've confirmed a date/time and the caller's name.",
  inputSchema: z.object({
    callerName: z.string(),
    dateTimeIso: z.string().describe("ISO 8601 date-time for the appointment"),
    notes: z.string().optional(),
  }),
  async execute({ callerName, dateTimeIso, notes }) {
    const result = await bookOnGoogleCalendar(callerName, dateTimeIso, notes);

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
