/**
 * Spoken-output guard (ADR-104) — the last thing between a model's token
 * stream and the caller's ear.
 *
 * Why this exists. `runVoiceAgentTurn` (agent.ts) pipes `result.textStream`
 * straight into `onTextDelta`, and every consumer of that callback speaks it:
 * stream.ts sends it to TTS, test-call-stream.ts sends it to TTS, and the
 * accumulated string becomes the stored transcript. There was no output guard
 * of any kind. The only downstream filter is the tone-tag filter, which
 * strips a *leading* `[[tone:value]]` marker and nothing else.
 *
 * Two things were proven to reach that channel:
 *
 *   1. Raw tool-call syntax. Measured 2026-08-12: `groq/llama-3.1-8b-instant`
 *      requested through the AI Gateway is not served by Groq at all (routing
 *      metadata shows deepinfra), and that deployment emitted the tail of its
 *      own function-call envelope as ordinary assistant text in 4 of 6 runs:
 *          3"}</function>I've saved your order number, ORD-48213.
 *      A caller would hear the JSON spoken aloud, and the transcript would
 *      record it as something the agent said.
 *
 *   2. Bracket-grammar placeholders. Production call 24 spoke "Hi, is this
 *      [Caller Name]? This is [Agent Name] with presistentads", and call 22
 *      spoke "Hello, is this ? This is calling on behalf of krisn". Those come
 *      from the persona layer and ADR-104 fixes them there — this module is
 *      the independent second line, because a persona is user-editable text
 *      and no amount of authoring discipline in `docs/agent-prompts` can
 *      constrain what an operator types into the agent editor.
 *
 * Why a guard rather than model pinning. `agentFrame.llmModel` is free text
 * (agent-frame.ts) and `RECOMMENDED_LLM_MODELS` is explicitly documented as
 * "not an exhaustive/enforced list", so the set of models that can ever run a
 * turn is open by design. A guard holds for models nobody has benchmarked
 * yet; a benchmark holds only for the models in it.
 *
 * What it deliberately does NOT do: rewrite, rephrase, or substitute. It
 * deletes syntax that is never speech and leaves everything else byte-identical.
 * Same reasoning as merge-tags.ts — a placeholder is still a token the model
 * can repeat, and a guessed default is a false statement in the channel the
 * caller trusts most. Deletion degrades a sentence; substitution invents one.
 */

/**
 * Tool-call envelope syntax from the model families this platform can
 * plausibly route to. Every one of these is a literal control token that no
 * TTS engine should ever be asked to pronounce.
 *
 * Sources: Llama 3.x/4 (`<|python_tag|>`, `<function=...>`, `</function>`),
 * Qwen/Hermes-style (`<tool_call>`), DeepSeek (`<|tool▁calls▁begin|>` and its
 * unicode-triangle siblings), Mistral (`[TOOL_CALLS]`), plus the generic
 * `<|...|>` special-token shape used across all of them.
 */
const TOOL_SYNTAX_PATTERNS: RegExp[] = [
  /<\/?function(?:=[^>]*)?>/g,
  /<\/?tool_call>/g,
  /<\/?tool▁call[^>]*>/g,
  /\[\/?TOOL_CALLS\]/g,
  /<\|[^|>]{0,40}\|>/g,
];

/**
 * The JSON residue that precedes a leaked envelope. In the measured leak the
 * spoken text began `3"}</function>` — the tail of `{"value":"ORD-48213"}`,
 * with everything before it consumed as a real tool call. Anchored to the
 * very start of a turn and capped at a few characters, because that is the
 * only place this shape occurs: a turn's actual speech never opens with a
 * quote-brace, but a sentence mid-turn can legitimately contain both.
 */
