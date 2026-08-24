import { describe, it, expect } from "bun:test";
import { markFieldUnanswered, createMarkFieldUnansweredTool } from "./markFieldUnanswered";
import { heardInCallerSpeech, tokenizeSpeech } from "../capture-provenance";

describe("markFieldUnanswered tool", () => {
  it("records the field as unanswered with a recorded flag", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await markFieldUnanswered.execute({ field: "tobacco", heard: "just do some kind of drinks" });
    expect(result).toEqual({ recorded: true, field: "tobacco" });
  });

  it("requires a `heard` quote, same contract as captureField", () => {
    const schema = markFieldUnanswered.inputSchema as unknown as {
      safeParse: (input: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ field: "tobacco" }).success).toBe(false);
    expect(schema.safeParse({ field: "tobacco", heard: "" }).success).toBe(false);
    expect(schema.safeParse({ field: "tobacco", heard: "just do some kind of drinks" }).success).toBe(true);
  });

  it("records unverified when no call-scoped verifier is injected (text chat, preview drawer, synthetic runs)", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await markFieldUnanswered.execute({ field: "tobacco", heard: "not in any transcript" });
    expect(result).toEqual({ recorded: true, field: "tobacco" });
  });

  it("tells the model in its description not to use this in place of a real answer", () => {
    expect(markFieldUnanswered.description).toContain("Never call this instead of captureField");
  });

  describe("with a call-scoped provenance verifier", () => {
    const callerSpeech = tokenizeSpeech(
      "Hi yes I'm here. I'd like to know about the coverage first. " +
        "Ah, just do some kind of drinks. What would the premium be?",
    );
    const tool = createMarkFieldUnansweredTool((heard) => heardInCallerSpeech(heard, callerSpeech));
    const options = { toolCallId: "t1", messages: [] };

    it("refuses a `heard` quote the caller never actually said", async () => {
      const result = (await tool.execute!(
        { field: "tobacco", heard: "no, never" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options as any,
      )) as { recorded: boolean; reason?: string };

      expect(result.recorded).toBe(false);
      expect(result.reason).toBe("not-heard");
    });

    it("records an evasion the caller genuinely said", async () => {
      const result = (await tool.execute!(
        { field: "tobacco", heard: "just do some kind of drinks" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options as any,
      )) as { recorded: boolean; field?: string };

      expect(result.recorded).toBe(true);
      expect(result.field).toBe("tobacco");
    });

    it("screens a prohibited key before the provenance check", async () => {
      const result = (await tool.execute!(
        { field: "ssn", heard: "just do some kind of drinks" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options as any,
      )) as { recorded: boolean; refused?: string; reason?: string };

      expect(result.recorded).toBe(false);
      expect(result.refused).toContain("not permitted");
      expect(result.reason).toBeUndefined();
    });
  });
});
