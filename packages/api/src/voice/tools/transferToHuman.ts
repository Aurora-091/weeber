import z from "zod";
import { tool } from "ai";

/**
 * Lets the agent hand a live call off to a real person — the user's own
 * number (see `orgs.humanTransferNumber` / `HUMAN_TRANSFER_NUMBER` env var).
 *
 * Signals intent only, same pattern as every other tool here. The actual
 * transfer (redirecting the live Twilio call out of the media stream into a
 * real `<Dial>` to the human number) happens in stream.ts's
 * `pendingTransfer` handling, right after the agent finishes saying its
 * handoff line — never silently, the caller should always hear "let me get
 * you a person" (or similar) before the line actually moves.
 */
export const transferToHuman = tool({
  description:
    "Transfer this call to a real person at the business. Call this only after you've told the caller " +
    "you're transferring them (in the same turn) — never transfer silently. Use it when: the caller " +
    "explicitly asks for a human, the request is something you genuinely can't help with (outside your " +
    "tools/knowledge), or the caller is frustrated and a human would serve them better. Don't overuse " +
    "this — try to actually help first.",
  inputSchema: z.object({
    reason: z
      .string()
      .describe("Short reason for the transfer, e.g. \"caller asked for a person\", \"request outside my scope\""),
  }),
  async execute({ reason }) {
    return { transferRequested: true, reason };
  },
});
