/**
 * Jurisdiction-pack shared types (Global Compliance Engine Tier 0, 2026-07-16,
 * docs/global-compliance-engine-plan.md #4). Every jurisdiction pack (india.ts, us.ts, and any
 * future eu.ts/etc) implements the same shape so `calling-window.ts`'s resolver can pick one
 * without the rest of the codebase caring which jurisdiction actually matched — this is what
 * makes adding a new jurisdiction additive (a new pack file + one resolver branch) instead of
 * growing a single hardcoded if/else chain indefinitely.
 */

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

export function getHourInTimezone(timezone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  const hourStr = formatter.format(date);
  return Number(hourStr === "24" ? "0" : hourStr);
}
