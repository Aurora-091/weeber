/**
 * Twilio answering-machine detection (AMD) — when it may run, and when a
 * "machine" result may steal a live Media Stream.
 *
 * Async AMD does not delay pickup; Twilio posts AnsweredBy later to
 * `/amd-status-callback`. That callback used to *always* redirect a
 * machine_* result to a Twilio `<Say>` voicemail line and hang up. On
 * 2026-09-05 that fired ~30s into a live India test call that had already
 * completed two conversational turns (ADR-122). The caller heard a second
 * voice ("sorry to have missed you") because `<Say>` is Twilio's default
 * TTS, not Cartesia. See ADR-123.
 */

/** Twilio AnsweredBy values that used to mean "leave a voicemail and hang up". */
export const AMD_MACHINE_ANSWERS = new Set([
  "machine_start",
  "machine_end_beep",
  "machine_end_silence",
  "machine_end_other",
]);

/** Spoken by Twilio `<Say>` on a genuine machine-answered campaign call. */
export const AMD_VOICEMAIL_LINE =
  "Hi, this is an automated call — sorry to have missed you. We'll try again, or feel free to call us back. Have a good day.";

/**
 * Twilio's AMD model is US voicemail cadence. Non-NANP destinations (India
 * PSTN first among them) produce mid-call false "machine" labels. Campaign
 * dials to +1 still opt in; everything else stays off unless a caller
 * passes `amd: true` explicitly.
 */
export function shouldRequestTwilioAmd(to: string): boolean {
  const compact = to.replace(/[\s()\-.]/g, "");
  return /^\+1\d{10}$/.test(compact);
}

/**
 * Once a caller-role transcript line exists, this is a live conversation.
 * A later machine_* label is a false positive — never redirect off the
 * stream. Greeting-only (agent spoke, caller has not) still allows the
 * voicemail path, which is the US campaign case AMD exists for.
 */
export function shouldHijackLiveCallForAmd(input: {
  answeredBy: string;
  callerHasSpoken: boolean;
}): boolean {
  if (!AMD_MACHINE_ANSWERS.has(input.answeredBy)) return false;
  if (input.callerHasSpoken) return false;
  return true;
}
