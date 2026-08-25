/**
 * D8 (phase-d-conversation.md) — which `captureField` keys are high-stakes
 * enough that a single mis-heard character changes the value's meaning, not
 * just its spelling.
 *
 * This is a classification, not a guard: unlike `prohibited-capture.ts`,
 * nothing here refuses a write. `isCriticalField` only answers "should the
 * persona have spelled this back before calling captureField" — enforcement
 * is a prompt-level instruction (`agent.ts`'s `buildCallControlBlock`), per
 * this section's own explicit "not a new provenance mechanism" scope. A
 * caller-corrected spell-back still reaches `capturedState` the same way any
 * other captureField write does: the existing last-write-wins merge in
 * `stream.ts`'s `mergeCapturedField` already makes a later, corrected call
 * for the same key win over an earlier mis-heard one — nothing new needed
 * there either.
 *
 * Deliberately reuses `prohibited-capture.ts`'s `compact`/`tokenize`
 * normalization (same reason it exists there: the model authors field keys
 * freely, so `caller_name`, `callerName`, and `Caller Name` must all
 * classify the same way) without merging the two lists. They screen
 * different things for different reasons — see that file's own doc comment
 * for why PROHIBITED_CAPTURE_KEYS and REGULATED_FIELD_MARKERS stay separate;
 * the same logic applies here. Some entries below (`pan`, `ssn`) are already
 * unconditionally refused by `prohibited-capture.ts` and can never reach a
 * live spell-back turn through this codebase's current field set — kept
 * here anyway because the classification exists to describe the *shape* of
 * a high-stakes field, matching this section's own "PAN/SSN-shaped fields"
 * framing, not just the fields this one deployment happens to permit today.
 */

import { compact, tokenize } from "./prohibited-capture";

/**
 * Field-key fragments that mark a `critical` field: a name, a phone number,
 * an order/policy/vehicle identifier, or a government ID number. Ordinary
 * facts (`coverage_purpose`, `income_type`, `email`) are not included — a
 * mis-heard character there costs a re-ask, not a wrong appointment, order,
 * or policy.
 */
export const CRITICAL_FIELD_KEYS: readonly string[] = [
  "name",
  "phone",
  "mobile",
  "order",
  "policy",
  "vehicle",
  "registration",
  "pan",
  "ssn",
  "social_security",
] as const;

/**
 * Same two-mode matching as `isProhibitedCaptureKey`: entries of four
 * characters or more match as a substring of the compacted key (so `phone`
 * catches `phoneNumber`), shorter entries (`pan`, `ssn`) match only as a
 * whole token so a three-letter fragment doesn't collide with ordinary
 * vocabulary (`pan` would otherwise flag `expansion_plans`).
 */
export function isCriticalField(rawKey: string): boolean {
  const compacted = compact(rawKey);
  const tokens = tokenize(rawKey);
  return CRITICAL_FIELD_KEYS.some((critical) => {
    const criticalCompact = compact(critical);
    return criticalCompact.length >= 4
      ? compacted.includes(criticalCompact)
      : tokens.includes(criticalCompact);
  });
}
