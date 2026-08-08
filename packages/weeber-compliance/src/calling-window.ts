/**
 * Calling-window compliance resolver — picks the right jurisdiction pack for a recipient number
 * and delegates to it. This file used to hold India's and the US's calling-window logic directly,
 * hardcoded as two branches in one function; as of the Global Compliance Engine Tier 0 refactor
 * (2026-07-16, docs/global-compliance-engine-plan.md #4) each jurisdiction's rules live in its own
 * pack under `packs/` (india.ts, us.ts), and this file is just the resolver — adding a future
 * jurisdiction (EU, etc) means adding a pack file + one branch here, not growing an if/else chain
 * indefinitely or touching every caller of `checkCallingWindow`.
 *
 * Public API is unchanged from before this refactor — same function name, same signature, same
 * return shape — so every existing caller (workflows/scheduler.ts, voice/routes.ts, this
 * package's own `checkOutboundCallCompliance`) needed zero changes.
 *
 * Jurisdiction resolution today is purely number-prefix-based (a known, real limitation flagged
 * in docs/global-compliance-engine-plan.md's Tier 1 #12 — ported numbers, VOIP, and diaspora
 * numbers can misclassify). Fine as a default; anything beyond a rough default should layer an
 * explicit recipient-country field on top, not rely on this alone.
 */
import { checkIndiaCallingWindow, isIndianNumber } from "./packs/india";
import { checkUsCallingWindow } from "./packs/us";
import type { CallingWindowResult, CallingWindowOptions } from "./packs/types";

export type { CallingWindowResult, CallingWindowOptions };

export function checkCallingWindow(
  toNumber: string,
  now: Date = new Date(),
  options: CallingWindowOptions = {},
): CallingWindowResult {
  if (isIndianNumber(toNumber)) {
    return checkIndiaCallingWindow(toNumber, now, options);
  }
  return checkUsCallingWindow(toNumber, now, options);
}
