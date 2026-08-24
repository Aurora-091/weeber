/**
 * The capture denylist: field keys a voice agent must never write into call
 * state, and the screening used to enforce it at the `captureField` chokepoint.
 *
 * This list and its matcher were written as part of the closer-brief work
 * (ADR-081) and lived in `insurance/closer-brief.ts`, where the only consumer
 * was `buildCloserBrief` reporting a regression *after the fact*. It now guards
 * the write itself, for every vertical, which is why it lives here instead: an
 * agent capturing a card number is not an insurance-specific problem.
 *
 * ## Why this is not the same list as REGULATED_FIELD_MARKERS
 *
 * `leads/intake-schema.ts` has its own, broader denylist. Merging the two looks
 * obviously correct and is wrong, because they screen different things:
 *
 *   - `REGULATED_FIELD_MARKERS` screens the **leads table** — durable, exported,
 *     CRM-synced storage. There, `health` means a stored medical condition.
 *   - this list screens **in-call capture**, where the permitted pre-qual set
 *     deliberately includes coarse flags: `health_flag` ("topics to be ready
 *     for"), `income_type` (Social Security / disability / working),
 *     `banking_ready` (has a standard account, yes/no).
 *
 * Union the lists and `health`, `income` and `bank` block three of the nine
 * fields the qualifying agent is *supposed* to collect — the guard would fire
 * on correct behaviour, and a guard that cries wolf gets switched off. So the
 * lists stay separate on purpose, and the only entries imported across from the
 * regulated side are hard identity/instrument numbers, which cannot collide
 * with a coarse flag because there is no coarse version of an Aadhaar number.
 */

/** Strips casing and every separator, so `applicantSSN`, `applicant_ssn`, and `SSN` all align. */
export function compact(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Splits a key into words across `_`, `-`, spaces, and camelCase humps. */
export function tokenize(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Field keys the qualifying agent must never capture.
 *
 * Kept broad on purpose — matching is substring-based for entries of four
 * characters or more (see `findProhibitedCapture`), so `ssn` catches
 * `applicant_ssn` and `routing` catches `bank_routing_number`.
 */
export const PROHIBITED_CAPTURE_KEYS: readonly string[] = [
  // Regulated acts under ADR-081 — the licensed advisor performs these.
  "ssn",
  "social_security",
  "routing",
  "account_number",
  "bank_account",
  "card_number",
  "date_of_birth",
  "dob",
  "premium",
  "carrier",
  "beneficiary_name",
  "diagnosis",
  "condition",
  "medication",
  "voice_signature",
  "ach",
  // Identity and payment-instrument numbers (2026-08-09). These were absent
  // while the list was insurance-only, so an agent that decided to capture
  // `aadhaar_number` or `cvv` sailed through a guard whose whole purpose was
  // stopping exactly that. None of them can collide with a permitted coarse
  // flag, which is why these specific entries cross over from
  // REGULATED_FIELD_MARKERS and the rest of that list does not.
  "aadhaar",
  "aadhar",
  "passport",
  "pan", // token-matched (3 chars) — substring would flag "expansion"
  "iban",
  "ifsc",
  "cvv",
  "credit_card",
  "debit_card",
  "driver_license",
  "drivers_license",
  "driving_licence",
] as const;

/**
 * Finds any key in `capturedState` that the agent should never have collected.
 *
 * Matching is separator- and case-insensitive on both sides, because the model
 * authors these keys freely: `account_number`, `accountNumber`, and
 * `Account Number` are the same field and all three must trip the guard.
 *
 * Two matching modes, split by length for a reason. Guard entries of four
 * characters or more match as a substring of the compacted key, so `routing`
 * catches `bankRoutingNumber`. Shorter entries (`ach`, `dob`, `pan`, `cvv`)
 * match only as a whole word, because a three-letter substring collides with
 * ordinary vocabulary — substring-matching `ach` would flag a field named
 * `reachable_time`, and `pan` would flag `expansion_plans`.
 *
 * Deliberately errs toward false positives otherwise: a spurious incident costs
 * someone a glance at a dashboard, while a missed one means an SSN was
 * formatted into a CRM note.
 */
export function findProhibitedCapture(capturedState: Record<string, unknown>): string[] {
  return Object.keys(capturedState).filter(isProhibitedCaptureKey);
}

/** Single-key form of `findProhibitedCapture`, for screening one write. */
export function isProhibitedCaptureKey(rawKey: string): boolean {
  const compacted = compact(rawKey);
  const tokens = tokenize(rawKey);
  return PROHIBITED_CAPTURE_KEYS.some((banned) => {
    const bannedCompact = compact(banned);
    return bannedCompact.length >= 4 ? compacted.includes(bannedCompact) : tokens.includes(bannedCompact);
  });
}

/** What the model is told when a capture is refused. */
export const PROHIBITED_CAPTURE_REFUSAL =
  "This field is not permitted and was not recorded. Do not ask the caller for it, do not try to " +
  "record it under another name, and do not read any part of it back. A licensed human advisor " +
  "collects this after the transfer.";

export type CaptureScreenResult =
  | { allowed: true }
  | { allowed: false; key: string; refusal: string };

/**
 * Screen one `captureField` call. Returns the refusal payload rather than
 * throwing, because a refused capture must not end the call: the agent should
 * hear "no" and carry on qualifying.
 */
export function screenCapture(field: unknown): CaptureScreenResult {
  const key = typeof field === "string" ? field.trim() : "";
  if (!key || !isProhibitedCaptureKey(key)) return { allowed: true };
  return { allowed: false, key, refusal: PROHIBITED_CAPTURE_REFUSAL };
}

/**
 * Strip the value out of a tool-call payload that was refused, keeping the key.
 *
 * Rejecting only the state merge is not enough. `logToolCall` persists the raw
 * tool input to `tool_calls.input` **and** dispatches it to the org's outbound
 * webhook — so a refused SSN would still be written to the database and shipped
 * to a third-party endpoint, which is the leak the guard exists to prevent,
 * just through a different pipe. The key survives (it is the evidence) and the
 * value never does.
 */
export function redactCaptureValue(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const clone: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  if ("value" in clone) clone.value = "[redacted: prohibited field]";
  // ADR-120: `heard` quotes the caller's own words verbatim, which for a
  // prohibited key (SSN, DOB, bank details, a medical condition) IS the
  // sensitive data — a caller who reads out their SSN and a model that
  // quotes it back in `heard` would otherwise leave the digits sitting in
  // `tool_calls.input` and the outbound webhook payload even though `value`
  // itself was redacted. Same leak this function exists to close, through
  // the argument A1 added after this function was written.
  if ("heard" in clone) clone.heard = "[redacted: prohibited field]";
  return clone;
}
