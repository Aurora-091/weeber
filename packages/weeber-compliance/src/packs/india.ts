/**
 * India jurisdiction pack (Global Compliance Engine Tier 0, docs/global-compliance-engine-plan.md
 * #4). TRAI's TCCCPR framework restricts commercial/telemarketing voice calls to 9am-9pm local
 * time (blocked 9pm-9am) — corroborated across multiple independent compliance-guide sources
 * (ClearTouch, TALK-Q, and TRAI's own referenced circulars). India has a single timezone
 * (Asia/Kolkata, UTC+5:30), so no area-code-style resolution is needed, only a +91 country-code
 * check.
 *
 * This is a best-effort guardrail, not a legal certification — for real production
 * telemarketing volume, pair this with a proper number-intelligence provider (Twilio Lookup, etc)
 * for precise recipient identification, and re-verify TRAI's permitted hours periodically —
 * enforcement and rules in this space move faster than this comment will be updated.
 */
import { getHourInTimezone, type CallingWindowResult, type CallingWindowOptions } from "./types";

export const INDIA_CALL_WINDOW_START_HOUR = 9;
export const INDIA_CALL_WINDOW_END_HOUR = 21;
export const INDIA_TIMEZONE = "Asia/Kolkata";

export function isIndianNumber(e164: string): boolean {
  return /^\+91\d{10}$/.test(e164);
}

export function checkIndiaCallingWindow(
  // Unused — India is a single timezone (Asia/Kolkata), so no per-number resolution is needed
  // here at all, unlike the US pack. Kept in the signature so every pack has the same shape
  // (toNumber, now, options) regardless of whether a given jurisdiction actually needs the
  // number for anything beyond the isIndianNumber() gate the resolver already applied.
  _toNumber: string,
  now: Date,
  options: CallingWindowOptions = {},
): CallingWindowResult {
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
