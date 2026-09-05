/**
 * Barge-in gate (pilot latency/quality audit F5).
 *
 * stream.ts used to cut the agent off on ANY non-empty interim STT result
 * while it was speaking — no confidence check, no minimum length, no
 * persistence check. A cough, a click, background speech, or the agent's own
 * TTS audio bleeding back into the line (a real risk on some carrier/SIP
 * trunk combinations) could all produce a stray one-off interim transcript
 * and kill the agent's turn mid-sentence. That reads to a caller as "the
 * agent randomly stopped talking," which is exactly the kind of thing a
 * pilot's "call quality" complaint is made of.
 *
 * The STT abstraction (stt/types.ts) doesn't expose a per-word confidence
 * score today — normalizing that across Deepgram/Sarvam/ElevenLabs is a
 * larger cross-provider change. Until then, the cheapest reliable signal
 * available from `{text, isFinal, speechFinal}` alone is PERSISTENCE: real
 * speech produces multiple consecutive non-empty interim results as the
 * person keeps talking; a noise artifact is almost always a single isolated
 * blip. Requiring the interim signal to repeat before committing to a
 * barge-in filters most single-frame noise while adding only the gap between
 * two interim results (Deepgram typically emits these every ~100-300ms) —
 * far below anything a caller would perceive as "the agent ignored me".
 *
 * Short, urgent interruptions ("Wait", "No", "Stop", "Sorry") must still cut
 * in on the very first interim — a debounce that delayed those would be
 * worse than the noise problem it's fixing. So the streak requirement is
 * skipped whenever the text already looks like deliberate speech: at least
 * BARGE_IN_MIN_CHARS characters. Short words used as interruptions are
 * exactly the case this exemption protects; what it still filters out is a
 * single-character/near-empty STT artifact.
 */

/** How many consecutive non-empty interim hits (while the agent is speaking)
 * are required before a SHORT fragment is allowed to trigger a barge-in.
 * Text at or above BARGE_IN_MIN_CHARS skips this and fires on the first hit. */
export const BARGE_IN_STREAK_REQUIRED = 2;

/** Text at or above this length is treated as deliberate speech and bypasses
 * the streak requirement — an urgent one-word interruption must cut in
 * immediately, not wait for a second interim result. */
export const BARGE_IN_MIN_CHARS = 4;

export type BargeInDecisionInput = {
  /** True only while the agent's own TTS is actively playing. */
  agentIsSpeaking: boolean;
  /** The interim (or final) transcript text for this STT event, untrimmed. */
  text: string;
  /** Consecutive non-empty interim hits so far THIS utterance, not counting
   * the current one — i.e. 0 on the first hit, 1 on the second, etc. Callers
   * own resetting this to 0 whenever the agent stops speaking, the utterance
   * ends, or a barge-in has just fired. */
  priorStreak: number;
  /**
   * Deepgram SpeechStarted (ADR-126). Counts as one short-fragment hit —
   * never fires barge-in by itself (a cough still trips VAD). Combined with
   * a following short interim it cuts in one Deepgram frame earlier than
   * waiting for two transcripts.
   */
  vad?: "speech_started";
};

export type BargeInDecision = {
  /** Whether to cut the agent off right now. */
  fire: boolean;
  /** The streak value the caller should carry into the next STT event for
   * this utterance (0 if this event doesn't count — e.g. agent wasn't
   * speaking, or text was empty). */
  nextStreak: number;
};

/**
 * Pure, deterministic: given the current state, should we barge in right
 * now? Unit-testable without the audio/STT path — see barge-in.test.ts.
 */
export function decideBargeIn(i: BargeInDecisionInput): BargeInDecision {
  if (i.vad === "speech_started") {
    if (!i.agentIsSpeaking) return { fire: false, nextStreak: 0 };
    const streak = i.priorStreak + 1;
    if (streak >= BARGE_IN_STREAK_REQUIRED) {
      return { fire: true, nextStreak: 0 };
    }
    return { fire: false, nextStreak: streak };
  }
  const trimmed = i.text.trim();
  if (!i.agentIsSpeaking || trimmed.length === 0) {
    return { fire: false, nextStreak: 0 };
  }
  if (trimmed.length >= BARGE_IN_MIN_CHARS) {
    // Long/deliberate enough to trust immediately — do not make an urgent
    // interruption wait for a second interim result.
    return { fire: true, nextStreak: 0 };
  }
  const streak = i.priorStreak + 1;
  if (streak >= BARGE_IN_STREAK_REQUIRED) {
    return { fire: true, nextStreak: 0 };
  }
  return { fire: false, nextStreak: streak };
}
