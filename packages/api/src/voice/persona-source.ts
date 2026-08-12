/**
 * Persona source: the runtime/authoring split (ADR-104).
 *
 * `docs/agent-prompts/*.md` serves two audiences that were, until this module,
 * the same bytes. `seedAgentTemplates()` read each file with `Bun.file().text()`
 * and wrote the WHOLE document into `agent_templates.default_persona_prompt`,
 * so every word written for a human editing the template — the `**File:**`
 * header, the regulatory-grounding pointer, "Why this template exists", the
 * tools mapping table, the "Known gap" note — was shipped to the model as if it
 * were instructions to an agent on a live call.
 *
 * Measured before the split: 60-87% of each seeded persona was runtime content,
 * so 13-40% was editorial prose addressed to a maintainer. The launch agent
 * (`09-insurance-final-expense-qualifier-agent.md`) was the worst at 60/40 and
 * 19,480 characters. That is not merely wasteful. It is causally implicated in
 * how the agent actually sounded on production calls 22 and 24, which spoke:
 *
 *   "Hello, is this ? This is calling on behalf of krisn"
 *   "Hi, is this [Caller Name]? This is [Agent Name] with presistentads"
 *
 * — a persona that reads like a document to be recited produces an agent that
 * recites, including reciting the parts that were never meant to be said.
 *
 * The fix is an explicit contract instead of an implicit one: the file declares
 * which regions are runtime with `<!-- runtime:begin -->` / `<!-- runtime:end -->`
 * and everything outside them is for maintainers only. Multiple regions are
 * supported so a file can interleave runtime guidance with editorial commentary
 * rather than being forced into one contiguous block.
 *
 * Absent markers are an ERROR, never a fall-back-to-whole-file. A silent
 * fallback would reproduce exactly the defect this module exists to remove, and
 * would do it invisibly the moment someone adds a tenth prompt file — the same
 * shape as the seed path's earlier off-by-one, which skipped every template
 * while logging success (see `seedAgentTemplates`).
 */

export const RUNTIME_BEGIN = "<!-- runtime:begin -->";
export const RUNTIME_END = "<!-- runtime:end -->";

/** Thrown for any malformed persona source. Never swallowed by the seed path. */
export class PersonaSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaSourceError";
  }
}

/**
 * Prose that is addressed to a human maintaining the template, not to an agent
 * on a call. If any of this survives into an extracted runtime region, the
 * markers were placed wrongly — the model would be reading instructions about
 * the file rather than instructions for the call.
 *
 * Deliberately literal rather than clever: a heuristic that guesses at "editor
 * voice" would drift, and a false pass here is exactly the failure mode being
 * closed. Each entry earned its place by appearing in the 9 seeded files.
 */
export const AUTHORING_MARKERS: readonly string[] = [
  "**File:**",
  "Workflow name:",
  "Regulatory grounding:",
  "Read it before editing",
  "Why this template exists",
  "## Tools",
  "## What this agent does NOT run",
  "Known gap",
  "Variables** (from",
  "| Variable | Source |",
];

/**
 * Bracket-grammar slots such as `[Agent_name: {{agent_name}}]`, `[Caller Name]`
 * or `[Agent Name]`. These are the direct cause of the call-24 transcript.
 *
 * `stripUnresolvedMergeTags` in `merge-tags.ts` only understands `{{tag}}`
 * (`MERGE_TAG_PATTERN = /\{\{(\w+)\}\}/g`), so on an unconfigured org it removed
 * the `{{agent_name}}` inside the brackets and left the brackets and their label
 * standing — and the model then read the leftover slot aloud as if it were part
 * of the greeting. `merge-tags.ts` documents that removal degrades "gracefully";
 * production call 22 falsifies that claim. Runtime regions may not contain this
 * grammar at all: a placeholder the merge layer cannot see is a placeholder that
 * reaches the caller's ear.
 *
 * Scoped to Title_Case / Title Case labels of one to four words so ordinary
 * markdown brackets (links, `[optional]`, `[yes/no]`) are not flagged.
 */
