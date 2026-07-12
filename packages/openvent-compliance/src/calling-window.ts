/**
 * TCPA-style calling-window enforcement: outbound calls are only allowed
 * between 8am-9pm in the *called party's* local time. We derive a rough
 * timezone from the US/Canada area code (NANP) when possible; when the
 * number's timezone can't be determined (non-NANP / unrecognized), we fall
 * back to the safest conservative window recommended by TCPA compliance
 * guides: 11am-9pm Eastern, which stays within 8am-9pm across all US
 * mainland timezones.
 *
 * India (+91) is handled as its own jurisdiction, not folded into the NANP
 * fallback above — see checkCallingWindow's India branch below. Before this
 * fix, ANY +91 number fell through to the "safe" NANP fallback (11am-9pm US
 * Eastern), which converts to roughly 8:30pm-6:30am IST: this compliance
 * gate was treating Indian nighttime as an allowed calling window. TRAI's
 * TCCCPR framework restricts commercial/telemarketing voice calls to
 * 9am-9pm local time (blocked 9pm-9am) — corroborated across multiple
 * independent compliance-guide sources (ClearTouch, TALK-Q, and TRAI's own
 * referenced circulars) as of this fix. India has a single timezone
 * (Asia/Kolkata, UTC+5:30) so no area-code-style resolution is needed, only
 * a +91 country-code check.
 *
 * This is a best-effort guardrail, not a legal certification — for real
 * production telemarketing volume, pair this with a proper number-intelligence
 * provider (Twilio Lookup, etc) for precise timezone resolution, and
 * re-verify TRAI's permitted hours periodically — enforcement and rules in
 * this space move faster than this comment will be updated.
 */

const CALL_WINDOW_START_HOUR = 8;
const CALL_WINDOW_END_HOUR = 21; // 9pm

// TRAI TCCCPR: commercial/telemarketing voice calls permitted 9am-9pm IST,
// blocked 9pm-9am — distinct from the US TCPA's 8am-9pm above. India is a
// single timezone, so no area-code map is needed the way NANP requires one.
const INDIA_CALL_WINDOW_START_HOUR = 9;
const INDIA_CALL_WINDOW_END_HOUR = 21;
const INDIA_TIMEZONE = "Asia/Kolkata";

function isIndianNumber(e164: string): boolean {
  return /^\+91\d{10}$/.test(e164);
}

// Partial NANP area-code -> IANA timezone map covering the most common US/Canada
// area codes. Extend as needed; unmapped codes fall back to the safe window.
const AREA_CODE_TIMEZONES: Record<string, string> = {
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
  "312": "America/Chicago", "314": "America/Chicago", "409": "America/Chicago",
  "512": "America/Chicago", "601": "America/Chicago", "615": "America/Chicago",
  "713": "America/Chicago", "773": "America/Chicago", "832": "America/Chicago",
  "901": "America/Chicago", "972": "America/Chicago",
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

function extractNanpAreaCode(e164: string): string | null {
  // NANP numbers: +1XXXYYYYYYY — area code is the 3 digits after +1
  const match = e164.match(/^\+1(\d{3})\d{7}$/);
  return match?.[1] ?? null;
}

function getHourInTimezone(timezone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  const hourStr = formatter.format(date);
  return Number(hourStr === "24" ? "0" : hourStr);
}

export type CallingWindowResult = {
  allowed: boolean;
  reason: string;
  resolvedTimezone: string | null;
  localHour: number;
};

export type CallingWindowOptions = {
  /** Override the allowed start hour (default 8, i.e. 8am). Applies to the
   * NANP/fallback path — see indiaStartHour/indiaEndHour for the +91 path. */
  startHour?: number;
  /** Override the allowed end hour (default 21, i.e. 9pm). NANP/fallback path only. */
  endHour?: number;
  /** Extend or override the built-in area-code -> timezone map. */
  areaCodeTimezones?: Record<string, string>;
  /** Override TRAI's permitted start hour for +91 numbers (default 9, i.e. 9am). */
  indiaStartHour?: number;
  /** Override TRAI's permitted end hour for +91 numbers (default 21, i.e. 9pm). */
  indiaEndHour?: number;
};

export function checkCallingWindow(
  toNumber: string,
  now: Date = new Date(),
  options: CallingWindowOptions = {},
): CallingWindowResult {
  if (isIndianNumber(toNumber)) {
    const indiaStartHour = options.indiaStartHour ?? INDIA_CALL_WINDOW_START_HOUR;
    const indiaEndHour = options.indiaEndHour ?? INDIA_CALL_WINDOW_END_HOUR;
    const localHour = getHourInTimezone(INDIA_TIMEZONE, now);
    const withinWindow = localHour >= indiaStartHour && localHour < indiaEndHour;

    return {
      allowed: withinWindow,
      resolvedTimezone: INDIA_TIMEZONE,
      localHour,
      reason: withinWindow
        ? "within allowed calling window"
        : `outside TRAI-permitted calling window (local time ${localHour}:00 IST, allowed ${indiaStartHour}:00-${indiaEndHour}:00 IST)`,
    };
  }

  const startHour = options.startHour ?? CALL_WINDOW_START_HOUR;
  const endHour = options.endHour ?? CALL_WINDOW_END_HOUR;
  const areaCodeMap = options.areaCodeTimezones
    ? { ...AREA_CODE_TIMEZONES, ...options.areaCodeTimezones }
    : AREA_CODE_TIMEZONES;

  const areaCode = extractNanpAreaCode(toNumber);
  const timezone: string | null = (areaCode ? areaCodeMap[areaCode] : undefined) ?? null;

  // Fall back to the safe conservative window (Eastern time) when we can't
  // resolve a timezone for this number.
  const effectiveTimezone = timezone ?? "America/New_York";
  const localHour = getHourInTimezone(effectiveTimezone, now);

  const effectiveStartHour = timezone ? startHour : Math.max(startHour, 11); // safe default: 11am-9pm ET
  const withinWindow = localHour >= effectiveStartHour && localHour < endHour;

  return {
    allowed: withinWindow,
    resolvedTimezone: timezone,
    localHour,
    reason: withinWindow
      ? "within allowed calling window"
      : timezone
        ? `outside allowed window (local time ${localHour}:00 in ${timezone}, allowed ${startHour}:00-${endHour}:00)`
        : `timezone unresolved for this number — outside safe fallback window (${localHour}:00 ET, allowed ${effectiveStartHour}:00-${endHour}:00 ET)`,
  };
}
