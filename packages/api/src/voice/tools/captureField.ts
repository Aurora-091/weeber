import z from "zod";
import { tool } from "ai";

/**
 * The state-correctness tool. Every other tool in this directory performs an
 * *action* (book, look up, sync, disqualify) — this one performs a *write to
 * ground truth*. Call it whenever the caller states a durable fact worth
 * remembering for the rest of the call (and worth showing on the dashboard
 * afterward): email, order ID, full name, account number, preferred callback
 * time, etc.
 *
 * Why this exists: LLMs answering purely from a growing transcript will,
 * often silently, ask for the same information twice once it scrolls outside
 * whatever the model actually attends to — worse the longer the call runs.
 * Free-text transcripts and prompt-based "memory" are not a reliable state
 * store. This tool makes each captured fact a structured, deterministic
 * key/value entry in `CallState` (see stream.ts), which is:
 *   1. re-injected into the system prompt every turn as a "Known facts" block
 *      (see agent.ts buildKnownFactsBlock) — so the model reads state instead
 *      of re-deriving it from history,
 *   2. persisted to the `calls.capturedState` column so it survives process
 *      restarts and is inspectable on the dashboard,
 *   3. available to compliance/audit logic and other tools (crmSync, workflows)
 *      as a single source of truth instead of re-parsing transcripts.
 *
 * The actual state merge happens in stream.ts's onToolCall handler, same
 * pattern as every other tool here — this tool's job is just to let the
 * model express "I now know X" in a structured way instead of a sentence.
 */
export const captureField = tool({
  description:
    "Record a durable fact the caller has just told you (their email, order ID, full name, account " +
    "number, preferred callback time, or similar) so you never have to ask for it again this call. " +
    "Call this immediately after the caller states such a fact — do not wait until the end of the call. " +
    "Do not call this for small talk or facts that don't matter beyond the current sentence.",
  inputSchema: z.object({
    field: z
      .string()
      .describe(
        "Short snake_case key for this fact, e.g. \"email\", \"order_id\", \"caller_name\", \"callback_time\"",
      ),
    value: z.string().describe("The value as the caller stated it (normalize obvious formatting, e.g. lowercase emails)"),
  }),
  async execute({ field, value }) {
    return { captured: true, field, value };
  },
});
