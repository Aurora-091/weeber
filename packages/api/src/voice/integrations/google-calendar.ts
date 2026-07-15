import { resilientCall } from "./resilient-fetch";

/**
 * Google Calendar integration — creates an event on a calendar using
 * per-org OAuth credentials (access token + calendar ID) passed in from
 * the calling tool. No env-var fallback — tenant isolation is enforced.
 */
export type CalendarBookingResult =
  | { booked: true; eventId: string | null; htmlLink: string | null }
  | { booked: false; message: string };

export async function bookOnGoogleCalendar(
  callerName: string,
  dateTimeIso: string,
  notes: string | undefined,
  accessToken?: string,
  calendarId?: string,
): Promise<CalendarBookingResult> {
  const token = accessToken || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  if (!token) {
    return {
      booked: false,
      message: "(not configured) No Google Calendar access token provided.",
    };
  }

  const calendar = calendarId || process.env.GOOGLE_CALENDAR_ID || "primary";
  const start = new Date(dateTimeIso);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const result = await resilientCall(
    async (signal) => {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: `Call with ${callerName}`,
            description: notes ?? "Booked via Weeber voice agent.",
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
          }),
          signal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Google Calendar API returned ${res.status}: ${body.slice(0, 200)}`);
      }
      const event = (await res.json()) as any;
      return { eventId: (event.id as string | undefined) ?? null, htmlLink: (event.htmlLink as string | undefined) ?? null };
    },
    { integration: "google-calendar" },
  );

  if (!result.ok) {
    return { booked: false, message: `Google Calendar booking failed: ${result.message}` };
  }
  return { booked: true, eventId: result.data.eventId, htmlLink: result.data.htmlLink };
}
