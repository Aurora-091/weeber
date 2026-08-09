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
  // 2026-08-09: the agent tried to capture a field it is never permitted to
  // hold (SSN, bank routing, an itemized condition). Distinct from
  // topic-boundary — that is the agent correctly declining to discuss
  // something, this is the agent attempting the write and being refused, which
  // means the prompt regressed or the model was talked past it.
  "regulated-capture",
  "unknown",
] as const;

export type GuardrailCategory = (typeof GUARDRAIL_CATEGORIES)[number];
/** `capture-guard` is code refusing a write, not the agent reporting itself and
 * not a text heuristic — it is the only source here that blocked something. */
export type GuardrailSource = "agent-self-report" | "heuristic-detector" | "capture-guard";

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