const LEADING_JSON_RESIDUE = /^[\s\w.,:-]{0,8}["'`]?\s*[}\]]+\s*/;

/**
 * Bracket-grammar placeholder, e.g. `[Agent Name]`, `[Caller Name]`,
 * `[Agent_name: ]`, `[YOUR NAME]`. Requires an initial capital so ordinary
 * bracketed prose is left alone, and caps the span so a long parenthetical
 * aside can never be swallowed.
 *
 * Double brackets are excluded by construction: `[[tone:calm]]` starts with
 * `[[`, and the tone tag is this platform's own live protocol between the LLM
 * and Cartesia (tone-tags.ts). Stripping it here would silently disable
 * expressive delivery, so the pattern requires a non-bracket first character.
 */
const BRACKET_PLACEHOLDER = /\[(?!\[)[A-Z][A-Za-z0-9_ .:'-]{1,38}\]/g;

/**
 * Markdown emphasis (ADR-106). Production call 25 spoke:
 *
 *     *Sending text message...* [[tone:upbeat]] And that's everything I need...
 *
 * The asterisks are syntax and are deleted here on the same rule as
 * everything above: a control character is never speech. The *words* inside
 * them are deliberately kept, because this module's contract is "delete
 * syntax, never rewrite a sentence" — an emphasis span can legitimately wrap
 * a real word (`*really* important`), and there is no chunk-safe way to tell
 * that apart from a stage direction when the guard sees the stream in deltas
 * whose boundaries are not line boundaries.
 *
 * That leaves "Sending text message..." still spoken. It is a model
 * self-narration defect, not a syntax defect, and it is fixed where it is
 * caused — a call-control rule in agent.ts forbidding both the narration and
 * the markdown. Two partial layers, stated plainly, in preference to one
 * clever regex that eats a word every so often.
 */
const MARKDOWN_EMPHASIS = /\*+/g;

/** Longest span any pattern above can match. Past this length an unclosed
 * bracket cannot become one of them, so it is ordinary text. */
const MAX_PATTERN_SPAN = 44;

/**
 * The only two characters that can open a pattern above. Finding the last
 * *unclosed* one is what the streaming guard holds back on — see
 * `speakableSplit`.
 */
const OPENERS: Record<string, string> = { "<": ">", "[": "]" };

/**
 * Splits accumulated text into "safe to emit now" and "must keep buffering".
 *
 * The naive streaming guard holds back a fixed window on every turn, which on
 * this pipeline means delaying the first TTS byte of every reply to defend
 * against syntax that almost never appears — paying a latency tax on all
 * traffic for the benefit of a fraction of it. Instead: hold back only from
 * the last *unclosed* `<` or `[`, since a control token cannot be recognized
 * until its closer arrives, and nothing else in the stream can be a partial
 * match. Text with no dangling opener is emitted with zero added delay, which
 * is the overwhelming majority of turns.
 *
 * `[[tone:calm]]` is unaffected: its `]` closes it in the same delta run, so
 * it flows straight through to the tone filter that owns it.
 */
export function speakableSplit(text: string): { safe: string; hold: string } {
  for (let i = text.length - 1; i >= 0; i--) {
    const closer = OPENERS[text[i]!];
    if (!closer) continue;
    // Closed, or already too long to be a pattern — everything is emittable.
    if (text.length - i > MAX_PATTERN_SPAN) break;
    if (text.includes(closer, i + 1)) break;
    return { safe: text.slice(0, i), hold: text.slice(i) };
  }
  return { safe: text, hold: "" };
}

export type OutputGuardFinding = "tool-syntax" | "json-residue" | "bracket-placeholder" | "markdown-syntax";

/**
 * Cleans one already-complete string. Exported for the non-streaming callers
 * (the synthetic harness scores whole turns) and for direct unit testing;
 * `createOutputGuard` below is the streaming wrapper around it.
 */
export function scrubSpokenText(text: string, options?: { atTurnStart?: boolean }): {
  text: string;
  findings: OutputGuardFinding[];
} {
  const findings: OutputGuardFinding[] = [];
  let out = text;

  for (const pattern of TOOL_SYNTAX_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      if (!findings.includes("tool-syntax")) findings.push("tool-syntax");
      out = out.replace(pattern, "");
    }
  }

  // Only meaningful once the envelope above is gone, and only at a turn's
  // very first characters — see LEADING_JSON_RESIDUE.
  if (options?.atTurnStart && findings.includes("tool-syntax")) {
    const trimmed = out.replace(LEADING_JSON_RESIDUE, "");
    if (trimmed !== out) {
      findings.push("json-residue");
      out = trimmed;
    }
  }

  BRACKET_PLACEHOLDER.lastIndex = 0;
  if (BRACKET_PLACEHOLDER.test(out)) {
    findings.push("bracket-placeholder");
    out = out.replace(BRACKET_PLACEHOLDER, "");
  }

  MARKDOWN_EMPHASIS.lastIndex = 0;
  if (MARKDOWN_EMPHASIS.test(out)) {
    findings.push("markdown-syntax");
    out = out.replace(MARKDOWN_EMPHASIS, "");
  }

  if (findings.length > 0) {
    // Repair only what removal broke: doubled spaces and a space stranded
    // before punctuation. Newlines are preserved — the LLM uses them for
    // sentence chunking downstream.
    out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;:!?])/g, "$1");
  }

  return { text: out, findings };
}

