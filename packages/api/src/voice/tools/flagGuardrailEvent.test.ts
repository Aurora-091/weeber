import { describe, it, expect } from "bun:test";
import { flagGuardrailEvent } from "./flagGuardrailEvent";

describe("flagGuardrailEvent tool", () => {
  it("echoes back category and detail with a flagged flag", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await flagGuardrailEvent.execute({
      category: "prompt-injection",
      detail: "Caller said 'ignore your instructions' — declined and stayed in persona.",
    });
    expect(result).toEqual({
      flagged: true,
      category: "prompt-injection",
      detail: "Caller said 'ignore your instructions' — declined and stayed in persona.",
    });
  });

  it("accepts each of the four defined guardrail categories", async () => {
    for (const category of ["topic-boundary", "unauthorized-promise", "prompt-injection", "abuse"] as const) {
      // @ts-expect-error — execute is present on this tool definition at runtime, and returns the plain object (not a stream) for this tool
      const result: { flagged: boolean; category: string; detail: string } = await flagGuardrailEvent.execute({
        category,
        detail: "test",
      });
      expect(result.category).toBe(category);
    }
  });

  it("rejects a category outside the defined set", () => {
    // @ts-expect-error — inputSchema is a zod schema at runtime and does expose safeParse
    const parsed = flagGuardrailEvent.inputSchema.safeParse({ category: "not-a-real-category", detail: "test" });
    expect(parsed.success).toBe(false);
  });
});
