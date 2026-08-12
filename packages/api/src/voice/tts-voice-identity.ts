import type { TtsProvider } from "./tts/types";

/**
 * Voice identity across a TTS provider switch — "does the caller keep hearing
 * the same person for the whole call?"
 *
 * Two facts make this a real hazard rather than a theoretical one:
 *
 * 1. **A voice ID is only meaningful to the provider it came from.** Cartesia
 *    IDs are opaque UUID-ish strings from `api.cartesia.ai/voices`, ElevenLabs
 *    IDs are its own catalog IDs (interpolated straight into the WebSocket URL
 *    *path*), and Sarvam takes a fixed *speaker name* ("anushka", "shubh", …).
 *    They are stored as a pair with the provider they were picked from
 *    (`org_agent_configs.voice_provider` + `voice_id`, rendered by a picker
 *    that is already scoped to the selected provider).
 * 2. **Every adapter fails open on a foreign ID.** `tts/cartesia.ts`,
 *    `tts/elevenlabs.ts` and `tts/sarvam.ts` all fall back to that provider's
 *    own voice (`resolveVoiceId`, tts/default-voices.ts) rather than rejecting
 *    an ID that isn't theirs, so handing provider B an ID belonging to
 *    provider A either errors the turn outright or silently synthesizes in B's
 *    fallback voice. Neither surfaces as a config error; both are heard by the
 *    caller as the agent becoming a different person mid-call.
 *
 *    Corrected 2026-08-12 (ADR-102): that fallback used to be
 *    `process.env.<PROVIDER>_VOICE_ID`, which made this module's "no ID is
 *    safer than a foreign ID" guarantee depend on a deployment-level env var
 *    that was never set for ElevenLabs in production — so the withheld-ID path
 *    this module deliberately takes during failover produced a request against
 *    voice `undefined`, not a voice. The fallback is a code constant now, so
 *    "no ID" genuinely means "that provider's own voice".
 *
 * `stream.ts` can switch TTS provider mid-call in exactly one place: the
 * per-turn cross-provider failover chain (`voice/failover.ts`). This module is
 * the pure "which voice ID, if any, is legal for the provider we're about to
 * connect to" rule so that decision lives in one testable place instead of
 * inline in the call state machine.
 *
 * Related: ADR-060 rejects mid-call spoken-*language* switching on exactly this
 * voice-identity reasoning ("a Sarvam Hindi speaker and a Cartesia English
 * voice are literally different voices"). The same reasoning applies to
 * failover, which is why `stream.ts` keeps a failover sticky for the rest of
 * the call instead of flipping back to the primary provider on the next turn.
 */
export function voiceIdForProvider(
  /** The agent's configured voice ID (`agent-frame.ts`'s `voiceId`), if any. */
  voiceId: string | undefined,
  /**
   * The provider that voice ID belongs to. `undefined` means "we don't know
   * who owns this ID", and it is deliberately treated the same as a mismatch:
   * a foreign ID is worse than no ID at all, because no ID means the target
   * provider uses its own configured default voice instead of erroring or
   * substituting one at random.
   */
  voiceIdProvider: TtsProvider | undefined,
  /** The provider we are about to open a connection to. */
  attemptProvider: TtsProvider,
): string | undefined {
  if (!voiceId) return undefined;
  if (!voiceIdProvider) return undefined;
  return voiceIdProvider === attemptProvider ? voiceId : undefined;
}
