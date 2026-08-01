/**
 * Last-line-of-defense scrub for unresolved `{{merge_tags}}` in a composed
 * system prompt (G1.3, 2026-08-01).
 *
 * Why this exists at all. A persona prompt is not authored in code — it's the
 * full text of a `docs/agent-prompts/*.md` file, loaded verbatim into
 * `agentTemplates.defaultPersonaPrompt` by the seeder (`database/seed.ts`), and
 * from 2026-07 onward it can also be a string a *user* typed into the agent
 * editor. Those prompts were written with `{{merchant_name}}`-style tags in
 * them, but the only thing the runtime ever rendered was
 * `literalGreetingTemplate` (`voice/stream.ts`) — the persona body was assigned
 * raw. So the agent could, and on a stock cart-recovery call would, read
 * "calling on behalf of {{merchant_name}}" and just say that out loud to a
 * customer.
 *
 * The fix is NOT "render the persona too". That was considered and rejected:
 *
 *   - The two tag vocabularies don't match. The workflow engine's real context
 *     keys (`MERGE_TAGS` in `workflows/graph-types.ts`) are `shop_name`,
 *     `cart_value`, `checkout_url`; the prompt docs say `merchant_name`,
 *     `cart_total`, `checkout_link`. Rendering would need an alias table whose
 *     only job is to hide that drift.
 *   - Some tags have no producer at all. Nothing anywhere in the codebase ever
 *     writes `cart_items_summary`. It could never resolve, so rendering would
 *     leave exactly the bug we're fixing.
 *   - Most importantly it's the wrong shape. A tag is a *hole where a value
 *     goes*; if the value is missing the model should be told nothing, not
 *     handed a hole. Per-call values already have a correct delivery channel —
 *     `buildWorkflowFactsBlock` / `buildKnownFactsBlock` / `buildIdentityBlock`
 *     — which emit a line only when the fact is actually known, so an unknown
 *     fact is silently absent instead of speakable.
 *
 * So: prompts supply *instructions*, blocks supply *values*, and this module
 * guarantees the first can never masquerade as the second. It runs on the final
 * composed string at the single `streamText({ system })` call site, which
 * covers every caller — live calls, the text test-chat, the synthetic harness,
 * and the preview drawer — rather than trusting ten markdown files to stay
 * clean forever.
 */

/**
 * Matches a `{{tag}}` with the same grammar `renderTemplate`
 * (`workflows/variables.ts`) uses, so anything that renderer *would* have
 * substituted is exactly what this scrubs. Deliberately `\w+` only — a stray
 * `{{` in prose (or a JSON example containing `{{`) isn't a merge tag and is
 * left alone.
 */
const MERGE_TAG_PATTERN = /\{\{(\w+)\}\}/g;

export type MergeTagScrubResult = {
  /** The prompt with every `{{tag}}` removed and whitespace repaired. */
  text: string;
  /** Distinct tag names that were stripped, in first-appearance order. Empty on a clean prompt. */
  stripped: string[];
};

/**
 * Removes every unresolved `{{tag}}` from a composed system prompt.
 *
 * Removal — not substitution with a placeholder like `<unknown>` or a guessed
 * default like "our store". A placeholder is still a token the model can
 * repeat, and a guessed default is worse: it's a *false statement* delivered in
 * the model's most trusted channel. Deleting the hole degrades the sentence to
 * a slightly vaguer instruction ("calling on behalf of ."), which the model
 * handles gracefully, and leaves the real value to arrive through a facts
 * block if it's known.
 *
 * Whitespace is repaired so the residue doesn't read as damage: a tag that was
 * the only thing on its line takes the line with it, and doubled spaces left
 * behind collapse. Newlines are otherwise preserved — these prompts are
 * markdown and their structure carries meaning.
 */
export function stripUnresolvedMergeTags(prompt: string): MergeTagScrubResult {
  const stripped: string[] = [];
  MERGE_TAG_PATTERN.lastIndex = 0;
  for (const match of prompt.matchAll(MERGE_TAG_PATTERN)) {
    const name = match[1]!;
    if (!stripped.includes(name)) stripped.push(name);
  }
  if (stripped.length === 0) return { text: prompt, stripped };

  const text = prompt
    .replace(MERGE_TAG_PATTERN, "")
    // A line that held nothing but a tag (plus list/table punctuation) is now
    // noise — drop it rather than leaving a dangling bullet.
    .replace(/^[ \t]*[-*|]?[ \t]*$\n/gm, "")
    // Collapse the double spaces and space-before-punctuation the removal left.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1");

  return { text, stripped };
}

/**
 * Convenience wrapper for the hot path: scrub, and warn once per call with the
 * tag names so an authoring mistake is *observable* rather than silently
 * papered over. The warning is the point — this function succeeding quietly
 * every time would mean nobody ever fixes the prompt.
 *
 * `label` identifies the caller (e.g. a callSid or "preview") in the log line.
 */
export function scrubSystemPrompt(prompt: string, label?: string): string {
  const { text, stripped } = stripUnresolvedMergeTags(prompt);
  if (stripped.length > 0) {
    console.warn(
      `[voice] system prompt contained ${stripped.length} unresolved merge tag(s) — stripped before send` +
        `${label ? ` (${label})` : ""}: ${stripped.map((t) => `{{${t}}}`).join(", ")}`,
    );
  }
  return text;
}
