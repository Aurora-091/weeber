import { describe, it, expect } from "bun:test";
import { setIntent } from "./setIntent";

describe("setIntent tool", () => {
  it("echoes back the recorded intent and optional notes", async () => {
    const execute = setIntent.execute!;
    const result = await execute({ intent: "escalation_request", notes: "wants a licensed advisor" }, {} as never);
    expect(result).toEqual({ recorded: true, intent: "escalation_request", notes: "wants a licensed advisor" });
  });

  it("defaults notes to null when omitted", async () => {
    const execute = setIntent.execute!;
    const result = await execute({ intent: "other" }, {} as never);
    expect(result).toEqual({ recorded: true, intent: "other", notes: null });
  });

  it("accepts every taxonomy value without throwing", async () => {
    const execute = setIntent.execute!;
    const values = [
      "purchase_or_booking",
      "order_or_policy_inquiry",
      "complaint_or_dissatisfaction",
      "cancellation_or_opt_out",
      "escalation_request",
      "pricing_or_discount",
      "wrong_person_or_spam",
      "other",
    ] as const;
    for (const intent of values) {
      const result = await execute({ intent }, {} as never);
      expect((result as { intent: string }).intent).toBe(intent);
    }
  });
});
