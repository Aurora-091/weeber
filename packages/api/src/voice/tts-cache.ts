/**
 * Misc-7: hybrid pre-recorded audio for static, verbatim script lines.
 *
 * Today every line the agent speaks goes through fresh TTS synthesis on
 * every call, including lines that are 100% deterministic — same text,
 * same voice, same language, every time (the silence-timeout re-prompt and
 * goodbye in stream.ts's speakCannedLine — see its own doc comment for why
 * the greeting/closing lines are deliberately NOT in scope here: they're
 * LLM-paraphrased from a template, not verbatim, so caching wouldn't be
 * correct without a separate product decision to make them literal).
 *
 * In-memory, process-local — same tradeoff as fixed-window-limiter.ts and
 * session-store.ts's default backend: fine for a single instance, and the
 * cost of a cold cache after a restart is just "the first call after
 * restart pays full TTS latency for this one line, same as today."
 *
 * Gated behind the "hybrid-audio-cache" org/global feature flag (see
 * org-queries.ts's getEffectiveFlags) — opt-in staged rollout rather than a
 * silent behavior change, since it's new enough to want a kill switch.
 */

export const HYBRID_AUDIO_CACHE_FLAG = "hybrid-audio-cache";

const cache = new Map<string, string>();

function cacheKey(provider: string, voiceId: string | undefined, language: string | undefined, text: string): string {
  return `${provider}:${voiceId ?? "default"}:${language ?? "default"}:${text}`;
}

/** Returns the cached base64 mu-law audio for this exact (provider, voice,
 * language, text) combination, if it's been synthesized before. */
export function getCachedTtsAudio(
  provider: string,
  voiceId: string | undefined,
  language: string | undefined,
  text: string,
): string | undefined {
  return cache.get(cacheKey(provider, voiceId, language, text));
}

/** Stores freshly-synthesized audio so the next call with this exact
 * (provider, voice, language, text) combination can skip live TTS
 * entirely. Concatenating streamed chunks into one buffer, rather than
 * caching per-chunk, is deliberate — a cache hit replays as a single
 * outbound media frame (same approach dtmf.ts uses for tone audio), which
 * is simpler and fine for these short, one-off lines. */
export function setCachedTtsAudio(
  provider: string,
  voiceId: string | undefined,
  language: string | undefined,
  text: string,
  base64Chunks: string[],
): void {
  if (base64Chunks.length === 0) return;
  const buffers = base64Chunks.map((chunk) => Buffer.from(chunk, "base64"));
  const combined = Buffer.concat(buffers).toString("base64");
  cache.set(cacheKey(provider, voiceId, language, text), combined);
}

/** Test-only escape hatch — production code never needs to clear this. */
export function clearTtsCacheForTests(): void {
  cache.clear();
}
