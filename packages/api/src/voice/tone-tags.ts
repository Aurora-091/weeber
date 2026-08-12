/**
 * Expressive delivery — Tier 1 of the "Advanced Cascaded" upgrade
 * (2026-07-17, docs/voice-ai-breakthrough-leverage-study-2026-07-17.md Part
 * 5). This platform's architecture is "Basic Cascaded" (ElevenLabs' own
 * 5-architecture framework: separate STT/LLM/TTS, plain text handoff) —
 * functional but flat, no delivery/tone control. Advanced Cascaded keeps
 * every guardrail/text-layer benefit of that architecture and adds exactly
 * one thing: the LLM tells the TTS *how* to say something, not just *what*.
 * Same category of feature as Retell's "Colloquial Model"/"Expressive Mode"
 * and ElevenLabs' own Expressive Mode (both shipped mid-2026, see
 * docs/competitor-changelog-scan-2026-07-17.md) — this is the from-scratch
 * version, built directly on Cartesia's real `generation_config.emotion`
 * field (confirmed against Cartesia's own docs, not guessed).
 *
 * Mechanism: the LLM is instructed (see TONE_INSTRUCTION_BLOCK) to prefix
 * every spoken turn with a `[[tone:value]]` marker, matched only at the very
 * start of the turn's text. stream.ts strips it before any of it ever
 * reaches TTS or the transcript/history — a caller never hears or sees the
 * marker itself, regardless of whether the tone application below is even
 * enabled for this call.
 */

/**
 * Deliberately a small, curated subset of Cartesia's full emotion vocabulary
 * (60+ values) rather than the whole list — a focused set an LLM can choose
 * from reliably every turn beats a large one it has to reason harder about,
 * and every value here maps to something a voice agent turn genuinely needs
 * (there's no "euphoric" or "flirtatious" case in a COD-confirmation call).
 */
export const TONE_VALUES = [
  "neutral",
  "calm",
  "empathetic",
  "apologetic",
  "upbeat",
  "reassuring",
  "urgent",
] as const;

export type ToneValue = (typeof TONE_VALUES)[number];

/** Only ever matched at the very start of a turn's accumulated text — a
 * tone tag mid-sentence is never valid, so this never risks stripping
 * something that looks similar but isn't the real marker. */
const TONE_TAG_REGEX = /^\s*\[\[tone:([a-zA-Z]+)\]\]\s*/;

/** Longest possible valid tag, `[[tone:empathetic]]`, is 19 characters —
 * buffering more than this without a match means the model didn't emit a
 * tag this turn (or emitted something malformed), and the buffered text
 * should just be treated as normal speech instead of held back forever
 * waiting for a tag that isn't coming. */
export const TONE_TAG_MAX_BUFFER_CHARS = 24;

/**
 * Strips a leading `[[tone:value]]` marker if present. Always safe to call
 * on text that never had one — returns `{ tone: null, text }` unchanged.
 * An unrecognized value inside a well-formed tag (model hallucinated a tone
 * not in TONE_VALUES) still gets stripped from the spoken text — the tag
 * must never reach the caller's ear even if it's not a tone this platform
 * knows how to apply.
 */
export function stripToneTag(text: string): { tone: ToneValue | null; text: string } {
  const match = TONE_TAG_REGEX.exec(text);
  if (!match) return { tone: null, text };
  const raw = match[1]!.toLowerCase();
  const tone = (TONE_VALUES as readonly string[]).includes(raw) ? (raw as ToneValue) : null;
  return { tone, text: text.slice(match[0].length) };
}

/**
 * Maps this platform's small curated tone vocabulary to Cartesia's real
 * `generation_config.emotion` values (confirmed against
 * docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion,
 * 2026-07-17 — the full list there is 60+ values; these are the specific
 * ones each of our 7 map to). Cartesia's docs note emotion tags are
 * "guidance... only work when consistent with the transcript" — this is
 * inherent to Cartesia's model, not something this mapping can fix; a
 * mismatched tone (model says "apologetic" about genuinely good news) will
 * simply be ignored by Cartesia rather than sounding wrong, per their docs.
 */
export const CARTESIA_EMOTION_BY_TONE: Record<ToneValue, string> = {
  neutral: "neutral",
  calm: "calm",
  empathetic: "sympathetic",
  apologetic: "apologetic",
  upbeat: "excited",
  reassuring: "trust",
  urgent: "determined",
};

