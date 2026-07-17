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

/**
 * General area-code -> US state map (2026-07-16,
 * docs/agent-prompts/00-insurance-regulatory-reference.md, "Platform gaps" #2) — backs the
 * insurance producer-licensing check (a producer must be licensed in the state the prospect
 * resides in). Broader than MINI_TCPA_AREA_CODE_STATE above (covers most states, not just the
 * three with a stricter calling window) but still explicitly partial, same "extend as needed"
 * convention as every other area-code map in this file — phone-number-based jurisdiction
 * inference is a known-weak signal in general (ported numbers, VOIP, someone who moved states and
 * kept their old number), flagged already in docs/global-compliance-engine-plan.md's Tier 1 #12;
 * this map is a reasonable default, not a guarantee. For a real high-volume insurance launch,
 * pair this with a real number-intelligence provider (Twilio Lookup, etc) or capture the lead's
 * state explicitly at intake instead of inferring it from the area code alone.
 */
export const AREA_CODE_STATE: Record<string, string> = {
  // Alabama
  "205": "AL", "251": "AL", "256": "AL", "334": "AL", "938": "AL",
  // Alaska
  "907": "AK",
  // Arizona
  "480": "AZ", "520": "AZ", "602": "AZ", "623": "AZ", "928": "AZ",
  // Arkansas
  "479": "AR", "501": "AR", "870": "AR",
  // California
  "209": "CA", "213": "CA", "310": "CA", "323": "CA", "408": "CA", "415": "CA", "424": "CA",
  "510": "CA", "530": "CA", "559": "CA", "562": "CA", "619": "CA", "626": "CA", "650": "CA",
  "657": "CA", "661": "CA", "707": "CA", "714": "CA", "747": "CA", "760": "CA", "805": "CA",
  "818": "CA", "831": "CA", "858": "CA", "909": "CA", "916": "CA", "925": "CA", "949": "CA", "951": "CA",
  // Colorado
  "303": "CO", "719": "CO", "720": "CO", "970": "CO",
  // Connecticut
  "203": "CT", "860": "CT",
  // Delaware
  "302": "DE",
  // Florida
  "305": "FL", "321": "FL", "352": "FL", "386": "FL", "407": "FL", "561": "FL", "727": "FL",
  "754": "FL", "772": "FL", "786": "FL", "813": "FL", "850": "FL", "863": "FL", "904": "FL", "941": "FL", "954": "FL",
  // Georgia
  "229": "GA", "404": "GA", "470": "GA", "478": "GA", "678": "GA", "706": "GA", "770": "GA", "912": "GA",
  // Hawaii
  "808": "HI",
  // Idaho
  "208": "ID",
  // Illinois
  "217": "IL", "224": "IL", "309": "IL", "312": "IL", "331": "IL", "618": "IL", "630": "IL",
  "708": "IL", "773": "IL", "815": "IL", "847": "IL", "872": "IL",
  // Indiana
  "219": "IN", "260": "IN", "317": "IN", "463": "IN", "574": "IN", "765": "IN", "812": "IN",
  // Iowa
  "319": "IA", "515": "IA", "563": "IA", "641": "IA", "712": "IA",
  // Kansas
  "316": "KS", "620": "KS", "785": "KS", "913": "KS",
  // Kentucky
  "270": "KY", "502": "KY", "606": "KY", "859": "KY",
  // Louisiana
  "225": "LA", "318": "LA", "337": "LA", "504": "LA", "985": "LA",
  // Maine
  "207": "ME",
  // Maryland
  "240": "MD", "301": "MD", "410": "MD", "443": "MD", "667": "MD",
  // Massachusetts
  "339": "MA", "413": "MA", "508": "MA", "617": "MA", "774": "MA", "781": "MA", "857": "MA", "978": "MA",
  // Michigan
  "231": "MI", "248": "MI", "269": "MI", "313": "MI", "517": "MI", "586": "MI", "616": "MI",
  "734": "MI", "810": "MI", "906": "MI", "947": "MI", "989": "MI",
  // Minnesota
  "218": "MN", "320": "MN", "507": "MN", "612": "MN", "651": "MN", "763": "MN", "952": "MN",
  // Mississippi
  "228": "MS", "601": "MS", "662": "MS", "769": "MS",
  // Missouri
  "314": "MO", "417": "MO", "573": "MO", "636": "MO", "660": "MO", "816": "MO",
  // Montana
  "406": "MT",
  // Nebraska
  "308": "NE", "402": "NE", "531": "NE",
  // Nevada
  "702": "NV", "725": "NV", "775": "NV",
  // New Hampshire
  "603": "NH",
  // New Jersey
  "201": "NJ", "551": "NJ", "609": "NJ", "732": "NJ", "848": "NJ", "856": "NJ", "862": "NJ", "908": "NJ", "973": "NJ",
  // New Mexico
  "505": "NM", "575": "NM",
  // New York
  "212": "NY", "315": "NY", "347": "NY", "516": "NY", "518": "NY", "585": "NY", "607": "NY",
  "631": "NY", "646": "NY", "716": "NY", "718": "NY", "845": "NY", "914": "NY", "917": "NY", "929": "NY",
  // North Carolina
  "252": "NC", "336": "NC", "704": "NC", "828": "NC", "910": "NC", "919": "NC", "980": "NC", "984": "NC",
  // North Dakota
  "701": "ND",
  // Ohio
  "216": "OH", "220": "OH", "234": "OH", "330": "OH", "419": "OH", "440": "OH", "513": "OH",
  "567": "OH", "614": "OH", "740": "OH", "937": "OH",
  // Oklahoma
  "405": "OK", "539": "OK", "580": "OK", "918": "OK",
  // Oregon
  "503": "OR", "541": "OR", "971": "OR",
  // Pennsylvania
  "215": "PA", "267": "PA", "412": "PA", "484": "PA", "570": "PA", "610": "PA", "717": "PA",
  "724": "PA", "814": "PA", "878": "PA",
  // Rhode Island
  "401": "RI",
  // South Carolina
  "803": "SC", "839": "SC", "843": "SC", "854": "SC", "864": "SC",
  // South Dakota
  "605": "SD",
  // Tennessee
  "423": "TN", "615": "TN", "629": "TN", "731": "TN", "865": "TN", "901": "TN", "931": "TN",
  // Texas
  "210": "TX", "214": "TX", "254": "TX", "281": "TX", "325": "TX", "346": "TX", "361": "TX",
  "409": "TX", "430": "TX", "432": "TX", "469": "TX", "512": "TX", "682": "TX", "713": "TX",
  "737": "TX", "806": "TX", "817": "TX", "832": "TX", "903": "TX", "915": "TX", "936": "TX",
  "940": "TX", "956": "TX", "972": "TX", "979": "TX",
  // Utah
  "385": "UT", "435": "UT", "801": "UT",
  // Vermont
  "802": "VT",
  // Virginia
  "276": "VA", "434": "VA", "540": "VA", "571": "VA", "703": "VA", "757": "VA", "804": "VA",
  // Washington
  "206": "WA", "253": "WA", "360": "WA", "425": "WA", "509": "WA", "564": "WA",
  // Washington DC
  "202": "DC",
  // West Virginia
  "304": "WV", "681": "WV",
  // Wisconsin
  "262": "WI", "414": "WI", "534": "WI", "608": "WI", "715": "WI", "920": "WI",
  // Wyoming
  "307": "WY",
};

function extractNanpAreaCode(e164: string): string | null {
  // NANP numbers: +1XXXYYYYYYY — area code is the 3 digits after +1
  const match = e164.match(/^\+1(\d{3})\d{7}$/);
  return match?.[1] ?? null;
}

/** Best-effort US state resolution from a phone number's NANP area code — see AREA_CODE_STATE's
 * doc comment for the caveats (partial map, known-weak signal in general). Returns null for a
 * non-NANP number or an area code not yet in the map. */
export function resolveUsState(toNumber: string): string | null {
  const areaCode = extractNanpAreaCode(toNumber);
  return areaCode ? (AREA_CODE_STATE[areaCode] ?? null) : null;
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
