import z from "zod";
import { tool } from "ai";

/**
 * Lets the agent press keys on someone else's phone tree mid-call — "press 1
 * for billing" navigation when this call is *to* another IVR (an insurer, a
 * courier), not the caller-facing side of our own calls. Misc-2.
 *
 * Signal-only, same pattern as every other tool here — the actual tone
 * audio is generated and played into the live media stream in stream.ts's
 * onToolCall handler (see dtmf.ts).
 */
export const sendDtmf = tool({
  description:
    "Press keys on the other side's phone menu during this call — e.g. \"press 1 for billing\", " +
    "\"enter your 10-digit account number then #\". Only digits, *, and # are valid. Use this when " +
    "you're calling into an automated phone tree and need to navigate it, not for anything the caller " +
    "says.",
  inputSchema: z.object({
    digits: z
      .string()
      .regex(/^[0-9*#]+$/, "Only digits, *, and # are valid DTMF tones")
      .describe("The sequence of keys to press, in order, e.g. \"1\" or \"41234567#\""),
  }),
  async execute({ digits }) {
    return { dtmfRequested: true, digits };
  },
});
