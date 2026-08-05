import { describe, it, expect } from "bun:test";
import { toolCallReason } from "./call-control";

/**
 * Defect: "the call is not ending."
 *
 * `logToolCall` used to register a hangUp only when the tool input object
 * literally contained a `reason` key (`"reason" in input`). `reason` is required
 * on the schema, but a model that emitted `{}` — or a provider/SDK that handed
 * back arguments that never parsed into an object — produced a hangUp intent
 * that was silently discarded: the caller heard the goodbye line and then stayed
 * on a live call. The reason is diagnostic metadata; it must not be the thing
 * that decides whether a call ends.
 */
describe("toolCallReason", () => {
  it("uses the model's reason when it sent one", () => {
    expect(toolCallReason({ reason: "caller said goodbye" }, "fallback")).toBe("caller said goodbye");
  });

  it("falls back rather than discarding an argument-less tool call", () => {
    expect(toolCallReason({}, "hangUp called without a reason")).toBe("hangUp called without a reason");
    expect(toolCallReason(undefined, "fallback")).toBe("fallback");
    expect(toolCallReason(null, "fallback")).toBe("fallback");
    // Arguments that never parsed into an object at all.
    expect(toolCallReason("caller said goodbye", "fallback")).toBe("fallback");
  });

  it("falls back on a present-but-useless reason", () => {
    expect(toolCallReason({ reason: "" }, "fallback")).toBe("fallback");
    expect(toolCallReason({ reason: "   " }, "fallback")).toBe("fallback");
    expect(toolCallReason({ reason: null }, "fallback")).toBe("fallback");
    expect(toolCallReason({ reason: { nested: true } }, "fallback")).toBe("fallback");
  });

  it("stringifies a non-string scalar instead of losing it", () => {
    expect(toolCallReason({ reason: 42 }, "fallback")).toBe("42");
    expect(toolCallReason({ reason: false }, "fallback")).toBe("false");
  });
});
