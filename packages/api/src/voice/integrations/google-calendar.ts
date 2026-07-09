import { resilientCall } from "./resilient-fetch";

/**
 * Google Calendar integration — replaces the old `bookAppointment` stub with
 * a real booking flow. Creates an event on a calendar you own using a
 * pre-obtained OAuth access token (same reasoning as salesforce.ts — token
 * refresh/OAuth flow is your own app's responsibility, this just uses
 * whatever valid token is in GOOGLE_CALENDAR_ACCESS_TOKEN).
 *
 * Wrapped in resilientCall like every other integration — see
 * ./resilient-fetch.ts. Defaults to a 30-minute event on the primary
 * calendar unless GOOGLE_CALENDAR_ID overrides it.
 */
export type CalendarBookingResult =
  | { booked: true; eventId: string | null; htmlLink: string | null }
  | { booked: false; message: string };

export async function bookOnGoogleCalendar(
  callerName: string,
  dateTimeIso: string,
  notes: string | undefined,
): Promise<CalendarBookingResult> {
  const accessToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  if (!accessToken) {
    return {
      booked: false,
      message: "(not configured) GOOGLE_CALENDAR_ACCESS_TOKEN not set — no real calendar connected.",
    };
  }

  const calendarId = process.env.GOOGLE_CALENDAR_ID ?? "primary";
  const start = new Date(dateTimeIso);
  const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-minute default duration

  const result = await resilientCall(
    async (signal) => {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: `Call with ${callerName}`,
            description: notes ?? "Booked via OpenVent voice agent.",
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
