/**
 * Rendering a call's captured facts (ADR-120).
 *
 * `calls.captured_state` holds `{ value, heard, transcriptId, turn }` per field
 * since ADR-120 — the `heard` quote is the caller utterance the value was taken
 * from, which is what makes a fabricated capture detectable after the fact.
 *
 * The API hands these rows to the UI as `Record<string, unknown>`, and rows
 * written before the migration still hold a bare string, so read defensively
 * here rather than at every call site: a call detail page that renders
 * "[object Object]" where the caller's email should be is worse than useless to
 * the operator reading it.
 */
export function capturedValue(entry: unknown): string {
  if (entry && typeof entry === "object" && "value" in entry) {
    const value = (entry as { value: unknown }).value;
    return value == null ? "" : String(value);
  }
  return entry == null ? "" : String(entry);
}

/**
 * True when this entry is `markFieldUnanswered`'s explicit "asked, no
 * answer" state (phase-a-integrity.md A2) — a `{ value: null, heard, ... }`
 * object, never a bare pre-migration string (those are never null; see
 * `capturedValue`'s own tolerance for that shape). Distinct from a field
 * that's simply absent from `capturedState` altogether, which this function
 * is never called for — there's no entry to check.
 */
export function isUnanswered(entry: unknown): boolean {
  return Boolean(entry && typeof entry === "object" && "value" in entry && (entry as { value: unknown }).value === null);
}
