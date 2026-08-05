/**
 * Shared handling for the two call-control tools (`hangUp`, `transferToHuman`).
 *
 * Both only ever *signal intent* — the tool returns `{ hangUpRequested: true }`
 * and the live-call state machine decides when to act on it, once the closing
 * line has been spoken. Which means the pipeline's read of the tool call is the
 * single point where an intent to end a call can be lost, and losing it is not
 * a degraded transcript: the caller hears the goodbye and then sits on a live
 * call that never hangs up.
 *
 * `reason` is a required field on both tool schemas, but "required in the schema"
 * is not "always present at runtime" — a model can emit an empty argument
 * object, and a provider/SDK can hand back arguments that never parsed into one.
 * Both `stream.ts` and `test-call-stream.ts` therefore register the intent on
 * the tool NAME alone and use this helper for the reason, so a missing reason
 * costs a log line rather than the hangup.
 */
export function toolCallReason(input: unknown, fallback: string): string {
  if (input && typeof input === "object" && "reason" in input) {
    const raw = (input as { reason: unknown }).reason;
    if (typeof raw === "string" && raw.trim()) return raw;
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  }
  return fallback;
}
