/**
 * US jurisdiction pack (Global Compliance Engine Tier 0, docs/global-compliance-engine-plan.md
 * #4/#5). Two layers:
 *
 *   1. Federal TCPA baseline — 8am-9pm in the *called party's* local time. We derive a rough
 *      timezone from the US/Canada area code (NANP) when possible; when the number's timezone
 *      can't be determined (non-NANP / unrecognized), we fall back to the safest conservative
 *      window recommended by TCPA compliance guides: 11am-9pm Eastern, which stays within
 *      8am-9pm across all US mainland timezones.
 *
 *   2. Mini-TCPA state overrides — Florida, Oklahoma, and Washington all restrict calling hours
 *      further than the federal baseline: 8am-**8pm** local, not 9pm (corroborated across
 *      multiple 2025/2026 compliance-tracker sources — Goodwin Law, tcpalitigatorlist.com,
 *      Gryphon.ai — as of this fix, 2026-07-16). Detected via a partial area-code -> state map,
 *      same "partial, extend as needed" convention as the area-code -> timezone map below.
 *
 * NOT implemented here (flagged, not silently assumed done): Florida's FTSA also imposes a
 * max-3-attempts-per-24h cap per recipient. Enforcing that needs a call-history lookup (how many
 * times has this number been dialed in the last 24h), which is a stateful, DB-backed check — this
 * pack is a pure, stateless function (same as the rest of calling-window.ts), so it can't own that
 * check itself. Belongs in the dispatch path (workflows/scheduler.ts, alongside the existing
 * per-recipient attempt tracking on `scheduledCalls.attempt`) as a follow-up, not done in this
 * pass — see docs/global-compliance-engine-plan.md Tier 0 #5 for status.
 */
import { getHourInTimezone, type CallingWindowResult, type CallingWindowOptions } from "./types";

export const US_CALL_WINDOW_START_HOUR = 8;
export const US_CALL_WINDOW_END_HOUR = 21; // 9pm federal TCPA baseline

// Mini-TCPA states that cap earlier than the federal 9pm baseline.
export const MINI_TCPA_END_HOUR = 20; // 8pm

// Partial NANP area-code -> IANA timezone map covering the most common US/Canada
// area codes. Extend as needed; unmapped codes fall back to the safe window.
export const AREA_CODE_TIMEZONES: Record<string, string> = {
  // Eastern
  "212": "America/New_York", "213": "America/Los_Angeles", "215": "America/New_York",
  "216": "America/New_York", "302": "America/New_York", "305": "America/New_York",
  "404": "America/New_York", "407": "America/New_York", "410": "America/New_York",
  "412": "America/New_York", "617": "America/New_York", "631": "America/New_York",
  "646": "America/New_York", "678": "America/New_York", "704": "America/New_York",
  "718": "America/New_York", "754": "America/New_York", "770": "America/New_York",
  "786": "America/New_York", "813": "America/New_York", "845": "America/New_York",
  "917": "America/New_York", "929": "America/New_York",
  // Central
  "214": "America/Chicago", "217": "America/Chicago", "281": "America/Chicago",
  "312": "America/Chicago", "314": "America/Chicago", "405": "America/Chicago",
  "409": "America/Chicago", "512": "America/Chicago", "580": "America/Chicago",
  "601": "America/Chicago", "615": "America/Chicago", "713": "America/Chicago",
  "773": "America/Chicago", "832": "America/Chicago", "901": "America/Chicago",
  "918": "America/Chicago", "972": "America/Chicago",
  // Mountain
  "303": "America/Denver", "385": "America/Denver", "406": "America/Denver",
  "480": "America/Phoenix", "505": "America/Denver", "520": "America/Phoenix",
  "602": "America/Phoenix", "719": "America/Denver", "801": "America/Denver",
  "928": "America/Phoenix",
  // Pacific
  "206": "America/Los_Angeles", "209": "America/Los_Angeles", "253": "America/Los_Angeles",
  "310": "America/Los_Angeles", "323": "America/Los_Angeles", "408": "America/Los_Angeles",
  "415": "America/Los_Angeles", "425": "America/Los_Angeles", "503": "America/Los_Angeles",
  "509": "America/Los_Angeles", "510": "America/Los_Angeles", "530": "America/Los_Angeles",
  "541": "America/Los_Angeles", "559": "America/Los_Angeles", "562": "America/Los_Angeles",
  "619": "America/Los_Angeles", "626": "America/Los_Angeles", "650": "America/Los_Angeles",
  "657": "America/Los_Angeles", "702": "America/Los_Angeles", "707": "America/Los_Angeles",
  "714": "America/Los_Angeles", "725": "America/Los_Angeles", "760": "America/Los_Angeles",
  "775": "America/Los_Angeles", "805": "America/Los_Angeles", "818": "America/Los_Angeles",
  "858": "America/Los_Angeles", "909": "America/Los_Angeles", "916": "America/Los_Angeles",
  "925": "America/Los_Angeles", "949": "America/Los_Angeles", "951": "America/Los_Angeles",
  // Alaska / Hawaii
  "907": "America/Anchorage", "808": "America/Honolulu",
};