export const BRACKET_SLOT_PATTERN = /\[[A-Z][A-Za-z]*(?:[ _][A-Za-z]+){0,3}(?::[^\]]*)?\]/g;

export interface PersonaExtraction {
  /** The runtime regions, joined, trimmed. This is what the model receives. */
  runtime: string;
  /** How many marked regions the file declared. */
  regionCount: number;
  /** Characters of runtime content vs. the whole file, for the size budget. */
  runtimeChars: number;
  sourceChars: number
}

/**
 * Pull the runtime persona out of an authoring document.
 *
 * @throws PersonaSourceError when markers are missing, unbalanced, nested,
 * out of order, or when a region is empty. Every one of those means a human
 * edited a persona file and the result is ambiguous; guessing is worse than
 * failing, because the guess ships to a caller.
 */
export function extractRuntimePersona(source: string, fileName: string): PersonaExtraction {
  const where = `${fileName}: `;
  const beginCount = countOccurrences(source, RUNTIME_BEGIN);
  const endCount = countOccurrences(source, RUNTIME_END);

  if (beginCount === 0 && endCount === 0) {
    throw new PersonaSourceError(
      `${where}no ${RUNTIME_BEGIN} / ${RUNTIME_END} markers. Every seeded prompt file must declare which regions are spoken-agent runtime content; the rest of the document is for maintainers and must not be sent to the model. Add the markers around the persona itself (identity, tone, goal, guardrails, conversation guidance, closings) and leave the editorial sections outside them.`,
    );
  }
  if (beginCount !== endCount) {
    throw new PersonaSourceError(
      `${where}unbalanced runtime markers — ${beginCount} ${RUNTIME_BEGIN} vs ${endCount} ${RUNTIME_END}.`,
    );
  }

  // Checked before the walk: a stray END before the first BEGIN passes the
  // balance check above, and the walk would otherwise report it as an unclosed
  // BEGIN, which points the author at the wrong marker.
  if (source.indexOf(RUNTIME_END) < source.indexOf(RUNTIME_BEGIN)) {
    throw new PersonaSourceError(`${where}a ${RUNTIME_END} appears before the first ${RUNTIME_BEGIN}.`);
  }

  const regions: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const begin = source.indexOf(RUNTIME_BEGIN, cursor);
    if (begin === -1) break;
    const end = source.indexOf(RUNTIME_END, begin + RUNTIME_BEGIN.length);
    if (end === -1) {
      throw new PersonaSourceError(`${where}a ${RUNTIME_BEGIN} is never closed.`);
    }
    const inner = source.slice(begin + RUNTIME_BEGIN.length, end);
    if (inner.includes(RUNTIME_BEGIN)) {
      throw new PersonaSourceError(`${where}nested ${RUNTIME_BEGIN} markers are not supported.`);
    }
    const body = inner.trim();
    if (body.length === 0) {
      throw new PersonaSourceError(`${where}an empty runtime region — remove the markers or fill them.`);
    }
    regions.push(body);
    cursor = end + RUNTIME_END.length;
  }

  const runtime = regions.join("\n\n");
  return {
    runtime,
    regionCount: regions.length,
    runtimeChars: runtime.length,
    sourceChars: source.length,
  };
}

/**
 * Report authoring prose or bracket slots that leaked into a runtime region.
 * Returns human-readable findings; empty means clean.
 */
export function findRuntimeLeaks(runtime: string): string[] {
  const findings: string[] = [];
  for (const marker of AUTHORING_MARKERS) {
    if (runtime.includes(marker)) {
      findings.push(`authoring prose inside a runtime region: ${JSON.stringify(marker)}`);
    }
  }
  const slots = runtime.match(BRACKET_SLOT_PATTERN);
  if (slots) {
    for (const slot of new Set(slots)) {
      findings.push(`bracket placeholder slot the merge layer cannot resolve: ${slot}`);
    }
  }
  return findings;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
