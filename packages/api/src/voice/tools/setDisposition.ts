import z from "zod";
import { tool } from "ai";
import { db } from "../../database";
import { scheduledCalls } from "../../database/schema";

/**
 * A4 (phase-a-integrity.md) — the call-scoped context that lets
 * `setDisposition` actually keep a `callback-requested` promise instead of
 * just recording that one was made.
 *
 * Bound per call the same way `CrmSyncContext`/`HeardVerifier` are: closed
 * over real, carrier-reported/session-resolved facts the model has no
 * business authoring itself. `getCallbackTimeHeard` is a function, not a
 * snapshotted value, for the same reason `OutboundTextContext.allowedNumbers`
 * is — `captureField`'s `callback_time` may land before or after
 * `setDisposition` fires within the same turn depending on how the model
 * sequences its tool calls, and a snapshot taken at tool-construction time
 * (before the turn even starts) would always read as absent.
 */
export type DispositionSchedulingContext = {
  /** Who to call back — the caller's own number, never the model's to name. */
  toNumber: string;
  orgId: string | undefined;
  /** Identifies which agent picks the callback back up — see scheduler.ts's
   * `dispatchScheduledCall`, which keys `isAgentDispatchable` off exactly
   * this field (falling back to `workflowName` when absent). */
  persona: string | undefined;
  webhookUrl: string | null | undefined;
  getCallbackTimeHeard: () => string | undefined;
};

/**
 * A production call promised a callback ("issue resolved; callback booked")
 * and never created anything a scheduler could act on — `scheduled_calls` had
 * zero rows. This is the fix: a `callback-requested` disposition attempts the
 * insert in the SAME tool call, in the SAME turn, so the model's own closing
 * remarks (spoken immediately after, in that same turn) are grounded in
 * whether the booking actually happened rather than in what it intended to
 * happen.
 *
 * No natural-language time parsing here deliberately — `callback_time` (when
 * `captureField` recorded one) is carried through as-is into the row's
 * `metadata` for a human/dashboard to read, not parsed into an exact
 * `runAt`. Parsing "tomorrow afternoon" or Hindi/Hinglish "kal" into a
 * correct timezone-aware instant is a real feature with real failure modes
 * (see agent.ts's `indianFormatLine` on "kal"'s inherent ambiguity even to a
 * human listener) — building it un-asked, on top of an integrity fix, is
 * exactly the kind of scope creep this phase's own README refuses elsewhere.
 * `runAt` instead defaults to a fixed near-term delay; `scheduler.ts`'s
 * calling-window gate still applies to whenever it actually dispatches.
 */
const DEFAULT_CALLBACK_DELAY_MS = 60 * 60 * 1000; // 1 hour

export function createSetDispositionTool(ctx?: DispositionSchedulingContext) {
  return tool({
    description:
      "Record the outcome/disposition of this call once it's clear how it ended. Call this near the end " +
      "of the conversation, right before wrapping up. If you record \"callback-requested\", check the " +
      "result: callbackScheduled true means it's actually booked and you may tell the caller so; false " +
      "means it could not be scheduled — say a human will follow up instead, and never claim it's booked.",
    inputSchema: z.object({
      disposition: z
        .enum(["interested", "not-interested", "callback-requested", "booked", "no-decision", "wrong-number"])
        .describe("The outcome of this call"),
      sentiment: z
        .enum(["positive", "neutral", "negative"])
        .optional()
        .describe("Overall tone of the caller during this call — how they seemed to feel, not the outcome itself"),
      notes: z.string().optional().describe("Brief context for why this disposition was chosen"),
    }),
    async execute({ disposition, sentiment, notes }) {
      const base = { recorded: true as const, disposition, sentiment: sentiment ?? null, notes: notes ?? null };
      if (disposition !== "callback-requested" || !ctx) return base;

      const requestedTime = ctx.getCallbackTimeHeard();
      try {
        await db.insert(scheduledCalls).values({
          toNumber: ctx.toNumber,
          // Distinct from a real workflow name (e.g. "shopify-cart-recovery")
          // on purpose — this row was not produced by the configurable
          // workflow-action system (workflows/engine.ts), it is the
          // unconditional guarantee that a promise made mid-call is kept
          // regardless of whether any workflow happens to be configured for
          // this number at all.
          workflowName: "callback-requested",
          persona: ctx.persona,
          webhookUrl: ctx.webhookUrl ?? undefined,
          attempt: 1,
          maxAttempts: 1,
          runAt: new Date(Date.now() + DEFAULT_CALLBACK_DELAY_MS),
          status: "pending",
          orgId: ctx.orgId,
          metadata: requestedTime ? { requestedCallbackTime: requestedTime } : undefined,
        });
        return { ...base, callbackScheduled: true as const };
      } catch (err) {
        console.error("[voice] failed to schedule promised callback", err);
        return {
          ...base,
          callbackScheduled: false as const,
          message:
            "The callback could not be scheduled just now. Do not tell the caller a callback was booked — " +
            "say a team member will follow up, and offer them a way to reach out themselves if they'd rather not wait.",
        };
      }
    },
  });
}

/**
 * The shared, unbound instance — text test-chat, the preview drawer, and the
 * synthetic harness get this one (see `HeardVerifier`/`CrmSyncContext` for
 * the same pattern elsewhere): no real number to call back, so
 * `callback-requested` records the disposition and attempts nothing.
 */
export const setDisposition = createSetDispositionTool();
