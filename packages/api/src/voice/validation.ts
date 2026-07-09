/**
 * Shared input validation helpers — catch malformed input at the edge
 * before it reaches Twilio, the compliance layer, or the database.
 */

/** E.164: + followed by 8-15 digits, no leading zero after the +. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function isValidE164(value: unknown): value is string {
  return typeof value === "string" && E164_PATTERN.test(value);
}
