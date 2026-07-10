import z from "zod";
import { tool } from "ai";

/**
 * Lets the agent end the call on its own — the conversation is genuinely
 * over (goal met, caller said goodbye, caller asked to end the call) and
 * there's nothing left to wait for.
 *
 * This tool only *signals intent* — same pattern as every other tool here.
 * The actual hangup (waiting for the closing line to finish playing, then
 * terminating the Twilio call leg) happens in stream.ts, which is the only
 * place with access to the live call/TTS state. See stream.ts's
 * `pendingHangUp` handling.
 */
export const hangUp = tool({
  description:
    "End the call. Call this only after you've said your closing line (goodbye, wrap-up) in the same " +
    "turn — never call this instead of saying goodbye, always alongside it. Use it when: the caller's " +
    "need is fully resolved and they've confirmed they don't need anything else, the caller explicitly " +
    "asks to end the call or says goodbye, or the caller is unresponsive/the conversation has nowhere " +
    "left to go. Do not call this while the caller is still mid-request.",
  inputSchema: z.object({
    reason: z
      .string()
      .describe("Short reason this call is ending, e.g. \"caller said goodbye\", \"issue resolved\", \"caller unresponsive\""),
  }),
  async execute({ reason }) {
    return { hangUpRequested: true, reason };
  },
});
