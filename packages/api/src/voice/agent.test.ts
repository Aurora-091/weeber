import { describe, it, expect } from "bun:test";
import { buildKnownFactsBlock } from "./agent";

describe("buildKnownFactsBlock", () => {
  it("returns an empty string when there is no captured state", () => {
    expect(buildKnownFactsBlock(undefined)).toBe("");
    expect(buildKnownFactsBlock({})).toBe("");
  });

  it("renders a single captured fact as a labeled block", () => {
    const block = buildKnownFactsBlock({ email: "a@b.com" });
    expect(block).toContain("Known facts about this call");
    expect(block).toContain("do not ask for these again");
    expect(block).toContain("- email: a@b.com");
  });

  it("renders multiple captured facts, one per line", () => {
    const block = buildKnownFactsBlock({
      email: "a@b.com",
      order_id: "ORD-123",
      caller_name: "Jamie",
    });
    expect(block).toContain("- email: a@b.com");
    expect(block).toContain("- order_id: ORD-123");
    expect(block).toContain("- caller_name: Jamie");
  });

  it("does not mutate its input", () => {
    const state = { email: "a@b.com" };
    buildKnownFactsBlock(state);
    expect(state).toEqual({ email: "a@b.com" });
  });
});
