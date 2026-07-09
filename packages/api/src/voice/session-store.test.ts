import { describe, it, expect } from "bun:test";
import { sessionStore } from "./session-store";

describe("sessionStore", () => {
  it("stores and retrieves a session", async () => {
    await sessionStore.set("CA_test_1", { callSid: "CA_test_1", direction: "outbound" });
    const session = await sessionStore.get("CA_test_1");
    expect(session?.callSid).toBe("CA_test_1");
    expect(session?.direction).toBe("outbound");
    expect(typeof session?.createdAt).toBe("number");
  });

  it("returns undefined for an unknown callSid", async () => {
    expect(await sessionStore.get("CA_does_not_exist")).toBeUndefined();
  });

  it("updates an existing session by merging fields", async () => {
    await sessionStore.set("CA_test_2", { callSid: "CA_test_2", direction: "inbound", persona: "original" });
    await sessionStore.update("CA_test_2", { persona: "updated" });
    const session = await sessionStore.get("CA_test_2");
    expect(session?.persona).toBe("updated");
    expect(session?.direction).toBe("inbound"); // unrelated fields preserved
  });

  it("update() is a no-op for a callSid that was never set", async () => {
    await sessionStore.update("CA_never_set", { persona: "x" });
    expect(await sessionStore.get("CA_never_set")).toBeUndefined();
  });

  it("deletes a session", async () => {
    await sessionStore.set("CA_test_3", { callSid: "CA_test_3", direction: "outbound" });
    await sessionStore.delete("CA_test_3");
    expect(await sessionStore.get("CA_test_3")).toBeUndefined();
  });

  it("carries workflow retry metadata", async () => {
    await sessionStore.set("CA_test_4", {
      callSid: "CA_test_4",
      direction: "outbound",
      workflowName: "lead-followup",
      workflowAttempt: 2,
    });
    const session = await sessionStore.get("CA_test_4");
    expect(session?.workflowName).toBe("lead-followup");
    expect(session?.workflowAttempt).toBe(2);
  });
});