/**
 * Partial area-code -> mini-TCPA-state map. Only covers area codes for the three states with a
 * confirmed stricter-than-federal calling window (FL/OK/WA) — not a general area-code -> state
 * map, and deliberately not exhaustive for those three states either (extend as more codes come
 * up in practice, same convention as AREA_CODE_TIMEZONES above).
 */
export const MINI_TCPA_AREA_CODE_STATE: Record<string, "FL" | "OK" | "WA"> = {
  "305": "FL", "407": "FL", "754": "FL", "786": "FL", "813": "FL",
  "405": "OK", "580": "OK", "918": "OK",
  "206": "WA", "253": "WA", "425": "WA", "509": "WA",
};

function extractNanpAreaCode(e164: string): string | null {
  // NANP numbers: +1XXXYYYYYYY — area code is the 3 digits after +1
  const match = e164.match(/^\+1(\d{3})\d{7}$/);
  return match?.[1] ?? null;
}

export function checkUsCallingWindow(
  toNumber: string,
  now: Date,
  options: CallingWindowOptions = {},
): CallingWindowResult {
  const startHour = options.startHour ?? US_CALL_WINDOW_START_HOUR;
  const areaCodeMap = options.areaCodeTimezones
    ? { ...AREA_CODE_TIMEZONES, ...options.areaCodeTimezones }
    : AREA_CODE_TIMEZONES;

  const areaCode = extractNanpAreaCode(toNumber);
  const timezone: string | null = (areaCode ? areaCodeMap[areaCode] : undefined) ?? null;

  // Mini-TCPA override: a caller-supplied `endHour` always wins (explicit intent), otherwise
  // an FL/OK/WA area code caps at 8pm instead of the federal 9pm baseline.
  const miniTcpaState = areaCode ? MINI_TCPA_AREA_CODE_STATE[areaCode] : undefined;
  const endHour = options.endHour ?? (miniTcpaState ? MINI_TCPA_END_HOUR : US_CALL_WINDOW_END_HOUR);

  // Fall back to the safe conservative window (Eastern time) when we can't
  // resolve a timezone for this number.
  const effectiveTimezone = timezone ?? "America/New_York";
  const localHour = getHourInTimezone(effectiveTimezone, now);

  const effectiveStartHour = timezone ? startHour : Math.max(startHour, 11); // safe default: 11am-9pm ET
  const withinWindow = localHour >= effectiveStartHour && localHour < endHour;

  const miniTcpaNote = miniTcpaState ? ` (${miniTcpaState} mini-TCPA: capped at ${endHour}:00, not the federal 9pm)` : "";

  return {
    allowed: withinWindow,
    resolvedTimezone: timezone,
    localHour,
    reason: withinWindow
      ? "within allowed calling window"
      : timezone
        ? `outside allowed window (local time ${localHour}:00 in ${timezone}, allowed ${effectiveStartHour}:00-${endHour}:00${miniTcpaNote})`
        : `timezone unresolved for this number — outside safe fallback window (${localHour}:00 ET, allowed ${effectiveStartHour}:00-${endHour}:00 ET)`,
  };
}