/**
 * Opt-in org/global feature flag (see org-queries.ts's getEffectiveFlags) —
 * same kill-switch pattern as ADAPTIVE_NOISE_FILTER_FLAG/WIND_NOISE_FILTER_
 * FLAG. Gates only whether stream.ts actually calls `tts?.setTone?.(...)`
 * for a call — the tone tag itself is *always* stripped before reaching TTS
 * or the transcript regardless of this flag (see stream.ts), so turning
 * this off never risks a caller hearing "tone colon calm" spoken aloud,
 * it just means Cartesia doesn't get the emotion hint applied. The prompt
 * instruction below is unconditional (every persona gets it) rather than
 * flag-gated too — resolveAgentConfig and getEffectiveFlags currently run
 * concurrently in stream.ts's "start" handler (2026-07-17 latency fix), so
 * gating the instruction itself would mean waiting on the flag lookup
 * before persona resolution can start, undoing that parallelization for a
 * cheap, static addition to the system prompt.
 */
export const EXPRESSIVE_DELIVERY_FLAG = "expressive-delivery";

/** Appended to every persona in agent.ts's withCallControl — see that call
 * site for why this is unconditional (always instructed) while the actual
 * Cartesia application is flag-gated in stream.ts, not this instruction
 * itself. */
export const TONE_INSTRUCTION_BLOCK = `Delivery:
- Before the actual words of every spoken turn, silently decide the single best-fitting tone for
  that turn from exactly this list: neutral, calm, empathetic, apologetic, upbeat, reassuring,
  urgent. Prefix the turn with it in this exact format, nothing else on that line: [[tone:VALUE]]
  — then continue immediately with the real words, on the same line, no line break.
- Never mention, explain, or speak the tag itself. It is stripped before anyone hears it — it
  exists purely to tell the voice how to say the words that follow, not to be read aloud.
- Example: [[tone:apologetic]] I'm sorry about that — let me see what I can do.`;

/**
 * Streaming tone-tag filter — the per-turn state machine that pulls a leading
 * `[[tone:value]]` marker out of an LLM's *streamed* deltas before any of it
 * reaches TTS. Lifted out of a closure inside stream.ts's speak() on
 * 2026-08-12 for one reason: as a closure in a 2000-line file it had no
 * caller a test could reach, and it was silently muting turns in production
 * (see ADR-101). Same defect class as ADR-090 — untestable placement is how
 * this survived.
 *
 * The hold-back: until the tag is resolved, deltas accumulate instead of
 * being forwarded, because `[[tone:calm]]` arrives split across several
 * deltas and half a tag must never be spoken. Resolution happens on the
 * first of: a complete tag matched, any `]]` seen (malformed tag — stop
 * waiting), or TONE_TAG_MAX_BUFFER_CHARS accumulated (no tag is coming).
 *
 * `flush()` is the part that was missing. A turn whose ENTIRE text is
 * shorter than the cap and contains no `]]` never hits any of the three
 * resolution conditions, so the buffer was still holding every character of
 * it when the turn ended — and the caller heard pure silence while the
 * transcript recorded the line as spoken. Call 21 turn 3 in production
 * (2026-08-09) is the reference case: the LLM produced "OK.", TTS was handed
 * nothing at all (`turn_latency.tts_first_byte_ms` is NULL on that row while
 * `llm_ttft_ms` is 2779), and the caller was then transferred having heard
 * dead air. Every short reply — "Sure, one moment." "Got it, thanks." — was
 * exposed to this whenever the model skipped the tag it was asked for.
 */
export interface ToneTagFilter {
  /** Feed one streamed delta. Forwards speakable text to `onText` as soon as
   * the tag question is settled, holding it back until then. */
  push(delta: string): void;
  /**
   * End of stream — release anything still held back. Returns the text it
   * emitted (empty string when there was nothing left, which is the normal
   * case), so a caller can tell "this turn was rescued from the buffer"
   * apart from "nothing was pending" and log accordingly.
   *
   * Safe to call more than once, and safe to call on a turn that already
   * resolved normally.
   */
  flush(): string;
}

export function createToneTagFilter(sink: {
  /** Called at most once per turn, only when a *recognized* tone was
   * matched. Whether to act on it is the caller's decision (stream.ts gates
   * it on EXPRESSIVE_DELIVERY_FLAG); the tag is stripped either way. */
  onTone?: (tone: ToneValue) => void;
  onText: (text: string) => void;
}): ToneTagFilter {
  let buffer = "";
  let resolved = false;

  /** Shared by push() and flush(): strip whatever tag is there (if any),
   * mark the turn resolved, and emit the remainder. Returns what it emitted. */
  function release(): string {
    const { tone, text } = stripToneTag(buffer);
    resolved = true;
    buffer = "";
    if (tone !== null) sink.onTone?.(tone);
    if (text) sink.onText(text);
    return text;
  }

  return {
    push(delta: string) {
      if (resolved) {
        if (delta) sink.onText(delta);
        return;
      }
      buffer += delta;
      const complete = TONE_TAG_REGEX.test(buffer);
      const malformed = buffer.includes("]]");
      if (complete || malformed || buffer.length >= TONE_TAG_MAX_BUFFER_CHARS) release();
    },
    flush(): string {
      if (resolved || buffer.length === 0) return "";
      return release();
    },
  };
}