export interface OutputGuard {
  /** Feed one streamed delta; forwards everything that is safe to speak. */
  push(delta: string): void;
  /** End of stream — release whatever is still held back. */
  flush(): void;
  /** Distinct findings seen this turn, in first-appearance order. */
  findings(): OutputGuardFinding[];
}

/**
 * Streaming guard. Buffers only from a dangling `<` or `[` (see
 * `speakableSplit`) so a control token split across deltas (`</fun` +
 * `ction>`) is recognized as one token instead of emitted as two
 * harmless-looking halves — while a turn containing neither character is
 * forwarded with no added latency at all.
 *
 * `flush()` is mandatory, not an optimization: a turn ending on a dangling
 * bracket would otherwise never be spoken. That exact defect — a buffer with
 * no flush path silently muting turns in production — is ADR-101, in this same
 * pipeline, which is why the contract is stated here rather than left to the
 * caller to infer.
 */
export function createOutputGuard(sink: { onText: (text: string) => void }): OutputGuard {
  let pending = "";
  const seen: OutputGuardFinding[] = [];
  let emittedAnything = false;
  /**
   * Trailing whitespace is carried rather than emitted, because the damage a
   * removal leaves behind straddles the emit boundary: stripping
   * `[Caller Name]` out of "is this [Caller Name]?" produces "is this " and
   * "?" as two separate emissions, and neither one can see the other to repair
   * the stranded space. Carrying the space forward is what turns that back
   * into "is this?" instead of the "Hello, is this ?" production call 22
   * actually spoke.
   */
  let whitespaceCarry = "";

  function emit(chunk: string, findings: OutputGuardFinding[]) {
    for (const f of findings) if (!seen.includes(f)) seen.push(f);
    let out = whitespaceCarry + chunk;
    whitespaceCarry = "";
    // Only repair when something was actually removed at some point this turn —
    // a clean turn must pass through byte-identical, whitespace included.
    if (seen.length > 0) out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;:!?])/g, "$1");
    const held = /[ \t]+$/.exec(out);
    if (held) {
      whitespaceCarry = held[0];
      out = out.slice(0, out.length - held[0].length);
    }
    if (!out) return;
    emittedAnything = true;
    sink.onText(out);
  }

  return {
    push(delta: string) {
      if (!delta) return;
      pending += delta;
      const { safe, hold } = speakableSplit(pending);
      if (!safe) return;
      pending = hold;
      const { text, findings } = scrubSpokenText(safe, { atTurnStart: !emittedAnything });
      emit(text, findings);
    },
    flush() {
      if (!pending) {
        // A turn that ended on carried whitespace needs nothing spoken.
        whitespaceCarry = "";
        return;
      }
      const { text, findings } = scrubSpokenText(pending, { atTurnStart: !emittedAnything });
      pending = "";
      emit(text, findings);
      whitespaceCarry = "";
    },
    findings() {
      return [...seen];
    },
  };
}
