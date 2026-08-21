/**
 * ADR-120 — a captured field must name the utterance it came from.
 *
 * The matcher behind the `heard` argument on `captureField`. Pure, synchronous,
 * no I/O: it answers one question — do these words appear in what the caller
 * actually said on this call?
 *
 * Why this is deterministic string matching and not a model call: the thing
 * being guarded is a write to ground truth, and the failure it exists to stop
 * is a *model* inventing an answer. A checker that can itself invent is not a
 * check. This one is weaker than an LLM judge on purpose — it can be fooled by
 * a model that quotes an unrelated fragment (named in ADR-120's "known and
 * unfixed") — but it cannot fail open in the one direction that matters, and it
 * costs nothing on the hot path.
 *
 * Matching is token-sequence containment, not substring containment. `"no"`
 * must not match because the caller said `"I don't know"`, and it must not match
 * `"kind"` either — call 2's actual caller line was *"just do some kind of
 * drinks"*, and a naive `includes("no")` on unnormalized text is exactly the
 * kind of accidental pass that would have let the tobacco fabrication through
 * the guard built to stop it.
 */

/**
 * Lowercases, strips everything that is not a letter, digit or space, and
 * collapses whitespace — then splits into tokens.
 *
 * Punctuation and case are removed because they are STT artifacts, not caller
 * intent: the transcript may render "no, I don't" where the model quotes "no I
 * don't", and refusing that would be grading transcription rather than checking
 * provenance. Digits are kept as their own tokens so "1985" still matches
 * "1985"; a caller who says "nineteen eighty five" against a model quoting
 * "1985" will *not* match, and that refusal is intended — it is counted in
 * `guardrail_events` so the rate is measurable rather than argued about.
 */
export function tokenizeSpeech(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Apostrophes are DELETED, not turned into a space: "don't" and "dont"
      // are the same spoken word, and splitting on the apostrophe would make
      // them "don t" vs "dont" and refuse an honest quote over a transcription
      // convention. Covers the straight and curly forms, since STT emits both.
      .replace(/['‘’]/g, "")
      // \p{M} is kept alongside \p{L}: Devanagari matras are combining marks,
      // not letters, so stripping them turns "हाँ" into "ह" and quietly makes
      // every Hindi/Marathi quote unmatchable. Weeber's production calls are
      // Hindi-capable, so this is a live path, not a hypothetical.
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0)
  );
}

/**
 * True when `heard`'s tokens appear as a contiguous run inside `callerTokens`.
 *
 * `callerTokens` is the running concatenation of this call's caller-role
 * transcript text, in order. Concatenated rather than checked per-row (ADR-120)
 * because STT splits a single spoken sentence across rows unpredictably, and a
 * quote that spans a split is an honest quote.
 *
 * Empty `heard` is never a match: an absent provenance claim is the failure
 * mode this whole mechanism exists to refuse, so it must not fall through to
 * "the empty sequence is contained in everything".
 */
export function heardInCallerSpeech(heard: string, callerTokens: string[]): boolean {
  const needle = tokenizeSpeech(heard);
  if (needle.length === 0) return false;
  if (needle.length > callerTokens.length) return false;
  for (let i = 0; i <= callerTokens.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (callerTokens[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}
