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

/** The tag in its intended position: the very start of a turn, which is
 * where the prompt asks for it and where the tone value is authoritative. */
const TONE_TAG_LEADING = /^\s*\[\[tone:([a-zA-Z]+)\]\]\s*/;

/**
 * The same tag *anywhere* in the text (ADR-106).
 *
 * This used to be leading-only, on the stated reasoning that "a tone tag
 * mid-sentence is never valid, so this never risks stripping something that
 * looks similar but isn't the real marker." Both halves were true and the
 * conclusion was still wrong: mid-sentence tags are not valid, but the model
 * emits them anyway, and when it does the anchor's only effect is that the
 * caller hears one.
 *
 * Production call 25 (2026-08-10) spoke:
 *
 *     *Sending text message...* [[tone:upbeat]] And that's everything I need...
 *
 * The stage direction ahead of the tag is 23 characters, so the streaming
 * filter below hit TONE_TAG_MAX_BUFFER_CHARS, correctly concluded "no leading
 * tag is coming", released — and then forwarded the tag itself as ordinary
 * speech, because after resolution the filter passed deltas straight through.
 *
 * The tag is this platform's own control token. It is never speech, in any
 * position, whatever put it there. Position decides whether the *tone* is
 * trustworthy; it does not decide whether the *characters* may be spoken.
 */
const TONE_TAG_ANYWHERE = /\[\[tone:([a-zA-Z]+)\]\]/g;

/** Longest possible valid tag, `[[tone:empathetic]]`, is 19 characters —
 * buffering more than this without a match means the model didn't emit a
 * tag this turn (or emitted something malformed), and the buffered text
 * should just be treated as normal speech instead of held back forever
 * waiting for a tag that isn't coming. */
export const TONE_TAG_MAX_BUFFER_CHARS = 24;

/**
 * Strips **every** `[[tone:value]]` marker in the text and reports the first
 * recognized tone (ADR-106 — see TONE_TAG_ANYWHERE for why "every" and not
 * "the leading one"). Always safe to call on text that never had one —
 * returns `{ tone: null, text }` unchanged.
 *
 * An unrecognized value inside a well-formed tag (model hallucinated a tone
 * not in TONE_VALUES) still gets stripped from the spoken text — the tag
 * must never reach the caller's ear even if it's not a tone this platform
 * knows how to apply.
 *
 * A leading tag also consumes the whitespace that follows it, so the turn
 * starts on its first real word. A tag found mid-text is removed along with
 * one adjacent space, which is what keeps "message... [[tone:upbeat]] And"
 * from becoming "message...  And".
 */
export function stripToneTag(text: string): { tone: ToneValue | null; text: string } {
  let tone: ToneValue | null = null;

  const recordTone = (raw: string) => {
    if (tone !== null) return;
    const lowered = raw.toLowerCase();
    if ((TONE_VALUES as readonly string[]).includes(lowered)) tone = lowered as ToneValue;
  };

  let out = text;
  const leading = TONE_TAG_LEADING.exec(out);
  if (leading) {
    recordTone(leading[1]!);
    out = out.slice(leading[0].length);
  }

  TONE_TAG_ANYWHERE.lastIndex = 0;
  if (TONE_TAG_ANYWHERE.test(out)) {
    TONE_TAG_ANYWHERE.lastIndex = 0;
    out = out.replace(TONE_TAG_ANYWHERE, (_match, value: string) => {
      recordTone(value);
      return "";
    });
    // Only the damage the removal caused: a doubled space where the tag used
    // to sit, and a space stranded before punctuation. Same repair as
    // output-guard.ts, and applied only when something was actually removed
    // so a clean turn passes through byte-identical.
    out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;:!?])/g, "$1");
  }

  return { tone, text: out };
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

  /**
   * Emits text with any tag in it removed. Used for every emission, not just
   * the first (ADR-106): the pass-through that ran after resolution is how
   * production call 25 spoke `[[tone:upbeat]]` out loud.
   */
  function emit(text: string): string {
    const { tone, text: clean } = stripToneTag(text);
    if (tone !== null) sink.onTone?.(tone);
    if (clean) sink.onText(clean);
    return clean;
  }

  return {
    push(delta: string) {
      if (!delta && resolved) return;
      buffer += delta;

      if (!resolved) {
        const complete = TONE_TAG_LEADING.test(buffer);
        const malformed = buffer.includes("]]");
        if (!complete && !malformed && buffer.length < TONE_TAG_MAX_BUFFER_CHARS) return;
        resolved = true;
      }

      // Past the leading-tag question, hold back only from a dangling `[`
      // that could still turn into a tag. Same shape as output-guard.ts's
      // speakableSplit and for the same reason: a tag arrives split across
      // deltas (`[[to` + `ne:calm]]`), and forwarding the halves separately
      // means neither one is recognizable and both are spoken. Text with no
      // dangling bracket — nearly every delta — is emitted with zero delay.
      const split = splitOnDanglingTag(buffer);
      buffer = split.hold;
      if (split.safe) emit(split.safe);
    },
    flush(): string {
      if (buffer.length === 0) return "";
      const pending = buffer;
      buffer = "";
      resolved = true;
      return emit(pending);
    },
  };
}

/**
 * Splits accumulated text at the last `[` that could still become a
 * `[[tone:value]]` tag. A bracket already followed by `]]`, or further back
 * than the longest possible tag, cannot — everything up to it is emittable.
 */
function splitOnDanglingTag(text: string): { safe: string; hold: string } {
  let idx = text.lastIndexOf("[");
  if (idx === -1) return { safe: text, hold: "" };
  // Back up over the run of brackets. `lastIndexOf` on "[[to" finds the
  // *second* bracket, and holding from there emits the first one as speech —
  // which is the same one-character leak this function exists to prevent.
  while (idx > 0 && text[idx - 1] === "[") idx--;
  if (text.length - idx > TONE_TAG_MAX_BUFFER_CHARS) return { safe: text, hold: "" };
  if (text.includes("]]", idx)) return { safe: text, hold: "" };
  return { safe: text.slice(0, idx), hold: text.slice(idx) };
}
