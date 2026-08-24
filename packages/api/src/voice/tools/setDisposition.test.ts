import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * A4 (phase-a-integrity.md) — "a promised callback creates a scheduled_calls
 * row in the same transaction as the disposition, or the agent is not
 * permitted to promise one."
 *
 * Deviation from the plan text's suggested location
 * (workflows/scheduler-callback-invariant.test.ts): the insert now happens
 * inside `createSetDispositionTool`'s own `execute()`, in the same tool call
 * as the disposition, not through scheduler.ts — see the doc comment on
 * `DispositionSchedulingContext`. These tests live next to the code they
 * cover.
 */

let scheduledCallInserts: Record<string, unknown>[] = [];
let insertShouldThrow = false;

mock.module("../../database", () => ({
  db: {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        if (insertShouldThrow) throw new Error("db unavailable");
        scheduledCallInserts.push(values);
        return undefined;
      },
    }),
  },
}));

import { createSetDispositionTool, setDisposition } from "./setDisposition";

function ctx(overrides: Partial<Parameters<typeof createSetDispositionTool>[0]> = {}) {
  return {
    toNumber: "+15551234567",
    orgId: "org-a",
    persona: "insurance-final-expense-qualifier",
    webhookUrl: null,
    getCallbackTimeHeard: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  scheduledCallInserts = [];
  insertShouldThrow = false;
});

describe("setDisposition (unbound, shared instance)", () => {
  it("just records the disposition — unchanged from before A4 — when no scheduling context exists", async () => {
    const result = (await setDisposition.execute!(
      { disposition: "callback-requested", sentiment: "positive", notes: "wants a callback" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { toolCallId: "t1", messages: [] } as any,
    )) as { recorded: boolean; disposition: string; callbackScheduled?: boolean };

    expect(result.recorded).toBe(true);
    expect(result.disposition).toBe("callback-requested");
    expect(result.callbackScheduled).toBeUndefined();
    expect(scheduledCallInserts).toHaveLength(0);
  });

  it("records non-callback dispositions exactly as before", async () => {
    const result = (await setDisposition.execute!(
      { disposition: "not-interested" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { toolCallId: "t1", messages: [] } as any,
    )) as { recorded: boolean; disposition: string; sentiment: string | null; notes: string | null };
    expect(result).toEqual({ recorded: true, disposition: "not-interested", sentiment: null, notes: null });
  });
});

describe("createSetDispositionTool — bound to a call with a real number (A4)", () => {
  it("schedules exactly one pending scheduled_calls row on callback-requested", async () => {
    const tool = createSetDispositionTool(ctx());
    const result = (await tool.execute!(
      { disposition: "callback-requested" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { toolCallId: "t1", messages: [] } as any,
    )) as { callbackScheduled: boolean };

    expect(result.callbackScheduled).toBe(true);
    expect(scheduledCallInserts).toHaveLength(1);
    expect(scheduledCallInserts[0]).toMatchObject({
      toNumber: "+15551234567",
      orgId: "org-a",
      persona: "insurance-final-expense-qualifier",
      status: "pending",
      workflowName: "callback-requested",
    });
  });

  it("carries the captured callback_time (if any) into the row's metadata, without parsing it", async () => {
    const tool = createSetDispositionTool(ctx({ getCallbackTimeHeard: () => "tomorrow afternoon" }));
    await tool.execute!(
      { disposition: "callback-requested" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { toolCallId: "t1", messages: [] } as any,
    );
    expect(scheduledCallInserts[0].metadata).toEqual({ requestedCallbackTime: "tomorrow afternoon" });
  });

  it("omits metadata entirely when no callback_time was ever captured", async () => {
    const tool = createSetDispositionTool(ctx());
    await tool.execute!(
      { disposition: "callback-requested" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { toolCallId: "t1", messages: [] } as any,
    );
    expect(scheduledCallInserts[0].metadata).toBeUndefined();
  });

  it("A4: a failed insert reports callbackScheduled: false and tells the model not to claim a booking", async () => {
    insertShouldThrow = true;
    const tool = createSetDispositionTool(ctx());
    const result = (await tool.execute!(
      { disposition: "callback-requested" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { toolCallId: "t1", messages: [] } as any,
    )) as { callbackScheduled: boolean; message: string; recorded: boolean };

    expect(result.recorded).toBe(true); // the disposition itself is still recorded
    expect(result.callbackScheduled).toBe(false);
    expect(result.message).toContain("Do not tell the caller a callback was booked");
    expect(scheduledCallInserts).toHaveLength(0);
  });

  it("never touches scheduled_calls for a disposition other than callback-requested", async () => {
    const tool = createSetDispositionTool(ctx());
    for (const disposition of ["interested", "not-interested", "booked", "no-decision", "wrong-number"] as const) {
      await tool.execute!(
        { disposition },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { toolCallId: "t1", messages: [] } as any,
      );
    }
    expect(scheduledCallInserts).toHaveLength(0);
  });
});
