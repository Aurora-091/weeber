/**
 * Outbound-argument guard (ADR-106) — the same screen `output-guard.ts` puts
 * on speech, applied to the tool arguments that reach a human in writing.
 *
 * Why this exists. ADR-104 built a guard for one channel: the model's token
 * stream on its way to TTS. But a voice agent has a second way to put its own
 * text in front of a person, and it is the one that persists — `sendSms.body`
 * goes to the caller's phone, `crmSync.notes` lands on a contact timeline a
 * salesperson reads, `bookAppointment.notes` goes into a calendar invite.
 * Nothing screened any of them.
 *
 * Production call 25 (2026-08-10) sent two SMS messages. The first said:
 *
 *     "...for your records: [Advisor Desk Number]. A licensed advisor will be
 *      with you shortly."
 *
 * — an unresolved bracket placeholder, exactly the shape ADR-104 stopped from
 * being *spoken*, delivered in writing instead. The second said:
 *
 *     "PersistentAds: Please contact your licensed advisor at 888-555-0199
 *      for assistance..."
 *
 * That number does not exist. `orgs.human_transfer_number` is NULL on all four
 * production orgs (ADR-105), the caller never said a number, and nothing in
 * the prompt contained one — the model filled the slot the only way it could,
 * by inventing something that looked right. A caller who keeps that text now
 * has a wrong number, attributed to the org, in their message history.
 *
 * Two decisions define this module.
 *
 * **It refuses rather than scrubs.** `output-guard.ts` deletes and lets the
 * sentence continue, because a half-spoken turn is worse than a slightly
 * clipped one and there is no second chance mid-utterance. Writing has no
 * such constraint: an SMS is a discrete, atomic act with a caller-visible
 * result, and a scrubbed one ("Please contact your licensed advisor at .")
 * is a message that reads as broken and still fails the caller. Not sending
 * is the honest outcome, and it leaves the finding in the logs where the
 * upstream defect can be fixed.
 *
 * **A number the agent was not given is a fabrication, by construction.**
 * There is no way to tell a hallucinated phone number from a real one by
 * looking at it — every check that tries (length, prefix, carrier lookup)
 * validates the *shape* of the invention. So the test is provenance, not
 * plausibility: a number may appear in outbound text only if the server put
 * it in scope (the org's configured transfer number, the number this call is
 * connected to) or the caller themselves said it. Same reasoning as
 * `crmSync`'s bound `phoneNumber` (ADR-069/G1.4) — the authority for a number
 * comes from where it came from, not from it passing a regex.
 */

import { scrubSpokenText, type OutputGuardFinding } from "./output-guard";

export type OutboundTextFinding = OutputGuardFinding | "unverified-phone-number";

export interface OutboundTextScreen {
  /** False when the argument must not be sent/written. */
  allowed: boolean;
  /** Distinct findings, in first-appearance order. Empty iff `allowed`. */
  findings: OutboundTextFinding[];
  /**
   * The offending numbers, normalized. Logged as evidence of the upstream
   * defect; never used to repair the text, because there is nothing to repair
   * it *to*.
   */
  unverifiedNumbers: string[];
}

/**
 * ISO-8601 dates are removed before the phone scan. `bookAppointment` carries
 * a real `dateTimeIso`, and callers legitimately write "booked for 2026-08-12"
 * into notes — a date is the one non-phone thing in this product that reliably
 * produces a long digit run.
 */
const ISO_DATE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g;

/**
 * A phone-number-shaped run: digits with the separators people actually type,
 * optionally `+`-prefixed. Deliberately loose — a candidate here is only a
 * candidate; the provenance check below decides.
 */
const PHONE_CANDIDATE = /\+?\d[\d\s().–-]{6,}\d/g;

/**
 * A candidate needs at least 10 digits to be treated as a phone number.
 *
 * The floor is not E.164's 7 (which `resolveCrmSyncContext` uses for a value
 * the carrier already vouched for). This scan runs over free prose, where 7-9
 * digit runs are overwhelmingly order numbers, amounts and dates, and a false
 * refusal here silently drops a legitimate SMS. 10 is the shortest a real
 * dialable US or Indian number gets, and it is what the fabricated
 * `888-555-0199` was.
 */
