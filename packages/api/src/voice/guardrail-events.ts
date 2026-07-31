/**
 * Phase I (five-bets build plan, 2026-07-31) — pure derivation of a
 * guardrail_events row from a tool-call signal. Extracted from stream.ts's
 * logToolCall so the mapping (which tool name → which source, how category is
 * normalized to the schema enum, where the detail comes from) is unit-testable
 * without booting the live call state machine.
 *
 * Two signals feed this, both funneling through logToolCall:
 *  - `flagGuardrailEvent` — the agent's own self-report, input `{ category, detail }`.
 *  - `guardrail-heuristic-detector` — stream.ts's independent prompt-injection
 *    check, input `{ category, callerText }`.
 * Any other tool name returns null (not a guardrail moment).
 */

export const GUARDRAIL_CATEGORIES = [
  "topic-boundary",
  "unauthorized-promise",
  "prompt-injection",
  "abuse",
  "unknown",
] as const;

export type GuardrailCategory = (typeof GUARDRAIL_CATEGORIES)[number];
export type GuardrailSource = "agent-self-report" | "heuristic-detector";

export type GuardrailEventFields = {
  category: GuardrailCategory;
  source: GuardrailSource;
  detail: string | null;
};

function normalizeCategory(raw: unknown): GuardrailCategory {
  return typeof raw === "string" && (GUARDRAIL_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as GuardrailCategory)
    : "unknown";
}

/**
 * Returns the guardrail_events fields for a tool-call signal, or null if this
 * tool name is not a guardrail moment. `detail` prefers the self-report's
 * `detail` sentence, falling back to the heuristic detector's `callerText`,
 * and is trimmed to null when empty.
 */
export function deriveGuardrailEventFields(name: string, input: unknown): GuardrailEventFields | null {
  if (name !== "flagGuardrailEvent" && name !== "guardrail-heuristic-detector") return null;

  const source: GuardrailSource = name === "flagGuardrailEvent" ? "agent-self-report" : "heuristic-detector";
  const inputObj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const category = normalizeCategory(inputObj.category);

  const detailSource = typeof inputObj.detail === "string" ? inputObj.detail : inputObj.callerText;
  const detail = typeof detailSource === "string" && detailSource.trim() ? detailSource.trim() : null;

  return { category, source, detail };
}
