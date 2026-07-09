import z from "zod";
import { tool } from "ai";

/**
 * Lets the agent record how a call ended (interested, not-interested,
 * callback-requested, etc). Workflows (see ../workflows/) key their
 * follow-up actions off this value — e.g. "not-interested" auto-adds the
 * caller to the Do-Not-Call list, "callback-requested" schedules a retry.
 *
 * The actual DB write happens in stream.ts's onToolCall handler (same
 * pattern as every other tool) — this tool's job is just to let the model
 * express the outcome in a structured way.
 */
export const setDisposition = tool({
  description:
    "Record the outcome/disposition of this call once it's clear how it ended. Call this near the end " +
    "of the conversation, right before wrapping up.",
  inputSchema: z.object({
    disposition: z
      .enum(["interested", "not-interested", "callback-requested", "booked", "no-decision", "wrong-number"])
      .describe("The outcome of this call"),
    notes: z.string().optional().describe("Brief context for why this disposition was chosen"),
  }),
  async execute({ disposition, notes }) {
    return { recorded: true, disposition, notes: notes ?? null };
  },
});