const MIN_PHONE_DIGITS = 10;
/** E.164's maximum. */
const MAX_PHONE_DIGITS = 15;

/**
 * Compared on the last 10 digits so `+1 888 555 0199`, `18885550199` and
 * `(888) 555-0199` are one number. Country-code and trunk-prefix variation is
 * exactly the difference this must see through — an org configures `+1…`, the
 * model writes it without the prefix, and refusing that would be a false
 * positive on the one number it *is* allowed to write.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Every phone-shaped run in `text`, normalized and de-duplicated. */
export function extractPhoneCandidates(text: string): string[] {
  const scannable = text.replace(ISO_DATE, " ");
  const found: string[] = [];
  PHONE_CANDIDATE.lastIndex = 0;
  for (const match of scannable.matchAll(PHONE_CANDIDATE)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) continue;
    const normalized = normalizePhone(match[0]);
    if (!found.includes(normalized)) found.push(normalized);
  }
  return found;
}

/**
 * Screens one model-authored string that is about to reach a human in
 * writing.
 *
 * `allowedNumbers` is every number this call legitimately has in scope. Pass
 * the full list even when some entries are blank or undefined — they are
 * filtered here, so a call with no configured transfer number simply allows
 * fewer numbers rather than needing a different code path at each callsite.
 */
export function screenOutboundText(
  text: string,
  options: { allowedNumbers?: readonly (string | null | undefined)[] } = {},
): OutboundTextScreen {
  const findings: OutboundTextFinding[] = [];

  // Reused wholesale rather than reimplemented: the tool-syntax, JSON-residue
  // and bracket-placeholder shapes are identical in both channels, and a
  // second copy would drift the first time a new model family leaks a new
  // envelope. `atTurnStart` is not passed — JSON residue is anchored to the
  // start of a *spoken turn*, and a tool argument is not one.
  const scrub = scrubSpokenText(text);
  for (const finding of scrub.findings) if (!findings.includes(finding)) findings.push(finding);

  const allowed = new Set(
    (options.allowedNumbers ?? [])
      .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
      .map(normalizePhone)
      .filter((n) => n.length >= MIN_PHONE_DIGITS),
  );

  const unverifiedNumbers = extractPhoneCandidates(text).filter((n) => !allowed.has(n));
  if (unverifiedNumbers.length > 0) findings.push("unverified-phone-number");

  return { allowed: findings.length === 0, findings, unverifiedNumbers };
}

/**
 * One-line evidence for the warn log and the `guardrail_events` row. The
 * numbers are included: they are the model's invention, not the caller's data,
 * and without them nobody can tell a fabrication from a formatting difference.
 */
export function describeOutboundTextScreen(screen: OutboundTextScreen): string {
  const parts = [screen.findings.join(", ")];
  if (screen.unverifiedNumbers.length > 0) parts.push(`numbers: ${screen.unverifiedNumbers.join(", ")}`);
  return parts.join(" — ");
}

/**
 * The free-text fields of each guarded tool.
 *
 * Explicitly a per-field allowlist, not "screen every string argument".
 * `bookAppointment.dateTimeIso` is a structured value whose digits are a date,
 * `captureField.field` is a key screened by `screenCapture` for a different
 * property, and `setDisposition`/`setIntent` take enums. Screening those would
 * trade a real defect for a stream of false refusals on the tools that carry
 * the call's outcome.
 */
export const GUARDED_TEXT_ARGS: Record<string, readonly string[]> = {
  sendSms: ["body"],
  crmSync: ["callerName", "notes"],
  bookAppointment: ["callerName", "notes"],
};

/**
 * Screens every guarded free-text field of one tool call. Returns `null` when
 * the tool is not guarded or every field passed — the callsites read as
 * "refuse if this is non-null".
 */
export function screenToolArguments(
  toolName: string,
  input: unknown,
  options: { allowedNumbers?: readonly (string | null | undefined)[] } = {},
): { field: string; screen: OutboundTextScreen } | null {
  const fields = GUARDED_TEXT_ARGS[toolName];
  if (!fields || !input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const screen = screenOutboundText(value, options);
    if (!screen.allowed) return { field, screen };
  }
  return null;
}
