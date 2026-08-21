import z from "zod";
import { tool } from "ai";
import { screenCapture } from "../prohibited-capture";

/**
 * The state-correctness tool. Every other tool in this directory performs an
 * *action* (book, look up, sync, disqualify) — this one performs a *write to
 * ground truth*. Call it whenever the caller states a durable fact worth
 * remembering for the rest of the call (and worth showing on the dashboard
 * afterward): email, order ID, full name, preferred callback
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
/**
 * ADR-120: the call-scoped provenance check, injected by `stream.ts` (via
 * `buildVoiceTools`) because only the live call knows what the caller has said.
 * Returns true when `heard` appears in this call's caller-role transcript.
 *
 * Optional. Without it the tool behaves as it always did — prohibited-key
 * screening only — which is what the static `voiceTools.captureField` instance,
 * the text test-chat and the preview drawer get. Those have no caller audio to
 * verify against, and a check that always refuses there would be worse than no
 * check: it would make every non-telephony surface silently uncapturable.
 */
export type HeardVerifier = (heard: string) => boolean;

/**
 * Built per call rather than shared (same reason as `createBookAppointmentTool`
 * and `createCrmSyncTool`): the verifier closes over one call's caller speech.
 *
 * Screened and verified in two places on purpose — see the comment in
 * `execute` below and the mirror in `stream.ts`'s `logToolCall`.
 */
export function createCaptureFieldTool(isHeardInCall?: HeardVerifier) {
  return tool({
  description:
    "Record a durable fact the caller has just told you (their email, order ID, full name, " +
    "preferred callback time, or similar) so you never have to ask for it again this call. " +
    "Never use this for a government ID, bank or card number, date of birth, or a specific medical " +
    "condition — those are refused and a licensed human collects them. " +
    "Call this immediately after the caller states such a fact — do not wait until the end of the call. " +
    "Do not call this for small talk or facts that don't matter beyond the current sentence. " +
    "You must quote the caller's own words in `heard`. Only record what the caller actually said: if you " +
    "asked and they changed the subject, declined, or never answered, do not record a value and do not " +
    "assume one — a fact you inferred, guessed or decided \"for the record\" is refused and not saved.",
  inputSchema: z.object({
    field: z
      .string()
      .describe(
        "Short snake_case key for this fact, e.g. \"email\", \"order_id\", \"caller_name\", \"callback_time\"",
      ),
    value: z.string().describe("The value as the caller stated it (normalize obvious formatting, e.g. lowercase emails)"),
    // ADR-120. Required, min(1): the argument only works as a control if the
    // model cannot omit it, and an empty string is an omission with extra
    // steps. It is checked against this call's caller-role transcript in
    // stream.ts before anything persists — this description exists so the
    // model knows what will be checked, not as the check itself.
    heard: z
      .string()
      .min(1)
      .describe(
        "The caller's own words this value came from — quote them verbatim from what the caller said. " +
          "Do not paraphrase, do not summarize, and never put your own words or an inference here. " +
          "If the caller never said it, you have nothing to put here and must not call this tool.",
      ),
  }),
  async execute({ field, value, heard }) {
    // Screened in two places on purpose. This one exists so the MODEL is told
    // "no" in the tool result and stops re-asking the caller under a different
    // key name; the copy in stream.ts's logToolCall is what actually keeps the
    // value out of `tool_calls.input`, `calls.capturedState` and the outbound
    // webhook. Neither is redundant: this one cannot stop a write, and that one
    // cannot talk to the model.
    const screen = screenCapture(field);
    if (!screen.allowed) return { captured: false, field, refused: screen.refusal };
    // ADR-120, and screened in two places for the same reason as the key above:
    // this one tells the MODEL its write was refused so it asks the caller
    // again instead of assuming, while the mirror in stream.ts's logToolCall is
    // what actually stops the value reaching `calls.capturedState`, the CRM
    // payload and the outbound webhook. Both call the same pure matcher over
    // the same in-memory caller speech, so they cannot disagree.
    //
    // The refusal names `reason: "not-heard"` rather than an apology: the model
    // has to be able to tell "you may not collect this at all" (refused, stop
    // asking) apart from "the caller has not said this yet" (ask, then record
    // what they answer).
    if (isHeardInCall && !isHeardInCall(heard)) {
      return { captured: false, field, reason: "not-heard" as const };
    }
    return { captured: true, field, value };
  },
  });
}

/**
 * The shared, unverified instance — see `HeardVerifier` above for why a
 * transcript-less surface gets no provenance check rather than a failing one.
 */
export const captureField = createCaptureFieldTool();
