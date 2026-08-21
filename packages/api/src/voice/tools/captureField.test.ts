import { describe, it, expect } from "bun:test";
import { captureField } from "./captureField";

describe("captureField tool", () => {
  it("echoes back the captured field/value with a captured flag", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await captureField.execute({ field: "email", value: "a@b.com", heard: "my email is a@b.com" });
    expect(result).toEqual({ captured: true, field: "email", value: "a@b.com" });
  });

  it("requires a `heard` quote (ADR-120): the schema rejects an omitted or empty one", () => {
    // The argument only works as a control if the model cannot omit it, and an
    // empty string is an omission with extra steps. Enforced by the schema so a
    // malformed call fails before `execute` ever runs — there is no code path
    // where a capture arrives with no provenance claim at all.
    const schema = captureField.inputSchema as unknown as {
      safeParse: (input: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ field: "email", value: "a@b.com" }).success).toBe(false);
    expect(schema.safeParse({ field: "email", value: "a@b.com", heard: "" }).success).toBe(false);
    expect(schema.safeParse({ field: "email", value: "a@b.com", heard: "my email is a@b.com" }).success).toBe(true);
  });

  it("tells the model, in the tool description, that an inferred or assumed value is refused", () => {
    // Prompt and schema must say the same thing: the description is what the
    // model reads before deciding to call, the schema is what enforces it.
    expect(captureField.description).toContain("quote the caller's own words");
    expect(captureField.description).toContain("never answered");
  });

  it("captures unverified when no call-scoped verifier is injected (text chat, preview drawer, synthetic runs)", async () => {
    // Those surfaces have no caller audio to check against. A check that always
    // refused there would make every non-telephony surface silently
    // uncapturable, which is worse than no check.
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await captureField.execute({ field: "email", value: "a@b.com", heard: "not in any transcript" });
    expect(result).toEqual({ captured: true, field: "email", value: "a@b.com" });
  });

  it("has a description that instructs immediate capture, not end-of-call batching", () => {
    expect(captureField.description).toContain("immediately");
  });
});
