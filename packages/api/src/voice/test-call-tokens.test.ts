import { describe, it, expect, spyOn } from "bun:test";
import { issueTestCallToken, consumeTestCallToken } from "./test-call-tokens";

describe("test-call-tokens", () => {
  it("issues a token that consumes to the exact payload it was issued with", () => {
    const token = issueTestCallToken({ orgId: "org_1", templateKey: "shopify-support", actor: "org_1" });
    const payload = consumeTestCallToken(token);
    expect(payload).toEqual({ orgId: "org_1", templateKey: "shopify-support", actor: "org_1" });
  });

  it("carries an optional configOverride through issue/consume", () => {
    const override = { name: "Test Agent", greetingLine: "hi" } as unknown as import("./agent-frame").AgentFrame;
    const token = issueTestCallToken({ orgId: "org_2", templateKey: "clinic-booking", configOverride: override, actor: "admin:org_2" });
    const payload = consumeTestCallToken(token);
    expect(payload?.configOverride).toEqual(override);
    expect(payload?.actor).toBe("admin:org_2");
  });

  it("is single-use — a second consume of the same token returns null", () => {
    const token = issueTestCallToken({ orgId: "org_3", templateKey: "hotel-reception", actor: "org_3" });
    expect(consumeTestCallToken(token)).not.toBeNull();
    expect(consumeTestCallToken(token)).toBeNull();
  });

  it("returns null for a token that was never issued", () => {
    expect(consumeTestCallToken("not-a-real-token")).toBeNull();
  });

  it("issues unique tokens across issuances", () => {
    const token = issueTestCallToken({ orgId: "org_4", templateKey: "shopify-support", actor: "org_4" });
    const token2 = issueTestCallToken({ orgId: "org_4", templateKey: "shopify-support", actor: "org_4" });
    expect(token).not.toBe(token2);
    expect(consumeTestCallToken(token)).not.toBeNull();
    expect(consumeTestCallToken(token2)).not.toBeNull();
  });

  it("expires after its documented 2-minute TTL", () => {
    const realNow = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(realNow);
    try {
      const token = issueTestCallToken({ orgId: "org_5", templateKey: "shopify-support", actor: "org_5" });
      nowSpy.mockReturnValue(realNow + 2 * 60_000 + 1); // just past TOKEN_TTL_MS
      expect(consumeTestCallToken(token)).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
