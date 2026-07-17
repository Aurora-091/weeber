/**
 * Florida FTSA max-3-attempts-per-24h cap (2026-07-17, closing the gap flagged in
 * docs/global-compliance-engine-plan.md Tier 0 #5 and packs/us.ts's own doc comment). Florida's
 * Telephone Solicitation Act imposes a hard cap of 3 call attempts to the same recipient within a
 * rolling 24-hour window, on top of the mini-TCPA calling-window restriction (8am-8pm, already
 * enforced in packs/us.ts). packs/us.ts is a pure, stateless function (same convention as the
 * rest of calling-window.ts) so it can't own a DB-backed history lookup itself — this check lives
 * in the dispatch path instead, same reasoning as the insurance gates in insurance-gates.ts, and
 * is wired into the exact same two call sites (workflows/scheduler.ts's dispatchScheduledCall,
 * covering both the automatic sweep and the manual "call now" button — they share this one
 * function, not two copies).
 *
 * Scoped to Florida only, on purpose — this is FTSA-specific, not a general "cap every US call at
 * 3/24h" policy (which isn't a real requirement outside Florida today, would be an overclaim to
 * silently apply everywhere). Uses MINI_TCPA_AREA_CODE_STATE (already maintained for the calling-
 * window override) to detect a Florida area code — same "partial, extend as needed" caveat as
 * that map: a ported/VOIP number's real state can't be perfectly inferred from area code alone.
 */
import { eq, and, gte } from "drizzle-orm";
import { MINI_TCPA_AREA_CODE_STATE } from "@openvent/compliance";
import { db } from "../../database";
import { calls } from "../../database/schema";

export const FTSA_MAX_ATTEMPTS_PER_24H = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export type AttemptCapResult =
  | { allowed: true }
  | { allowed: false; reason: string };

function extractNanpAreaCode(e164: string): string | null {
  const match = e164.match(/^\+1(\d{3})\d{7}$/);
  return match?.[1] ?? null;
}

/**
 * Counts real dial attempts to `toNumber` in the last rolling 24h (from `calls.startedAt`,
 * regardless of which workflow/trigger placed them — a recipient doesn't care whether the 3rd
 * call today was cart-recovery or a manual retry, FTSA's cap is per-recipient, not per-workflow)
 * and blocks a 4th if this is a Florida number. No-op (allowed) for every non-Florida number.
 */
export async function checkFtsaAttemptCap(toNumber: string, now: Date = new Date()): Promise<AttemptCapResult> {
  const areaCode = extractNanpAreaCode(toNumber);
  const state = areaCode ? MINI_TCPA_AREA_CODE_STATE[areaCode] : undefined;
  if (state !== "FL") return { allowed: true };

  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const recentCalls = await db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.toNumber, toNumber), gte(calls.startedAt, windowStart)));

  if (recentCalls.length >= FTSA_MAX_ATTEMPTS_PER_24H) {
    return {
      allowed: false,
      reason: `Florida FTSA cap reached — ${recentCalls.length} calls already placed to this number in the last 24h (max ${FTSA_MAX_ATTEMPTS_PER_24H}).`,
    };
  }
  return { allowed: true };
}
